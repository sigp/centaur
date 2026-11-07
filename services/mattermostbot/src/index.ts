import { randomUUID } from "node:crypto";
import {
  harnessToChatSdkStream,
  type CodexAppServerToChatStreamOptions,
} from "@centaur/rendering";
import { createPostgresState } from "@chat-adapter/state-pg";
import {
  Chat,
  type Adapter,
  type Logger,
  type Message as ChatMessage,
  type StateAdapter,
  type Thread,
} from "chat";
import {
  createMattermostAdapter,
  type MattermostAdapter,
} from "chat-adapter-mattermost";
import { Hono } from "hono";
import pg from "pg";
import {
  fetchMattermostChannel,
  isAllowedMattermostMessage,
  isMattermostAllowlistEmpty,
  resolveMattermostConversationName,
} from "./mattermost-allowlist";
import { resolveChannelDefault } from "./channel-defaults";
import {
  extractMessageOverrides,
  extractPersonaOverride,
  isHarnessEnabled,
  type HarnessOverrides,
} from "./overrides";
import {
  createFlagMessageOverridesStrategy,
} from "./message-overrides-strategy";
import { isMattermostStopCommand } from "./stop-command";
import {
  defaultModelForHarness,
  effectiveReasoningForHarness,
  reasoningForModel,
} from "./response-context";
import {
  collectInitialContext,
  executeSessionTurn,
  forwardToSessionApi,
  interruptSessionExecution,
  isContentlessApiMessage,
  isRetryableSessionApiError,
  openSessionEventStream,
  serializeMessage,
  sessionStreamError,
  startingStreamNotification,
} from "./session-api";
import type {
  ForwardSessionInput,
  Mattermostbot,
  MattermostbotApiMessage,
  MattermostbotExecuteSessionResponse,
  MattermostbotMessageMode,
  MattermostbotOptions,
  MattermostbotRenderObligation,
  MattermostbotRendererSource,
  MattermostbotThreadState,
  MattermostbotTrace,
  MattermostAdapterWithHealth,
} from "./types";
import {
  AsyncTextQueue,
  errorMessage,
  TeamExecutionLimiter,
  noopLogger,
  nowMs,
  takeMessageChunk,
  traceLog,
} from "./utils";

export type {
  ForwardSessionInput,
  Mattermostbot,
  MattermostbotApiAttachment,
  MattermostbotApiAuthor,
  MattermostbotApiMessage,
  MattermostbotAppendMessagesRequest,
  MattermostbotCreateSessionRequest,
  MattermostbotExecuteSessionRequest,
  MattermostbotExecuteSessionResponse,
  MattermostbotFetch,
  MattermostbotOptions,
  MattermostbotSessionMessage,
  MattermostbotSessionMessageRole,
} from "./types";

export {
  clearMattermostChannelCacheForTests,
  encodeMattermostThreadKey,
  fetchMattermostChannel,
  isAllowedMattermostMessage,
  isMattermostAllowlistEmpty,
  isMattermostBotMessage,
  parseMattermostThreadKey,
  resolveMattermostConversationName,
  resolveMattermostTeamAllowlist,
  resolveMattermostTriggerBotAllowlist,
  splitMattermostEnvList,
} from "./mattermost-allowlist";

const DEFAULT_MAX_CONCURRENT_EXECUTIONS_PER_TEAM = 3;
const DEFAULT_ACTIVE_EXECUTION_TTL_MS = 30 * 60 * 1000;
const DEFAULT_ANSWER_EDIT_INTERVAL_MS = 500;
const DEFAULT_MAX_POST_CHARS = 16_000;
const TYPING_KEEPALIVE_MS = 8_000;
const RENDER_OBLIGATION_INDEX_KEY = "mattermostbot:render:index";
const RENDER_OBLIGATION_INDEX_MAX_LENGTH = 2_000;
const RENDER_INDEX_TTL_MS = 30 * 24 * 60 * 60 * 1_000;
const RENDER_RECOVERY_LEASE_TTL_MS = 2 * 60 * 1_000;
const RENDER_LEASE_REFRESH_INTERVAL_MS = 60 * 1_000;
const RENDER_RETRY_INITIAL_DELAY_MS = 250;
const RENDER_RETRY_MAX_DELAY_MS = 5_000;
const RENDER_RETRY_MAX_ATTEMPTS = 10;
const FORWARD_RETRY_DELAYS_MS = [1_000, 3_000] as const;
const DEFAULT_MESSAGE_OVERRIDES_STRATEGY = createFlagMessageOverridesStrategy();

export async function messageOverridesForText(
  options: MattermostbotOptions,
  text: string,
  trace?: MattermostbotTrace,
): Promise<{ cleanedText?: string; overrides: HarnessOverrides }> {
  const strategy =
    options.messageOverridesStrategy ?? DEFAULT_MESSAGE_OVERRIDES_STRATEGY;
  const persona = extractPersonaOverride(text);
  let result: { cleanedText?: string; overrides: HarnessOverrides };
  try {
    result = await strategy({ text: persona.cleanedText });
  } catch (error) {
    traceLog(options, "mattermostbot_message_overrides_strategy_failed", trace, {
      error: errorMessage(error),
    });
    result = await DEFAULT_MESSAGE_OVERRIDES_STRATEGY({
      text: persona.cleanedText,
    });
  }
  const { personaId: _strategyPersonaId, ...strategyOverrides } =
    result.overrides;
  return {
    ...result,
    ...(persona.personaId && result.cleanedText === undefined
      ? { cleanedText: persona.cleanedText }
      : {}),
    overrides: {
      ...strategyOverrides,
      ...(persona.personaId ? { personaId: persona.personaId } : {}),
    },
  };
}

type StickyThreadOverrides = Pick<
  MattermostbotThreadState,
  "harnessType" | "model" | "personaId" | "provider"
>;

function stickyThreadOverrideUpdate(
  overrides: HarnessOverrides,
): StickyThreadOverrides | undefined {
  const update: StickyThreadOverrides = {};
  if (overrides.harnessType) {
    update.harnessType = overrides.harnessType;
    if (!overrides.model) update.model = null;
    if (!overrides.provider) update.provider = null;
  }
  if (overrides.model) update.model = overrides.model;
  if (overrides.personaId) update.personaId = overrides.personaId;
  if (overrides.provider) {
    update.provider = overrides.provider;
    if (!overrides.model) update.model = null;
  }
  return Object.keys(update).length > 0 ? update : undefined;
}

function hasStickyModelOverride(
  overrides: Pick<MattermostbotThreadState, "harnessType" | "model" | "provider">,
): boolean {
  return Boolean(overrides.harnessType || overrides.model || overrides.provider);
}

function preservePinnedPersona(
  state: MattermostbotThreadState,
  update: StickyThreadOverrides | undefined,
): StickyThreadOverrides | undefined {
  if (
    !update?.personaId ||
    !Object.prototype.hasOwnProperty.call(state, "personaId")
  ) {
    return update;
  }
  return { ...update, personaId: state.personaId ?? null };
}

function personaOnlyStickyOverride(
  update: StickyThreadOverrides | undefined,
): StickyThreadOverrides | undefined {
  return update?.personaId ? { personaId: update.personaId } : undefined;
}

function stickyOverrideValue(
  state: MattermostbotThreadState,
  update: StickyThreadOverrides | undefined,
  key: keyof StickyThreadOverrides,
): string | undefined {
  if (update && Object.prototype.hasOwnProperty.call(update, key)) {
    const value = update[key];
    return typeof value === "string" ? value : undefined;
  }
  const value = state[key];
  return typeof value === "string" ? value : undefined;
}

function stickyOverrideRaw(
  state: MattermostbotThreadState,
  update: StickyThreadOverrides | undefined,
  key: keyof StickyThreadOverrides,
): string | null | undefined {
  return update && Object.prototype.hasOwnProperty.call(update, key)
    ? update[key]
    : state[key];
}

export function createMattermostbot(
  options: MattermostbotOptions,
): Mattermostbot {
  const logger = options.logger ?? noopLogger;
  const adapter = createMattermostHealthAdapter({
    baseUrl: options.baseUrl,
    botToken: options.botToken,
    logger,
    userName: options.userName ?? "centaur",
    websocket: options.websocket,
  });
  const state = options.state ?? createDefaultState(options, logger);
  const chat = new Chat<
    { mattermost: MattermostAdapter },
    MattermostbotThreadState
  >({
    userName: options.userName ?? "centaur",
    adapters: { mattermost: adapter },
    state,
    // Mattermost has no native streaming transport. Null prevents an empty
    // placeholder post; the first visible answer chunk creates the post.
    fallbackStreamingPlaceholderText: null,
    streamingUpdateIntervalMs:
      options.answerEditIntervalMs ?? DEFAULT_ANSWER_EDIT_INTERVAL_MS,
    concurrency: "drop",
    logger,
  });

  if (isMattermostAllowlistEmpty(options)) {
    logger.warn("mattermostbot_team_allowlist_empty_inert", {
      hint: "Set MATTERMOSTBOT_TEAM_ALLOWLIST; the bot ignores all messages until configured.",
    });
  }

  const executionLimiter = new TeamExecutionLimiter(
    options.maxConcurrentExecutionsPerTeam ??
      DEFAULT_MAX_CONCURRENT_EXECUTIONS_PER_TEAM,
  );

  chat.onNewMention(async (thread, message) => {
    if (!(await isAllowedMattermostMessage(message, options, logger))) return;
    if (await handleStopCommand(thread, message, options)) return;
    await thread.subscribe();
    await syncThreadMessageToSession(thread, message, {
      mode: "execute",
      executionLimiter,
      options,
      state,
    });
  });

  chat.onSubscribedMessage(async (thread, message) => {
    if (!(await isAllowedMattermostMessage(message, options, logger))) return;
    if (
      message.isMention === true &&
      (await handleStopCommand(thread, message, options))
    ) {
      return;
    }
    await syncThreadMessageToSession(thread, message, {
      mode: message.isMention === true ? "execute" : "append",
      executionLimiter,
      options,
      state,
    });
  });

  const app = new Hono();
  app.get("/health", (context) => {
    const connected = adapter.isWebSocketConnected();
    return context.json(
      { ok: connected, service: "mattermostbot", websocket: connected },
      connected ? 200 : 503,
    );
  });

  if (options.recoverRenderObligationsOnStart !== false) {
    scheduleRenderObligationRecovery(chat, state, options);
  }

  return { app, chat, adapter };
}

function createMattermostHealthAdapter(config: {
  baseUrl: string;
  botToken: string;
  logger: Logger;
  userName: string;
  websocket?: MattermostbotOptions["websocket"];
}): MattermostAdapterWithHealth {
  const adapter = createMattermostAdapter(config) as MattermostAdapterWithHealth;
  // The upstream adapter deliberately keeps its WebSocket private and does not
  // expose a lifecycle callback. This read-only probe is the health contract;
  // no adapter behavior is changed.
  Object.defineProperty(adapter, "isWebSocketConnected", {
    configurable: false,
    enumerable: false,
    value: () => {
      const socket = (
        adapter as unknown as { websocket?: { readyState?: number } }
      ).websocket;
      return socket?.readyState === 1;
    },
  });
  return adapter;
}

function createDefaultState(
  options: MattermostbotOptions,
  logger: Logger,
): StateAdapter {
  const stateLogger = logger.child("postgres-state");
  const pool = new pg.Pool({ connectionString: options.postgresUrl });
  pool.on("error", (error) => {
    stateLogger.warn("postgres pool error", { error: errorMessage(error) });
  });
  return createPostgresState({
    client: pool,
    keyPrefix: options.stateKeyPrefix ?? "centaur-mattermostbot",
    logger: stateLogger,
  });
}

async function handleStopCommand(
  thread: Thread<MattermostbotThreadState>,
  message: ChatMessage,
  options: MattermostbotOptions,
): Promise<boolean> {
  if (!isMattermostStopCommand(message)) return false;
  const trace: MattermostbotTrace = {
    includeContext: false,
    messageId: message.id,
    mode: "append",
    openStream: false,
    startedAtMs: nowMs(),
    threadId: thread.id,
  };
  const latest = (await thread.state) ?? {};
  await thread.setState({
    proactiveEligible: false,
    stopRequestedAt: message.metadata.dateSent.getTime(),
  });
  try {
    const response = await interruptSessionExecution(
      options,
      thread.id,
      `Interrupted from Mattermost by ${message.author.userId}`,
    );
    if (response.interrupted) {
      await thread.setState({
        activeExecution: false,
        activeExecutionStartedAt: null,
        lastEventId:
          latest.lastEventId ?? latest.renderObligation?.afterEventId ?? 0,
        renderObligation: null,
      });
    }
    traceLog(options, "mattermostbot_stop_command_complete", trace, {
      execution_id: response.execution_id,
      interrupted: response.interrupted,
    });
  } catch (error) {
    traceLog(options, "mattermostbot_stop_command_failed", trace, {
      error: errorMessage(error),
    });
    await thread
      .post("Couldn't confirm the stop. The agent may still be working.")
      .catch(() => undefined);
  }
  return true;
}

function stopRequestedFor(
  state: MattermostbotThreadState,
  message: ChatMessage,
): boolean {
  return (state.stopRequestedAt ?? 0) >= message.metadata.dateSent.getTime();
}

async function syncThreadMessageToSession(
  thread: Thread<MattermostbotThreadState>,
  message: ChatMessage,
  input: {
    executionLimiter: TeamExecutionLimiter;
    mode: MattermostbotMessageMode;
    options: MattermostbotOptions;
    state: StateAdapter;
  },
): Promise<void> {
  const traceStartedAtMs = nowMs();
  const options = input.options;
  const logger = options.logger ?? noopLogger;
  const state = (await thread.state) ?? {};
  const forwardedIds = new Set(state.forwardedMessageIds ?? []);
  const executedIds = new Set(state.executedMessageIds ?? []);
  let shouldStartExecution =
    input.mode === "execute" &&
    !hasLiveActiveExecution(
      state,
      options.activeExecutionTtlMs ?? DEFAULT_ACTIVE_EXECUTION_TTL_MS,
    ) &&
    !executedIds.has(message.id);

  let releaseExecutionSlot: (() => void) | null = null;
  const parsedChannel = await fetchMattermostChannel(
    options,
    threadChannelId(thread.id),
  ).catch(() => undefined);
  const teamId = parsedChannel?.team_id;
  if (shouldStartExecution && teamId) {
    releaseExecutionSlot = input.executionLimiter.acquire(teamId);
    if (!releaseExecutionSlot) {
      shouldStartExecution = false;
      logger.warn("mattermostbot_team_execution_capped", {
        message_id: message.id,
        team_id: teamId,
        thread_id: thread.id,
      });
    }
  }

  let handoffStarted = false;
  const renderLease: { release: (() => Promise<void>) | null } = {
    release: null,
  };

  try {
    const includeContext =
      shouldStartExecution && state.historyForwarded !== true;
    const trace: MattermostbotTrace = {
      includeContext,
      messageId: message.id,
      mode: input.mode,
      openStream: shouldStartExecution,
      startedAtMs: traceStartedAtMs,
      threadId: thread.id,
    };
    const serialized = await serializeMessage(message, options);
    const explicitOverrides = extractMessageOverrides(serialized.text);
    const messageOverrides = await messageOverridesForText(
      options,
      serialized.text,
      trace,
    );
    if (messageOverrides.cleanedText !== undefined) {
      serialized.text = messageOverrides.cleanedText;
    }
    const overrides = messageOverrides.overrides;
    const requestedStickyOverrides = preservePinnedPersona(
      state,
      stickyThreadOverrideUpdate(overrides),
    );
    const preserveStickyModelOverrides = Boolean(
      requestedStickyOverrides &&
        hasStickyModelOverride(requestedStickyOverrides) &&
        hasStickyModelOverride(state) &&
        !hasStickyModelOverride(explicitOverrides),
    );
    let stickyOverridesUpdate = preserveStickyModelOverrides
      ? personaOnlyStickyOverride(requestedStickyOverrides)
      : requestedStickyOverrides;
    const effectiveOverrides = {
      harnessType: stickyOverrideValue(state, stickyOverridesUpdate, "harnessType"),
      model: stickyOverrideValue(state, stickyOverridesUpdate, "model"),
      personaId: stickyOverrideValue(state, stickyOverridesUpdate, "personaId"),
      provider: stickyOverrideValue(state, stickyOverridesUpdate, "provider"),
    };
    const channelDefault = resolveChannelDefault(
      options.channelDefaults,
      thread.id,
    );
    const selectedHarnessType =
      effectiveOverrides.harnessType ??
      channelDefault?.harnessType ??
      options.defaultHarnessType ??
      "codex";
    if (!isHarnessEnabled(selectedHarnessType, options.enabledHarnesses)) {
      const fallbackHarness = options.defaultHarnessType ?? "codex";
      stickyOverridesUpdate = {
        ...stickyOverridesUpdate,
        harnessType: fallbackHarness,
        model: null,
        provider: null,
      };
      effectiveOverrides.harnessType = fallbackHarness;
      effectiveOverrides.model = undefined;
      effectiveOverrides.provider = undefined;
      logger.warn("mattermostbot_disabled_harness_reset", {
        disabled_harness: selectedHarnessType,
        fallback_harness: fallbackHarness,
        thread_id: thread.id,
      });
    }
    const resolvedHarnessType =
      effectiveOverrides.harnessType ?? channelDefault?.harnessType;
    const resolvedModel =
      stickyOverrideRaw(state, stickyOverridesUpdate, "model") === null
        ? undefined
        : effectiveOverrides.model ?? channelDefault?.model;
    const resolvedProvider =
      stickyOverrideRaw(state, stickyOverridesUpdate, "provider") === null
        ? undefined
        : effectiveOverrides.provider ?? channelDefault?.provider;
    const resolvedPersonaId =
      stickyOverrideRaw(state, stickyOverridesUpdate, "personaId") === null
        ? undefined
        : effectiveOverrides.personaId ?? channelDefault?.personaId;
    if (
      shouldStartExecution &&
      resolvedPersonaId &&
      !Object.prototype.hasOwnProperty.call(state, "personaId")
    ) {
      stickyOverridesUpdate = {
        ...(stickyOverridesUpdate ?? {}),
        personaId: resolvedPersonaId,
      };
    }
    const effectiveHarnessType =
      resolvedHarnessType ?? options.defaultHarnessType ?? "codex";
    const effectiveModel =
      resolvedModel ??
      defaultModelForHarness(
        effectiveHarnessType,
        options.harnessDefaultModels,
      );
    const requestedReasoning = overrides.reasoning ?? channelDefault?.reasoning;
    const resolvedReasoning = reasoningForModel(
      effectiveHarnessType,
      effectiveModel,
      requestedReasoning,
    );
    const effectiveReasoning = effectiveReasoningForHarness(
      effectiveHarnessType,
      resolvedReasoning,
      options.harnessDefaultReasoning,
    );

    if (forwardedIds.has(message.id) && !shouldStartExecution && !includeContext) {
      return;
    }
    if (shouldStartExecution && isContentlessApiMessage(serialized)) {
      logger.warn("mattermostbot_contentless_message_skipped", {
        message_id: message.id,
        thread_id: thread.id,
      });
      return;
    }

    let messages: MattermostbotApiMessage[];
    if (includeContext) {
      try {
        messages = await collectInitialContext(thread, message, options);
      } catch (error) {
        logger.error("mattermostbot_history_fetch_failed", {
          error: errorMessage(error),
          message_id: message.id,
          thread_id: thread.id,
        });
        await thread
          .post(
            "I couldn't read this thread's history, so I didn't start a turn. Check that I can read this channel, then mention me again.",
          )
          .catch(() => undefined);
        return;
      }
      const current = messages.find((item) => item.id === serialized.id);
      if (current) current.text = serialized.text;
    } else {
      messages = [serialized];
    }

    const pinnedHarness = typeof state.harnessType === "string"
      ? state.harnessType
      : undefined;
    const harnessRestart =
      shouldStartExecution &&
      Boolean(explicitOverrides.harnessType) &&
      Boolean(pinnedHarness) &&
      pinnedHarness !== effectiveHarnessType;
    const messagesToAppend = (harnessRestart ? messages : messages).filter(
      (item) => harnessRestart || !forwardedIds.has(item.id),
    );
    const conversationName = await resolveMattermostConversationName(
      options,
      thread.id,
    );
    let lastEventId = state.lastEventId ?? 0;
    const forwardInput: ForwardSessionInput = {
      afterEventId: lastEventId,
      conversationName,
      executeMessage: shouldStartExecution ? serialized : undefined,
      harnessType:
        shouldStartExecution &&
        (resolvedHarnessType || explicitOverrides.harnessType)
          ? effectiveHarnessType
          : undefined,
      metadataHarnessType: shouldStartExecution
        ? effectiveHarnessType
        : undefined,
      metadataModel: shouldStartExecution ? effectiveModel : undefined,
      model: shouldStartExecution ? resolvedModel : undefined,
      personaId: shouldStartExecution ? resolvedPersonaId : undefined,
      provider: shouldStartExecution ? resolvedProvider : undefined,
      reasoning: effectiveReasoning,
      messages: messagesToAppend,
      onEventId: (eventId) => {
        lastEventId = Math.max(lastEventId, eventId);
      },
      openStream: false,
      threadId: thread.id,
      trace,
    };

    const commitMessagesAppended = async (): Promise<void> => {
      const latest = (await thread.state) ?? {};
      const ids = new Set(latest.forwardedMessageIds ?? []);
      for (const item of messagesToAppend) ids.add(item.id);
      await thread.setState({
        ...(stickyOverridesUpdate ?? {}),
        forwardedMessageIds: Array.from(ids).slice(-1000),
        historyForwarded: latest.historyForwarded || includeContext,
        lastEventId: Math.max(latest.lastEventId ?? 0, lastEventId),
      });
    };

    const commitExecutionStarted = async (
      execution: MattermostbotExecuteSessionResponse,
    ): Promise<void> => {
      const latest = (await thread.state) ?? {};
      const latestExecutedIds = new Set(latest.executedMessageIds ?? []);
      latestExecutedIds.add(serialized.id);
      if (!renderLease.release) {
        try {
          renderLease.release = await acquireRenderLease(input.state, thread.id);
        } catch (error) {
          traceLog(options, "mattermostbot_render_lease_acquire_failed", trace, {
            error: errorMessage(error),
          });
        }
      }
      await thread.setState({
        ...(stickyOverridesUpdate ?? {}),
        activeExecution: true,
        activeExecutionStartedAt: Date.now(),
        executedMessageIds: Array.from(latestExecutedIds).slice(-1000),
        lastEventId: Math.max(latest.lastEventId ?? 0, lastEventId),
        renderObligation: {
          afterEventId: lastEventId,
          executionId: execution.execution_id,
          message: serialized,
        },
      });
      await indexRenderObligation(input.state, {
        options,
        threadId: thread.id,
        trace,
      });
      const afterCommit = (await thread.state) ?? {};
      if (stopRequestedFor(afterCommit, message)) {
        backgroundWaitUntil(
          interruptSessionExecution(
            options,
            thread.id,
            "Interrupted from Mattermost",
          ).catch(() => undefined),
        );
      }
    };

    if (!shouldStartExecution) {
      if (messagesToAppend.length > 0) {
        await withTransientSessionApiRetry(
          () =>
            forwardToSessionApi(options, forwardInput, {
              onMessagesAppended: commitMessagesAppended,
            }),
          options,
          trace,
        );
      }
      return;
    }

    await thread.setState({
      activeExecution: true,
      activeExecutionStartedAt: Date.now(),
    });
    let stoppedBeforeExecute = false;
    await withTransientSessionApiRetry(
      () =>
        forwardToSessionApi(
          options,
          { ...forwardInput, executeMessage: undefined, openStream: false },
          {
            onMessagesAppended: commitMessagesAppended,
            shouldExecute: async () => {
              stoppedBeforeExecute = stopRequestedFor(
                (await thread.state) ?? {},
                message,
              );
              return !stoppedBeforeExecute;
            },
          },
        ),
      options,
      trace,
    );
    if (stoppedBeforeExecute) {
      const latest = (await thread.state) ?? {};
      await thread.setState({
        activeExecution: false,
        activeExecutionStartedAt: null,
        lastEventId: Math.max(latest.lastEventId ?? 0, lastEventId),
      });
      return;
    }
    handoffStarted = true;
    scheduleExecutionRender(
      thread,
      serialized,
      options,
      forwardInput,
      () => lastEventId,
      includeContext,
      renderLease,
      trace,
      commitExecutionStarted,
      releaseExecutionSlot ?? undefined,
    );
  } catch (error) {
    logger.error("mattermostbot_session_turn_failed", {
      error: errorMessage(error),
      message_id: message.id,
      thread_id: thread.id,
    });
    await renderLease.release?.();
    const latest = (await thread.state) ?? {};
    await thread.setState({
      activeExecution: false,
      activeExecutionStartedAt: null,
      lastEventId: latest.lastEventId ?? 0,
    });
    await thread
      .post(`Centaur could not complete this turn: ${errorMessage(error)}`)
      .catch(() => undefined);
  } finally {
    if (!handoffStarted) releaseExecutionSlot?.();
  }
}

function scheduleExecutionRender(
  thread: Thread<MattermostbotThreadState>,
  message: MattermostbotApiMessage,
  options: MattermostbotOptions,
  input: ForwardSessionInput,
  getLastEventId: () => number,
  isInitialExecution: boolean,
  renderLease: { release: (() => Promise<void>) | null },
  trace?: MattermostbotTrace,
  onExecutionStarted?: (
    execution: MattermostbotExecuteSessionResponse,
  ) => Promise<void>,
  onSettled?: () => void,
): void {
  const promise = (async () => {
    try {
      let attempt = 0;
      while (true) {
        const result = await renderExecutionAttempt(
          thread,
          message,
          options,
          input,
          getLastEventId,
          isInitialExecution,
          trace,
          onExecutionStarted,
        );
        if (result === "complete") return;
        if (
          attempt >=
          (options.renderRetryMaxAttempts ?? RENDER_RETRY_MAX_ATTEMPTS)
        ) {
          const latest = (await thread.state) ?? {};
          await thread.setState({
            activeExecution: false,
            activeExecutionStartedAt: null,
            lastEventId: Math.max(latest.lastEventId ?? 0, getLastEventId()),
          });
          await renderExecutionStream(
            thread,
            streamError(
              new Error(
                "Streaming retries exhausted; giving up on rendering this run.",
              ),
            ),
            message,
            options,
            false,
            trace,
          ).catch(() => undefined);
          return;
        }
        const delayMs = renderRetryDelayMs(options, attempt);
        attempt += 1;
        await sleep(delayMs);
      }
    } finally {
      await renderLease.release?.();
      onSettled?.();
    }
  })();
  backgroundWaitUntil(promise);
}

export function hasLiveActiveExecution(
  state: Pick<
    MattermostbotThreadState,
    "activeExecution" | "activeExecutionStartedAt"
  >,
  ttlMs: number,
  nowEpochMs = Date.now(),
): boolean {
  if (state.activeExecution !== true) return false;
  if (typeof state.activeExecutionStartedAt !== "number") return false;
  return nowEpochMs - state.activeExecutionStartedAt <= ttlMs;
}

async function withTransientSessionApiRetry<T>(
  operation: () => Promise<T>,
  options: MattermostbotOptions,
  trace?: MattermostbotTrace,
): Promise<T> {
  const delays = options.forwardRetryDelaysMs ?? FORWARD_RETRY_DELAYS_MS;
  for (let attempt = 0; ; attempt++) {
    try {
      return await operation();
    } catch (error) {
      const delayMs = delays[attempt];
      if (delayMs === undefined || !isRetryableSessionApiError(error)) {
        throw error;
      }
      traceLog(options, "mattermostbot_forward_transient_retry", trace, {
        attempt: attempt + 1,
        delay_ms: delayMs,
        error: errorMessage(error),
      });
      await sleep(delayMs);
    }
  }
}

async function renderExecutionAttempt(
  thread: Thread<MattermostbotThreadState>,
  message: MattermostbotApiMessage,
  options: MattermostbotOptions,
  input: ForwardSessionInput,
  getLastEventId: () => number,
  isInitialExecution: boolean,
  trace?: MattermostbotTrace,
  onExecutionStarted?: (
    execution: MattermostbotExecuteSessionResponse,
  ) => Promise<void>,
): Promise<"complete" | "retry"> {
  const state = (await thread.state) ?? {};
  if (
    isInitialExecution &&
    typeof state.stopRequestedAt === "number" &&
    state.stopRequestedAt >= Date.parse(message.timestamp)
  ) {
    await thread.setState({
      activeExecution: false,
      activeExecutionStartedAt: null,
    });
    return "complete";
  }
  let rendered = false;
  let retry = false;
  try {
    await renderExecutionStream(
      thread,
      streamSessionAfterHandoff(options, input, onExecutionStarted),
      message,
      options,
      isInitialExecution,
      trace,
    );
    rendered = true;
    return "complete";
  } catch (error) {
    if (isRetryableSessionApiError(error)) {
      retry = true;
      return "retry";
    }
    throw error;
  } finally {
    const latest = (await thread.state) ?? {};
    await thread.setState({
      activeExecution: retry,
      activeExecutionStartedAt: retry ? Date.now() : null,
      lastEventId: Math.max(latest.lastEventId ?? 0, getLastEventId()),
      ...(rendered ? { renderObligation: null } : {}),
    });
  }
}

async function renderExecutionStream(
  thread: Thread,
  stream: AsyncIterable<MattermostbotRendererSource>,
  message: MattermostbotApiMessage,
  options: MattermostbotOptions,
  _isInitialExecution: boolean,
  _trace?: MattermostbotTrace,
): Promise<void> {
  const logger = options.logger ?? noopLogger;
  const stopTyping = startMattermostTypingKeepalive(thread, logger);
  try {
    await renderSplitExecutionStreams(thread, stream, options);
  } finally {
    stopTyping();
  }
}

async function renderSplitExecutionStreams(
  thread: Thread,
  stream: AsyncIterable<MattermostbotRendererSource>,
  options: MattermostbotOptions,
): Promise<void> {
  const answerText = new AsyncTextQueue();
  let answerPost: Promise<void> | null = null;
  let sawText = false;
  let sourceFailed = false;
  try {
    for await (const chunk of harnessToChatSdkStream(
      stream,
      rendererOptions(options),
    )) {
      if (chunk.type !== "markdown_text") continue;
      sawText = true;
      if (!answerPost) {
        answerPost = streamAnswerToThread(thread, answerText, options);
        answerPost.catch(() => undefined);
      }
      answerText.push(chunk.text);
    }
  } catch (error) {
    sourceFailed = true;
    throw error;
  } finally {
    if (!sawText && !sourceFailed) {
      if (!answerPost) {
        answerPost = streamAnswerToThread(thread, answerText, options);
        answerPost.catch(() => undefined);
      }
      answerText.push("Execution completed, but no final text was captured.");
    }
    answerText.end();
    if (answerPost) {
      if (sourceFailed) await answerPost.catch(() => undefined);
      else await answerPost;
    }
  }
}

export async function streamAnswerToThread(
  thread: Thread,
  source: AsyncIterable<string>,
  options: MattermostbotOptions,
): Promise<void> {
  const maxChars = Math.max(
    1,
    options.maxPostChars ?? DEFAULT_MAX_POST_CHARS,
  );
  const editIntervalMs = Math.max(
    0,
    options.answerEditIntervalMs ?? DEFAULT_ANSWER_EDIT_INTERVAL_MS,
  );
  let pending = "";
  let current: { id: string; threadId: string } | null = null;
  let lastEditedContent = "";
  let lastEditAtMs = 0;

  const postNew = async (content: string): Promise<void> => {
    const raw = await thread.adapter.postMessage(thread.id, { raw: content });
    current = { id: raw.id, threadId: raw.threadId || thread.id };
    lastEditedContent = content;
    lastEditAtMs = nowMs();
  };

  const editCurrent = async (content: string): Promise<void> => {
    if (!current || content === lastEditedContent) return;
    await thread.adapter.editMessage(current.threadId, current.id, {
      raw: content,
    });
    lastEditedContent = content;
  };

  const finalizeMessage = async (content: string): Promise<void> => {
    if (current) {
      await editCurrent(content);
      current = null;
      lastEditedContent = "";
    } else if (content.trim()) {
      await postNew(content);
      current = null;
      lastEditedContent = "";
    }
  };

  for await (const piece of source) {
    pending += piece;
    while (true) {
      const split = takeMessageChunk(pending, maxChars);
      if (!split) break;
      await finalizeMessage(split.chunk);
      pending = split.rest;
    }
    if (!pending.trim()) continue;
    if (!current) {
      await postNew(pending);
    } else if (nowMs() - lastEditAtMs >= editIntervalMs) {
      await editCurrent(pending);
      lastEditAtMs = nowMs();
    }
  }

  while (true) {
    const split = takeMessageChunk(pending, maxChars);
    if (!split) break;
    await finalizeMessage(split.chunk);
    pending = split.rest;
  }
  if (pending.trim()) await finalizeMessage(pending);

}

async function* streamSessionAfterHandoff(
  options: MattermostbotOptions,
  input: ForwardSessionInput,
  onExecutionStarted?: (
    execution: MattermostbotExecuteSessionResponse,
  ) => Promise<void>,
): AsyncIterable<MattermostbotRendererSource> {
  yield startingStreamNotification(input.threadId);
  if (input.executeMessage) {
    try {
      const execution = await executeSessionTurn(options, input);
      if (execution) {
        input.executionId = execution.execution_id;
        await onExecutionStarted?.(execution);
      }
    } catch (error) {
      if (isRetryableSessionApiError(error)) throw error;
      yield sessionStreamError(error);
      return;
    }
  }

  let stream: AsyncIterable<MattermostbotRendererSource>;
  try {
    stream = await openSessionEventStream(options, input);
  } catch (error) {
    if (isRetryableSessionApiError(error)) throw error;
    yield sessionStreamError(error);
    return;
  }
  for await (const event of stream) yield event;
}

async function* streamOpenedSession(
  input: Pick<ForwardSessionInput, "threadId" | "trace">,
  stream: AsyncIterable<MattermostbotRendererSource>,
): AsyncIterable<MattermostbotRendererSource> {
  yield startingStreamNotification(input.threadId);
  for await (const event of stream) yield event;
}

async function* streamError(
  error: unknown,
): AsyncIterable<MattermostbotRendererSource> {
  yield sessionStreamError(error);
}

function scheduleRenderObligationRecovery(
  chat: Chat<Record<string, Adapter>, MattermostbotThreadState>,
  state: StateAdapter,
  options: MattermostbotOptions,
): void {
  backgroundWaitUntil(recoverRenderObligationsWithRetry(chat, state, options));
}

async function recoverRenderObligationsWithRetry(
  chat: Chat<Record<string, Adapter>, MattermostbotThreadState>,
  state: StateAdapter,
  options: MattermostbotOptions,
): Promise<void> {
  try {
    await state.connect();
    let attempt = 0;
    while (true) {
      const deferredCount = await recoverRenderObligations(chat, state, options);
      if (deferredCount === 0) return;
      await sleep(renderRetryDelayMs(options, attempt));
      attempt += 1;
    }
  } catch (error) {
    traceLog(options, "mattermostbot_render_recovery_failed", undefined, {
      error: errorMessage(error),
    });
  }
}

async function recoverRenderObligations(
  chat: Chat<Record<string, Adapter>, MattermostbotThreadState>,
  state: StateAdapter,
  options: MattermostbotOptions,
): Promise<number> {
  await chat.initialize();
  const indexedThreadIds = await state.getList<string>(
    RENDER_OBLIGATION_INDEX_KEY,
  );
  let deferredCount = 0;
  for (const threadId of Array.from(new Set(indexedThreadIds))) {
    try {
      const thread = chat.thread(threadId);
      const obligation = (await thread.state)?.renderObligation;
      if (!obligation) continue;
      const leaseToken = randomUUID();
      const leaseAcquired = await state.setIfNotExists(
        renderRecoveryLeaseKey(threadId),
        leaseToken,
        RENDER_RECOVERY_LEASE_TTL_MS,
      );
      if (!leaseAcquired) continue;
      try {
        const leasedObligation = (await thread.state)?.renderObligation;
        if (!leasedObligation) continue;
        if (
          await recoverRenderObligation(
            chat,
            state,
            options,
            threadId,
            leasedObligation,
          )
        ) {
          deferredCount += 1;
        }
      } finally {
        const current = await state.get<string>(
          renderRecoveryLeaseKey(threadId),
        );
        if (current === leaseToken) {
          await state.delete(renderRecoveryLeaseKey(threadId));
        }
      }
    } catch (error) {
      deferredCount += 1;
      traceLog(options, "mattermostbot_render_recovery_thread_failed", undefined, {
        error: errorMessage(error),
        thread_id: threadId,
      });
    }
  }
  return deferredCount;
}

async function recoverRenderObligation(
  chat: Chat<Record<string, Adapter>, MattermostbotThreadState>,
  _state: StateAdapter,
  options: MattermostbotOptions,
  threadId: string,
  obligation: MattermostbotRenderObligation,
): Promise<boolean> {
  const trace: MattermostbotTrace = {
    includeContext: false,
    messageId: obligation.message.id,
    mode: "execute",
    openStream: true,
    startedAtMs: nowMs(),
    threadId,
  };
  const thread = chat.thread(threadId);
  const threadState = (await thread.state) ?? {};
  let lastEventId = Math.max(threadState.lastEventId ?? 0, obligation.afterEventId);
  const input: ForwardSessionInput = {
    afterEventId: lastEventId,
    executionId: obligation.executionId,
    messages: [],
    onEventId: (eventId) => {
      lastEventId = Math.max(lastEventId, eventId);
    },
    openStream: false,
    threadId,
    trace,
  };

  let openedStream: AsyncIterable<MattermostbotRendererSource>;
  try {
    openedStream = await openSessionEventStream(options, input);
  } catch (error) {
    if (isRetryableSessionApiError(error)) return true;
    await renderExecutionStream(
      thread,
      streamError(error),
      obligation.message,
      options,
      false,
      trace,
    );
    await thread.setState({
      activeExecution: false,
      activeExecutionStartedAt: null,
      lastEventId,
      renderObligation: null,
    });
    return false;
  }

  let rendered = false;
  try {
    await thread.setState({
      activeExecution: true,
      activeExecutionStartedAt: Date.now(),
      lastEventId,
    });
    await renderExecutionStream(
      thread,
      streamOpenedSession(input, openedStream),
      obligation.message,
      options,
      false,
      trace,
    );
    rendered = true;
  } finally {
    const latest = (await thread.state) ?? {};
    await thread.setState({
      activeExecution: false,
      activeExecutionStartedAt: null,
      lastEventId: Math.max(latest.lastEventId ?? 0, lastEventId),
      ...(rendered ? { renderObligation: null } : {}),
    });
  }
  return false;
}

async function indexRenderObligation(
  state: StateAdapter,
  input: {
    options: MattermostbotOptions;
    threadId: string;
    trace?: MattermostbotTrace;
  },
): Promise<void> {
  await state.appendToList(RENDER_OBLIGATION_INDEX_KEY, input.threadId, {
    maxLength: RENDER_OBLIGATION_INDEX_MAX_LENGTH,
    ttlMs: RENDER_INDEX_TTL_MS,
  });
  traceLog(input.options, "mattermostbot_render_obligation_indexed", input.trace);
}

function renderRecoveryLeaseKey(threadId: string): string {
  return `mattermostbot:render:lease:${threadId}`;
}

async function acquireRenderLease(
  state: StateAdapter,
  threadId: string,
): Promise<() => Promise<void>> {
  const key = renderRecoveryLeaseKey(threadId);
  const token = randomUUID();
  await state.set(key, token, RENDER_RECOVERY_LEASE_TTL_MS);
  const refresh = setInterval(() => {
    void state
      .get<string>(key)
      .then((current) =>
        current === token
          ? state.set(key, token, RENDER_RECOVERY_LEASE_TTL_MS)
          : undefined,
      )
      .catch(() => undefined);
  }, RENDER_LEASE_REFRESH_INTERVAL_MS);
  return async () => {
    clearInterval(refresh);
    try {
      const current = await state.get<string>(key);
      if (current === token) await state.delete(key);
    } catch {
      // The lease TTL is the backstop if state is unavailable during cleanup.
    }
  };
}

function renderRetryDelayMs(
  options: MattermostbotOptions,
  attempt: number,
): number {
  const initialDelayMs =
    options.renderRetryInitialDelayMs ?? RENDER_RETRY_INITIAL_DELAY_MS;
  const maxDelayMs =
    options.renderRetryMaxDelayMs ?? RENDER_RETRY_MAX_DELAY_MS;
  return Math.min(initialDelayMs * 2 ** attempt, maxDelayMs);
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function backgroundWaitUntil(promise: Promise<unknown>): void {
  void promise.catch(() => undefined);
}

function rendererOptions(
  options: MattermostbotOptions,
): CodexAppServerToChatStreamOptions {
  const mapper = options.mapper;
  return {
    ...mapper,
    preStreamGraceMs: 0,
    async onRendererEvent(event) {
      await mapper?.onRendererEvent?.(event);
    },
  };
}

function threadChannelId(threadId: string): string {
  const parts = threadId.split(":");
  return Buffer.from(parts[1] ?? "", "base64url").toString();
}

export function mattermostHealthState(
  adapter: MattermostAdapterWithHealth,
): "connected" | "disconnected" {
  return adapter.isWebSocketConnected() ? "connected" : "disconnected";
}

// Keep typing alive for long executions. Chat SDK's thread.post() also starts
// and stops typing around a stream; this interval covers the adapter's short
// typing expiry while the API handoff is still in progress.
export function startMattermostTypingKeepalive(
  thread: Thread,
  logger: Logger,
): () => void {
  const adapter = thread.adapter as {
    startTyping?: (threadId: string) => Promise<void>;
  };
  const fire = (): void => {
    void adapter.startTyping?.(thread.id).catch((error) => {
      logger.debug("mattermostbot_typing_error", {
        error: errorMessage(error),
      });
    });
  };
  fire();
  const interval = setInterval(fire, TYPING_KEEPALIVE_MS);
  return () => clearInterval(interval);
}

