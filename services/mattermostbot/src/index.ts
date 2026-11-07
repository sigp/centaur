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
  buildMattermostResponseFooter,
  defaultModelForHarness,
  defaultServiceTierForHarness,
  effectiveReasoningForHarness,
  personaFallbackNotice,
  reasoningForModel,
} from "./response-context";
import {
  collectInitialContext,
  collectMentionContext,
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
import { proactiveThreadMessage } from "./proactive-classifier";
import {
  resolveProactivityRules,
  type ProactivityRule,
} from "./proactivity-rules";
import { mattermostbotMetrics, observeSeconds } from "./metrics";
import type {
  ForwardSessionInput,
  JsonObject,
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
import {
  createReactionController,
  type ReactionAck,
  type ReactionController,
} from "./reactions";

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
  MattermostbotProactivityOptions,
  MattermostbotSessionMessage,
  MattermostbotSessionMessageRole,
  ProactiveClassifier,
  ProactiveClassifierInput,
  ProactiveDecision,
  ProactiveThreadMessage,
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
const PROACTIVE_CLASSIFIER_TIMEOUT_MS = 2_000;
const PROACTIVE_HISTORY_MESSAGES = 20;
const PROACTIVE_CLAIM_TTL_MS = 60_000;
const PROACTIVE_CLAIM_WAIT_MS = 30_000;
const PROACTIVE_CLAIM_POLL_MS = 250;
const PROACTIVE_PENDING_GRACE_MS = 60_000;
const PROACTIVE_PENDING_MAX = 50;
const PROACTIVE_MENTION_TTL_MS = 60_000;
const PROACTIVE_PENDING_KEY_PREFIX = "mattermostbot:proactive:pending:";
const PROACTIVE_BURST_END_KEY_PREFIX = "mattermostbot:proactive:burst-end:";
const PROACTIVE_MENTION_KEY_PREFIX = "mattermostbot:proactive:mention:";
const PROACTIVE_CLAIM_KEY_PREFIX = "mattermostbot:proactive:claim:";
const DEFAULT_MESSAGE_OVERRIDES_STRATEGY = createFlagMessageOverridesStrategy();

export async function messageOverridesForText(
  options: MattermostbotOptions,
  text: string,
  trace?: MattermostbotTrace,
): Promise<{ cleanedText?: string; overrides: HarnessOverrides }> {
  const startedAtMs = nowMs();
  const strategy =
    options.messageOverridesStrategy ?? DEFAULT_MESSAGE_OVERRIDES_STRATEGY;
  const persona = extractPersonaOverride(text);
  let strategyFailed = false;
  let result: { cleanedText?: string; overrides: HarnessOverrides };
  try {
    result = await strategy({ text: persona.cleanedText });
  } catch (error) {
    strategyFailed = true;
    traceLog(options, "mattermostbot_message_overrides_strategy_failed", trace, {
      error: errorMessage(error),
    });
    result = await DEFAULT_MESSAGE_OVERRIDES_STRATEGY({
      text: persona.cleanedText,
    });
  }
  const { personaId: _strategyPersonaId, ...strategyOverrides } =
    result.overrides;
  const overrides = {
    ...strategyOverrides,
    ...(persona.personaId ? { personaId: persona.personaId } : {}),
  };
  const outcome = strategyFailed
    ? "strategy_failed"
    : Object.keys(overrides).length > 0
      ? "applied"
      : "none";
  mattermostbotMetrics.messageOverrides.inc({ outcome });
  mattermostbotMetrics.messageOverridesDuration.observe(
    { outcome },
    observeSeconds(startedAtMs),
  );
  for (const field of Object.keys(overrides)) {
    mattermostbotMetrics.messageOverrideFields.inc({ field });
  }
  return {
    ...result,
    ...(persona.personaId && result.cleanedText === undefined
      ? { cleanedText: persona.cleanedText }
      : {}),
    overrides,
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
  const reactions = createReactionController(options, adapter);
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

  const scheduleProactiveMessage = (
    thread: Thread<MattermostbotThreadState>,
    message: ChatMessage,
  ): void => {
    if (!options.proactivity) return;
    backgroundWaitUntil(
      handleProactiveMessage(thread, message, {
        executionLimiter,
        options,
        reactions,
        state,
      }).catch((error) => {
        traceLog(options, "mattermostbot_proactive_failed", {
          includeContext: false,
          messageId: message.id,
          mode: "execute",
          openStream: false,
          startedAtMs: nowMs(),
          threadId: thread.id,
        }, { error: errorMessage(error) });
      }),
    );
  };

  chat.onNewMention(async (thread, message) => {
    if (!(await isAllowedMattermostMessage(message, options, logger))) return;
    if (await handleStopCommand(thread, message, options)) return;
    await markProactiveMention(thread, message, options, state);
    await thread.subscribe();
    await syncThreadMessageToSession(thread, message, {
      mode: "execute",
      executionLimiter,
      options,
      reactions,
      state,
    });
  });

  chat.onSubscribedMessage(async (thread, message) => {
    if (!(await isAllowedMattermostMessage(message, options, logger))) return;
    if (message.isMention !== true) {
      await handleUnmentionedMessage(
        thread,
        message,
        options,
        scheduleProactiveMessage,
      );
      return;
    }
    if (await handleStopCommand(thread, message, options)) return;
    await markProactiveMention(thread, message, options, state);
    await syncThreadMessageToSession(thread, message, {
      mode: "execute",
      executionLimiter,
      options,
      reactions,
      state,
    });
  });

  // Pattern routing receives unmentioned, unsubscribed, non-DM messages.
  // Operator rules only start threads from top-level posts.
  chat.onNewMessage(/^.*$/s, async (thread, message) => {
    if (!(await isAllowedMattermostMessage(message, options, logger))) return;
    if (isMattermostThreadReply(message)) return;
    scheduleProactiveMessage(thread, message);
  });

  const app = new Hono();
  app.get("/health", (context) => {
    const connected = adapter.isWebSocketConnected();
    return context.json(
      { ok: connected, service: "mattermostbot", websocket: connected },
      connected ? 200 : 503,
    );
  });
  app.get("/metrics", (context) => {
    mattermostbotMetrics.websocketConnected.set(
      {},
      adapter.isWebSocketConnected() ? 1 : 0,
    );
    return context.text(mattermostbotMetrics.expose(), 200, {
      "Content-Type": "text/plain; version=0.0.4; charset=utf-8",
    });
  });

  if (options.recoverRenderObligationsOnStart !== false) {
    scheduleRenderObligationRecovery(chat, state, options, reactions);
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

type ProactiveScheduler = (
  thread: Thread<MattermostbotThreadState>,
  message: ChatMessage,
) => void;

type PendingProactiveMessage = {
  id: string;
  timestamp: number;
};

/**
 * Single hook for an unmentioned subscribed-thread post. Classification runs
 * in the background because Chat SDK concurrency is configured to drop.
 */
async function handleUnmentionedMessage(
  thread: Thread<MattermostbotThreadState>,
  message: ChatMessage,
  options: MattermostbotOptions,
  schedule: ProactiveScheduler,
): Promise<void> {
  if (!options.proactivity) {
    traceLog(options, "mattermostbot_subscribed_message_without_mention_ignored", {
      includeContext: false,
      messageId: message.id,
      mode: "append",
      openStream: false,
      startedAtMs: nowMs(),
      threadId: thread.id,
    });
    return;
  }
  schedule(thread, message);
}

async function markProactiveMention(
  thread: Thread<MattermostbotThreadState>,
  message: ChatMessage,
  options: MattermostbotOptions,
  state: StateAdapter,
): Promise<void> {
  if (!options.proactivity) return;
  await thread.setState({ proactiveEligible: true });
  await state.set(
    `${PROACTIVE_MENTION_KEY_PREFIX}${thread.id}`,
    pendingProactiveMessage(message),
    PROACTIVE_MENTION_TTL_MS,
  );
}

function pendingProactiveMessage(message: ChatMessage): PendingProactiveMessage {
  return {
    id: message.id,
    timestamp: message.metadata.dateSent.getTime(),
  };
}

function isMattermostThreadReply(message: ChatMessage): boolean {
  const raw = message.raw as { root_id?: unknown } | null | undefined;
  return typeof raw?.root_id === "string" && raw.root_id.length > 0;
}

function compareProactiveMessages(
  left: PendingProactiveMessage,
  right: PendingProactiveMessage,
): number {
  if (left.timestamp !== right.timestamp) return left.timestamp - right.timestamp;
  return left.id.localeCompare(right.id);
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
    mattermostbotMetrics.stopCommands.inc({
      outcome: response.interrupted ? "interrupted" : "nothing_to_interrupt",
    });
    traceLog(options, "mattermostbot_stop_command_complete", trace, {
      execution_id: response.execution_id,
      interrupted: response.interrupted,
    });
  } catch (error) {
    traceLog(options, "mattermostbot_stop_command_failed", trace, {
      error: errorMessage(error),
    });
    mattermostbotMetrics.stopCommands.inc({ outcome: "failed" });
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
    /** An unmentioned message accepted by the proactive classifier. */
    proactive?: boolean;
    /** Operator rule matched by this proactive message, if any. */
    proactiveRule?: ProactivityRule;
    reactionAck?: ReactionAck;
    reactions: ReactionController;
    retryAttempt?: number;
    state: StateAdapter;
  },
): Promise<void> {
  const traceStartedAtMs = nowMs();
  const options = input.options;
  const logger = options.logger ?? noopLogger;
  let state = (await thread.state) ?? {};
  if (input.proactive === true && options.proactivity) {
    await thread.setState({ proactiveEligible: true });
    state = { ...state, proactiveEligible: true };
  }
  const forwardedIds = new Set(state.forwardedMessageIds ?? []);
  const executedIds = new Set(state.executedMessageIds ?? []);
  let shouldStartExecution =
    input.mode === "execute" &&
    !hasLiveActiveExecution(
      state,
      options.activeExecutionTtlMs ?? DEFAULT_ACTIVE_EXECUTION_TTL_MS,
    ) &&
    !executedIds.has(message.id);
  const isFirstAssistantMessage =
    shouldStartExecution && executedIds.size === 0;
  let reactionAck = input.reactionAck;

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
    const refreshContext =
      (message.isMention === true || input.proactive === true) &&
      state.historyForwarded === true;
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
    const responseMetadataMode = options.responseMetadataMode ?? "first";
    const includeResponseMetadata =
      responseMetadataMode === "always" ||
      (responseMetadataMode === "first" && isFirstAssistantMessage);
    let responseFooter = buildMattermostResponseFooter({
      harnessType: effectiveHarnessType,
      metadataEnabled: includeResponseMetadata,
      model: effectiveModel,
      reasoning: effectiveReasoning,
      serviceTier:
        options.responseServiceTierEnabled === true && !resolvedProvider
          ? defaultServiceTierForHarness(effectiveHarnessType)
          : undefined,
    });

    if (
      forwardedIds.has(message.id) &&
      !shouldStartExecution &&
      !includeContext &&
      !refreshContext
    ) {
      return;
    }
    if (shouldStartExecution && isContentlessApiMessage(serialized)) {
      logger.warn("mattermostbot_contentless_message_skipped", {
        message_id: message.id,
        thread_id: thread.id,
      });
      return;
    }
    if (shouldStartExecution && !reactionAck) {
      reactionAck = input.reactions.begin(thread, message, "ack");
    }

    let messages: MattermostbotApiMessage[];
    if (includeContext || refreshContext) {
      try {
        messages = refreshContext
          ? await collectMentionContext(thread, message, options)
          : await collectInitialContext(thread, message, options);
      } catch (error) {
        if (!refreshContext) {
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
        logger.warn("mattermostbot_mention_context_degraded", {
          error: errorMessage(error),
          message_id: message.id,
          thread_id: thread.id,
        });
        messages = [serialized];
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
    if (harnessRestart) {
      await thread.setState({ proactiveRulesSent: [] });
      state = { ...state, proactiveRulesSent: [] };
    }
    const proactiveRule =
      shouldStartExecution &&
      input.proactiveRule &&
      (harnessRestart ||
        !(state.proactiveRulesSent ?? []).includes(input.proactiveRule.name))
        ? input.proactiveRule
        : undefined;
    const proactiveContext = proactiveRule
      ? proactiveRuleContext(proactiveRule)
      : undefined;
    const messagesToAppend = messages.filter(
      (item) => harnessRestart || !forwardedIds.has(item.id),
    );
    if (
      !shouldStartExecution &&
      (message.isMention === true || input.proactive === true) &&
      messagesToAppend.some((item) => item.id === message.id) &&
      !reactionAck
    ) {
      reactionAck = input.reactions.begin(thread, message, "steering");
    }
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
      proactiveContext,
      provider: shouldStartExecution ? resolvedProvider : undefined,
      reasoning: effectiveReasoning,
      responseFooter: shouldStartExecution ? responseFooter : undefined,
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
      if (!shouldStartExecution && latest.activeExecution === true && reactionAck) {
        input.reactions.hold(reactionAck);
        reactionAck = undefined;
      }
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
        ...(harnessRestart || proactiveRule
          ? {
              proactiveRulesSent: proactiveRule
                ? Array.from(
                    new Set([
                      ...(latest.proactiveRulesSent ?? []),
                      proactiveRule.name,
                    ]),
                  )
                : [],
            }
          : {}),
        activeExecution: true,
        activeExecutionStartedAt: Date.now(),
        executedMessageIds: Array.from(latestExecutedIds).slice(-1000),
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
    const finishReaction = (): void => {
      const ack = reactionAck;
      reactionAck = undefined;
      if (ack) backgroundWaitUntil(input.reactions.complete(ack));
    };


    if (!shouldStartExecution) {
      if (messagesToAppend.length === 0) {
        finishReaction();
        return;
      }
      try {
        await forwardToSessionApi(options, forwardInput, {
          onMessagesAppended: commitMessagesAppended,
        });
      } catch (error) {
        const delays = options.forwardRetryDelaysMs ?? FORWARD_RETRY_DELAYS_MS;
        const attempt = input.retryAttempt ?? 0;
        const delayMs = delays[attempt];
        if (delayMs === undefined || !isRetryableSessionApiError(error)) {
          mattermostbotMetrics.forwardRetries.inc({ outcome: "exhausted" });
          throw error;
        }
        mattermostbotMetrics.forwardRetries.inc({ outcome: "scheduled" });
        traceLog(options, "mattermostbot_forward_retry_scheduled", trace, {
          attempt: attempt + 1,
          delay_ms: delayMs,
          error: errorMessage(error),
        });
        const retryReaction = reactionAck;
        reactionAck = undefined;
        backgroundWaitUntil(
          (async () => {
            await sleep(delayMs);
            await syncThreadMessageToSession(thread, message, {
              ...input,
              reactionAck: retryReaction,
              retryAttempt: attempt + 1,
            });
          })().catch((retryError: unknown) => {
            traceLog(options, "mattermostbot_forward_retry_failed", trace, {
              attempt: attempt + 1,
              error: errorMessage(retryError),
            });
            if (retryReaction) {
              backgroundWaitUntil(input.reactions.complete(retryReaction));
            }
          }),
        );
        return;
      }
      finishReaction();
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
            onSessionCreated: async (outcome) => {
              if (outcome.personaId !== undefined) {
                stickyOverridesUpdate = {
                  ...(stickyOverridesUpdate ?? {}),
                  personaId: outcome.personaId,
                };
                forwardInput.personaId = outcome.personaId ?? undefined;
              }
              const harnessType =
                outcome.harnessType ?? effectiveHarnessType;
              const personaModel = outcome.personaModel;
              let model = effectiveModel;
              let reasoning = effectiveReasoning;
              if (harnessType !== effectiveHarnessType || personaModel) {
                model =
                  personaModel ??
                  resolvedModel ??
                  defaultModelForHarness(
                    harnessType,
                    options.harnessDefaultModels,
                  );
                const modelReasoning = reasoningForModel(
                  harnessType,
                  model,
                  requestedReasoning,
                );
                reasoning = effectiveReasoningForHarness(
                  harnessType,
                  modelReasoning,
                  options.harnessDefaultReasoning,
                );
                forwardInput.metadataModel = model;
                forwardInput.reasoning = modelReasoning;
                if (personaModel) {
                  forwardInput.model = undefined;
                  forwardInput.provider = undefined;
                }
              }
              forwardInput.metadataHarnessType = harnessType;
              responseFooter = buildMattermostResponseFooter({
                harnessType,
                metadataEnabled: includeResponseMetadata,
                model,
                notice: personaFallbackNotice(
                  outcome.unavailableRequestedPersonaId,
                  outcome.personaId,
                ),
                reasoning,
                serviceTier:
                  options.responseServiceTierEnabled === true &&
                  (Boolean(personaModel) || !resolvedProvider)
                    ? defaultServiceTierForHarness(harnessType)
                    : undefined,
              });
              forwardInput.responseFooter = responseFooter;
            },
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
      finishReaction();
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
      input.reactions,
      reactionAck,
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
    if (shouldStartExecution) {
      await thread.setState({
        activeExecution: false,
        activeExecutionStartedAt: null,
        lastEventId: latest.lastEventId ?? 0,
      });
    }
    if (reactionAck) {
      const ack = reactionAck;
      reactionAck = undefined;
      backgroundWaitUntil(input.reactions.complete(ack));
    }
    await thread
      .post(`Centaur could not complete this turn: ${errorMessage(error)}`)
      .catch(() => undefined);
  } finally {
    if (!handoffStarted && reactionAck) {
      const ack = reactionAck;
      reactionAck = undefined;
      backgroundWaitUntil(input.reactions.complete(ack));
    }
    if (!handoffStarted) releaseExecutionSlot?.();
  }
}
type ProactiveLayer = "mentioned" | "rules";

async function handleProactiveMessage(
  thread: Thread<MattermostbotThreadState>,
  message: ChatMessage,
  input: {
    executionLimiter: TeamExecutionLimiter;
    options: MattermostbotOptions;
    reactions: ReactionController;
    state: StateAdapter;
  },
): Promise<void> {
  const { options, state } = input;
  const proactivity = options.proactivity;
  if (!proactivity) return;
  const rules = resolveProactivityRules(proactivity.rules, thread.id);
  const trace = proactiveTrace(thread, message);
  const record = (outcome: string, fields: JsonObject = {}): void => {
    mattermostbotMetrics.proactiveDecisions.inc({ outcome });
    traceLog(options, "mattermostbot_proactive_decision", trace, {
      outcome,
      ...fields,
    });
  };
  let threadState = (await thread.state) ?? {};
  let skipReason = proactiveSkipReason(rules, threadState, message);
  if (skipReason) {
    record(`skip_${skipReason}`);
    return;
  }

  const debounceMs =
    hasLiveActiveExecution(
      threadState,
      options.activeExecutionTtlMs ?? DEFAULT_ACTIVE_EXECUTION_TTL_MS,
    )
      ? 0
      : proactivity.debounceMs ?? 0;
  let burstIds = new Set<string>();
  if (debounceMs > 0) {
    const earlierBurstIds = await waitForProactiveBurstEnd(
      thread,
      message,
      state,
      debounceMs,
    );
    if (!earlierBurstIds) {
      record("skip_superseded");
      return;
    }
    const mention = await state.get<PendingProactiveMessage>(
      `${PROACTIVE_MENTION_KEY_PREFIX}${thread.id}`,
    );
    if (
      mention &&
      compareProactiveMessages(mention, pendingProactiveMessage(message)) > 0
    ) {
      record("skip_mentioned");
      return;
    }
    threadState = (await thread.state) ?? {};
    const forwarded = new Set(threadState.forwardedMessageIds ?? []);
    if (forwarded.has(message.id)) {
      record("skip_forwarded");
      return;
    }
    skipReason = proactiveSkipReason(rules, threadState, message);
    if (skipReason) {
      record(`skip_${skipReason}`);
      return;
    }
    burstIds = new Set(earlierBurstIds);
  }

  const layers = proactiveLayers(rules, threadState);
  const earlier = isMattermostThreadReply(message)
    ? await proactiveThreadHistory(thread, message)
    : [];
  const history = earlier
    .filter((item) => !burstIds.has(item.id))
    .map(proactiveThreadMessage);
  const burst = earlier
    .filter((item) => burstIds.has(item.id))
    .map(proactiveThreadMessage);
  const signal = AbortSignal.timeout(
    proactivity.timeoutMs ?? PROACTIVE_CLASSIFIER_TIMEOUT_MS,
  );
  const aborted = new Promise<never>((_, reject) => {
    signal.addEventListener("abort", () => reject(signal.reason), {
      once: true,
    });
  });
  const decisions = await Promise.allSettled(
    layers.map((layer) =>
      Promise.race([
        proactivity.classifier(
          {
            botName: options.userName ?? "centaur",
            ...(layer === "rules" ? { rules } : {}),
            ...(burst.length > 0 ? { burst } : {}),
            history,
            message: proactiveThreadMessage(message),
          },
          signal,
        ),
        aborted,
      ]),
    ),
  );
  const respondingLayer = layers.find((_, index) => {
    const decision = decisions[index];
    return decision?.status === "fulfilled" && decision.value.respond;
  });
  if (!respondingLayer) {
    const failure = decisions.find((decision) => decision.status === "rejected");
    record(failure ? "error" : "decline");
    return;
  }
  const rulesDecision = decisions[layers.indexOf("rules")];
  const matchedRule =
    rulesDecision?.status === "fulfilled" && rulesDecision.value.respond
      ? rules?.find((rule) => rule.name === rulesDecision.value.rule)
      : undefined;
  const releaseClaim = await claimProactiveHandoff(thread, state);
  if (!releaseClaim) {
    record("skip_claimed");
    return;
  }
  try {
    const lateState = (await thread.state) ?? {};
    const lateSkipReason = proactiveSkipReason(rules, lateState, message);
    if (lateSkipReason) {
      record(`skip_${lateSkipReason}`);
      return;
    }
    await thread.subscribe();
    record("respond", { layer: respondingLayer, rule: matchedRule?.name });
    await syncThreadMessageToSession(thread, message, {
      executionLimiter: input.executionLimiter,
      mode: "execute",
      options,
      proactive: true,
      proactiveRule: matchedRule,
      reactions: input.reactions,
      state,
    });
  } finally {
    await releaseClaim();
  }
}

function proactiveTrace(
  thread: Thread<MattermostbotThreadState>,
  message: ChatMessage,
): MattermostbotTrace {
  return {
    includeContext: false,
    messageId: message.id,
    mode: "execute",
    openStream: false,
    startedAtMs: nowMs(),
    threadId: thread.id,
  };
}

function proactiveLayers(
  rules: ProactivityRule[] | undefined,
  state: MattermostbotThreadState,
): ProactiveLayer[] {
  const layers: ProactiveLayer[] = [];
  if (state.proactiveEligible === true) layers.push("mentioned");
  if (rules !== undefined && state.proactiveEligible !== false) {
    layers.push("rules");
  }
  return layers;
}

function proactiveSkipReason(
  rules: ProactivityRule[] | undefined,
  state: MattermostbotThreadState,
  message: ChatMessage,
): string | undefined {
  if (proactiveLayers(rules, state).length === 0) return "not_eligible";
  if (!message.text.trim()) return "empty";
  return undefined;
}

function proactiveRuleContext(rule: ProactivityRule): string {
  const reason =
    `You were not mentioned. This message matched the operators' proactive reply rule "${rule.name}".`;
  return rule.context
    ? `${reason} Their instructions for responding:\n${rule.context}`
    : reason;
}

async function proactiveThreadHistory(
  thread: Thread<MattermostbotThreadState>,
  current: ChatMessage,
): Promise<ChatMessage[]> {
  const currentTimestamp = current.metadata.dateSent.getTime();
  const history: ChatMessage[] = [];
  for await (const item of thread.allMessages) {
    if (item.id === current.id) continue;
    if (item.metadata.dateSent.getTime() > currentTimestamp) continue;
    history.push(item);
  }
  history.sort((left, right) =>
    compareProactiveMessages(
      pendingProactiveMessage(left),
      pendingProactiveMessage(right),
    ),
  );
  return history.slice(-PROACTIVE_HISTORY_MESSAGES);
}

async function waitForProactiveBurstEnd(
  thread: Thread<MattermostbotThreadState>,
  message: ChatMessage,
  state: StateAdapter,
  debounceMs: number,
): Promise<string[] | undefined> {
  const pendingKey = `${PROACTIVE_PENDING_KEY_PREFIX}${thread.id}`;
  const endKey = `${PROACTIVE_BURST_END_KEY_PREFIX}${thread.id}`;
  const ttlMs = debounceMs + PROACTIVE_PENDING_GRACE_MS;
  const current = pendingProactiveMessage(message);
  await state.appendToList(pendingKey, current, {
    maxLength: PROACTIVE_PENDING_MAX,
    ttlMs,
  });
  await sleep(debounceMs);
  const pending = await state.getList<PendingProactiveMessage>(pendingKey);
  if (
    pending.some(
      (item) =>
        item &&
        compareProactiveMessages(item, current) > 0,
    )
  ) {
    return undefined;
  }
  const lastEnd = await state.get<PendingProactiveMessage>(endKey);
  if (lastEnd && compareProactiveMessages(lastEnd, current) >= 0) {
    return undefined;
  }
  await state.set(endKey, current, ttlMs);
  const oldestTimestamp = current.timestamp - ttlMs;
  return pending
    .filter(
      (item) =>
        item &&
        compareProactiveMessages(item, current) < 0 &&
        item.timestamp >= oldestTimestamp &&
        (!lastEnd || compareProactiveMessages(item, lastEnd) > 0),
    )
    .map((item) => item.id);
}

async function claimProactiveHandoff(
  thread: Thread<MattermostbotThreadState>,
  state: StateAdapter,
): Promise<(() => Promise<void>) | undefined> {
  const key = `${PROACTIVE_CLAIM_KEY_PREFIX}${thread.id}`;
  const token = randomUUID();
  const deadline = Date.now() + PROACTIVE_CLAIM_WAIT_MS;
  while (true) {
    if (await state.setIfNotExists(key, token, PROACTIVE_CLAIM_TTL_MS)) {
      return async () => {
        if ((await state.get(key)) === token) await state.delete(key);
      };
    }
    if (
      hasLiveActiveExecution(
        (await thread.state) ?? {},
        DEFAULT_ACTIVE_EXECUTION_TTL_MS,
      )
    ) {
      return async () => {};
    }
    if (Date.now() >= deadline) return undefined;
    await sleep(PROACTIVE_CLAIM_POLL_MS);
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
  reactions: ReactionController,
  reactionAck?: ReactionAck,
  trace?: MattermostbotTrace,
  onExecutionStarted?: (
    execution: MattermostbotExecuteSessionResponse,
  ) => Promise<void>,
  onSettled?: () => void,
): void {
  if (reactionAck) reactions.hold(reactionAck);
  mattermostbotMetrics.activeLiveRenders.inc();
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
          mattermostbotMetrics.executionsFailed.inc({ reason: "render_exhausted" });
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
      mattermostbotMetrics.activeLiveRenders.dec();
      await renderLease.release?.();
      backgroundWaitUntil(reactions.completeThread(thread.id));
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
        mattermostbotMetrics.forwardRetries.inc({ outcome: "exhausted" });
        throw error;
      }
      mattermostbotMetrics.forwardRetries.inc({ outcome: "scheduled" });
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
  const renderStartedAtMs = nowMs();
  let renderOutcome = "error";
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
    const footerState = input.responseFooter
      ? { value: input.responseFooter }
      : undefined;
    await renderExecutionStream(
      thread,
      streamSessionAfterHandoff(options, input, onExecutionStarted),
      message,
      options,
      isInitialExecution,
      trace,
      footerState,
    );
    rendered = true;
    renderOutcome = "complete";
    return "complete";
  } catch (error) {
    if (isRetryableSessionApiError(error)) {
      retry = true;
      renderOutcome = "retry";
      return "retry";
    }
    throw error;
  } finally {
    mattermostbotMetrics.renderAttempts.inc({
      source: "live",
      outcome: renderOutcome,
    });
    mattermostbotMetrics.renderAttemptDuration.observe(
      { source: "live", outcome: renderOutcome },
      observeSeconds(renderStartedAtMs),
    );
    if (renderOutcome === "complete") {
      mattermostbotMetrics.lastSuccessfulRenderTimestamp.set(
        { source: "live" },
        Math.floor(Date.now() / 1000),
      );
    }
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
  footerState?: { value?: string },
): Promise<void> {
  const logger = options.logger ?? noopLogger;
  const stopTyping = startMattermostTypingKeepalive(thread, logger);
  try {
    await renderSplitExecutionStreams(thread, stream, options, footerState);
  } finally {
    stopTyping();
  }
}

async function renderSplitExecutionStreams(
  thread: Thread,
  stream: AsyncIterable<MattermostbotRendererSource>,
  options: MattermostbotOptions,
  footerState?: { value?: string },
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
        answerPost = streamAnswerToThread(
          thread,
          answerText,
          options,
          footerState,
        );
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
        answerPost = streamAnswerToThread(
          thread,
          answerText,
          options,
          footerState,
        );
        answerPost.catch(() => undefined);
      }
      answerText.push("Execution completed, but no final text was captured.");
    }
    if (sourceFailed && footerState) footerState.value = undefined;
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
  footerState?: { value?: string },
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
  const lastPost: {
    value: { content: string; id: string; threadId: string } | null;
  } = { value: null };
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
      const finalized = { ...current, content };
      await editCurrent(content);
      lastPost.value = finalized;
      current = null;
      lastEditedContent = "";
    } else if (content.trim()) {
      await postNew(content);
      const posted = current as { id: string; threadId: string } | null;
      if (posted !== null) {
        lastPost.value = { id: posted.id, threadId: posted.threadId, content };
      }
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

  const footer = footerState?.value?.trim();
  if (!footer) return;
  const footerLine = `\n\n${footer}`;
  const finalPost = lastPost.value;
  if (finalPost && finalPost.content.length + footerLine.length <= maxChars) {
    const content = `${finalPost.content}${footerLine}`;
    await thread.adapter.editMessage(finalPost.threadId, finalPost.id, {
      raw: content,
    });
    finalPost.content = content;
    mattermostbotMetrics.responseFooters.inc({ placement: "inline" });
  } else {
    await thread.adapter.postMessage(thread.id, { raw: footer });
    mattermostbotMetrics.responseFooters.inc({ placement: "separate" });
  }
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
  reactions: ReactionController,
): void {
  backgroundWaitUntil(
    recoverRenderObligationsWithRetry(chat, state, options, reactions),
  );
}

async function recoverRenderObligationsWithRetry(
  chat: Chat<Record<string, Adapter>, MattermostbotThreadState>,
  state: StateAdapter,
  options: MattermostbotOptions,
  reactions: ReactionController,
): Promise<void> {
  try {
    await state.connect();
    let attempt = 0;
    while (true) {
      const deferredCount = await recoverRenderObligations(
        chat,
        state,
        options,
        reactions,
      );
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
  reactions: ReactionController,
): Promise<number> {
  const startedAtMs = nowMs();
  await chat.initialize();
  const indexedThreadIds = await state.getList<string>(
    RENDER_OBLIGATION_INDEX_KEY,
  );
  const uniqueThreadIds = Array.from(new Set(indexedThreadIds));
  let deferredCount = 0;
  let pendingCount = 0;
  for (const threadId of uniqueThreadIds) {
    try {
      const thread = chat.thread(threadId);
      const obligation = (await thread.state)?.renderObligation;
      if (!obligation) continue;
      pendingCount += 1;
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
            reactions,
            threadId,
            leasedObligation,
          )
        ) {
          deferredCount += 1;
          mattermostbotMetrics.renderRecoveryThreadEvents.inc({
            event: "deferred",
          });
        } else {
          mattermostbotMetrics.renderRecoveryThreadEvents.inc({
            event: "complete",
          });
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
      mattermostbotMetrics.renderRecoveryThreadEvents.inc({
        event: "failed",
      });
      traceLog(options, "mattermostbot_render_recovery_thread_failed", undefined, {
        error: errorMessage(error),
        thread_id: threadId,
      });
    }
  }
  const outcome = deferredCount > 0 ? "deferred" : "complete";
  mattermostbotMetrics.renderRecoveryScans.inc({ outcome });
  mattermostbotMetrics.renderRecoveryScanDuration.observe(
    { outcome },
    observeSeconds(startedAtMs),
  );
  mattermostbotMetrics.renderRecoveryObligations.set(
    { state: "indexed_threads" },
    uniqueThreadIds.length,
  );
  mattermostbotMetrics.renderRecoveryObligations.set(
    { state: "pending" },
    pendingCount,
  );
  mattermostbotMetrics.renderRecoveryObligations.set(
    { state: "deferred" },
    deferredCount,
  );
  return deferredCount;
}

async function recoverRenderObligation(
  chat: Chat<Record<string, Adapter>, MattermostbotThreadState>,
  _state: StateAdapter,
  options: MattermostbotOptions,
  reactions: ReactionController,
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
  const renderStartedAtMs = nowMs();
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
    mattermostbotMetrics.renderAttempts.inc({
      source: "recovery",
      outcome: "error",
    });
    mattermostbotMetrics.renderAttemptDuration.observe(
      { source: "recovery", outcome: "error" },
      observeSeconds(renderStartedAtMs),
    );
    await reactions.completeRecovered(threadId, obligation.message.id);
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
    const outcome = rendered ? "complete" : "error";
    mattermostbotMetrics.renderAttempts.inc({
      source: "recovery",
      outcome,
    });
    mattermostbotMetrics.renderAttemptDuration.observe(
      { source: "recovery", outcome },
      observeSeconds(renderStartedAtMs),
    );
    if (rendered) {
      mattermostbotMetrics.lastSuccessfulRenderTimestamp.set(
        { source: "recovery" },
        Math.floor(Date.now() / 1000),
      );
    }
    const latest = (await thread.state) ?? {};
    await thread.setState({
      activeExecution: false,
      activeExecutionStartedAt: null,
      lastEventId: Math.max(latest.lastEventId ?? 0, lastEventId),
      ...(rendered ? { renderObligation: null } : {}),
    });
    await reactions.completeRecovered(threadId, obligation.message.id);
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
  mattermostbotMetrics.renderObligationsIndexed.inc();
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

