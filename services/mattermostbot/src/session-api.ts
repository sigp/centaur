import type { RustSessionStreamEvent } from "@centaur/harness-events";
import { isRetryableCodexErrorNotification } from "@centaur/rendering";
import type { Attachment, Message } from "chat";
import type {
  MattermostbotApiAttachment,
  MattermostbotApiMessage,
  MattermostbotAppendMessagesRequest,
  MattermostbotCreateSessionRequest,
  MattermostbotExecuteSessionRequest,
  MattermostbotExecuteSessionResponse,
  MattermostbotFetch,
  MattermostbotInterruptSessionResponse,
  MattermostbotOptions,
  MattermostbotRendererSource,
  MattermostbotSessionMessage,
  ForwardSessionInput,
  JsonObject,
  JsonValue,
} from "./types";
import { extractMessageOverrides, extractPersonaOverride } from "./overrides";
import {
  elapsedMs,
  isJsonObject,
  noopLogger,
  nowMs,
  stringValue,
  toAsyncIterable,
  traceLog,
} from "./utils";

import { mattermostbotMetrics, observeSeconds } from "./metrics";
export class SessionApiError extends Error {
  readonly action: string;
  readonly body: string;
  readonly retryable: boolean;
  readonly status: number;
  readonly statusText: string;

  constructor(input: {
    action: string;
    body: string;
    retryable: boolean;
    status: number;
    statusText: string;
  }) {
    // api-rs error bodies can carry internals; keep them out of the message,
    // which is surfaced verbatim into the user-facing Mattermost thread.
    super(
      `Centaur session ${input.action} failed: ${input.status} ${input.statusText}`,
    );
    this.name = "SessionApiError";
    this.action = input.action;
    this.body = input.body;
    this.retryable = input.retryable;
    this.status = input.status;
    this.statusText = input.statusText;
  }
}

export function isRetryableSessionApiError(error: unknown): boolean {
  if (error instanceof SessionApiError) return error.retryable;
  if (!(error instanceof Error)) return false;
  return error.name === "AbortError" || error.name === "TypeError";
}

export function isSessionPrincipalAdmissionDenied(error: unknown): boolean {
  if (!(error instanceof SessionApiError) || error.status !== 403) return false;
  try {
    const body: unknown = JSON.parse(error.body);
    return isJsonObject(body) && body.code === "session_principal_not_preapproved";
  } catch {
    return false;
  }
}
type ForwardSessionApiCallbacks = {
  onExecutionStarted?(
    execution: MattermostbotExecuteSessionResponse,
  ): Promise<void>;
  onMessagesAppended?(): Promise<void>;
  onSessionCreated?(outcome: CreateSessionOutcome): Promise<void>;
  shouldExecute?(): Promise<boolean>;
};

type SessionApiOperation = {
  action: string;
  operation: string;
};

async function recordSessionApiOperation<T>(
  options: MattermostbotOptions,
  input: SessionApiOperation,
  operation: () => Promise<T>,
): Promise<T> {
  const startedAtMs = nowMs();
  let outcome = "success";
  try {
    return await operation();
  } catch (error) {
    outcome = isRetryableSessionApiError(error)
      ? "retryable_error"
      : "error";
    if (input.operation === "execute_session") {
      mattermostbotMetrics.executionsFailed.inc({ reason: "execute_request" });
    }
    throw error;
  } finally {
    mattermostbotMetrics.sessionApiOperations.inc({
      operation: input.operation,
      outcome,
    });
    mattermostbotMetrics.sessionApiOperationDuration.observe(
      { operation: input.operation, outcome },
      observeSeconds(startedAtMs),
    );
  }
}

export async function collectInitialContext(
  thread: { allMessages: AsyncIterable<Message> },
  currentMessage: Message,
  options?: MattermostbotOptions,
): Promise<MattermostbotApiMessage[]> {
  const messages: Message[] = [];
  try {
    for await (const message of thread.allMessages) {
      messages.push(message);
    }
  } catch (error) {
    if (
      error instanceof Error &&
      (error.name === "ResourceNotFoundError" ||
        /not found|not available/i.test(error.message))
    ) {
      return [await serializeMessage(currentMessage, options)];
    }
    throw error;
  }

  const currentIndex = messages.findIndex(
    (message) => message.id === currentMessage.id,
  );
  if (currentIndex >= 0) {
    messages[currentIndex] = currentMessage;
  } else {
    messages.push(currentMessage);
  }

  const serialized: MattermostbotApiMessage[] = [];
  for (const message of messages) {
    const item = await serializeMessage(message, options);
    // A replayed history item may predate inline directives. Strip flags
    // before any context or stored message reaches api-rs.
    item.text = stripInlineDirectiveText(item.text);
    serialized.push(item);
  }
  return serialized;
}

/**
 * Refreshes a mentioned thread with posts that arrived since the last
 * forwarded message. Mattermost history includes the bot's rendered replies;
 * those are already assistant turns in api-rs and must not be appended again.
 */
export async function collectMentionContext(
  thread: { allMessages: AsyncIterable<Message> },
  currentMessage: Message,
  options?: MattermostbotOptions,
): Promise<MattermostbotApiMessage[]> {
  const messages = await collectInitialContext(thread, currentMessage, options);
  const currentTime = currentMessage.metadata.dateSent.getTime();
  return messages.filter((message) => {
    if (message.id === currentMessage.id) return true;
    if (message.author.isMe) return false;
    const messageTime = Date.parse(message.timestamp);
    return !Number.isFinite(messageTime) || messageTime <= currentTime;
  });
}

function stripInlineDirectiveText(text: string): string {
  const persona = extractPersonaOverride(text);
  return extractMessageOverrides(persona.cleanedText).cleanedText;
}


// Messages without text or attachments would fabricate a synthetic "continue"
// turn when executed. Callers skip such events.
export function isContentlessApiMessage(
  message: MattermostbotApiMessage,
): boolean {
  return message.text.trim() === "" && message.attachments.length === 0;
}

export async function serializeMessage(
  message: Message,
  options?: MattermostbotOptions,
): Promise<MattermostbotApiMessage> {
  const attachments: MattermostbotApiAttachment[] = [];
  for (const attachment of message.attachments) {
    attachments.push(
      await serializeAttachment(
        attachment,
        options?.fetch ?? fetch,
        options
          ? { baseUrl: options.baseUrl, botToken: options.botToken }
          : undefined,
      ),
    );
  }

  return {
    attachments,
    author: {
      fullName: message.author.fullName,
      isBot: message.author.isBot,
      isMe: message.author.isMe,
      userId: message.author.userId,
      userName: message.author.userName,
    },
    id: message.id,
    isMention: message.isMention === true,
    raw: message.raw,
    text: message.text,
    threadId: message.threadId,
    timestamp: message.metadata.dateSent.toISOString(),
  };
}

// Create/append and execute are deliberately separate: the websocket ingress
// records the session first, then starts execution after the handoff succeeds.
export async function forwardToSessionApi(
  options: MattermostbotOptions,
  input: ForwardSessionInput,
  callbacks: ForwardSessionApiCallbacks = {},
): Promise<AsyncIterable<MattermostbotRendererSource> | null> {
  const createStartedAtMs = nowMs();
  const created = await recordSessionApiOperation(
    options,
    { action: "create session", operation: "create_session" },
    () =>
      createSession(
        options,
        input.threadId,
        input.harnessType,
        input.personaId,
        input.conversationName,
      ),
  );
  if (created.harnessType) input.metadataHarnessType = created.harnessType;
  traceLog(options, "mattermostbot_session_create_complete", input.trace, {
    harness_type: created.harnessType,
    harness_switched: created.harnessSwitched,
    persona_id: created.personaId,
    unavailable_requested_persona_id: created.unavailableRequestedPersonaId,
    phase_ms: elapsedMs(createStartedAtMs),
  });
  await callbacks.onSessionCreated?.(created);
  if (input.messages.length > 0) {
    const appendStartedAtMs = nowMs();
    await recordSessionApiOperation(
      options,
      { action: "append session messages", operation: "append_messages" },
      () => appendSessionMessages(options, input.threadId, input.messages),
    );
    traceLog(options, "mattermostbot_session_append_complete", input.trace, {
      message_count: input.messages.length,
      phase_ms: elapsedMs(appendStartedAtMs),
    });
    await callbacks.onMessagesAppended?.();
  } else {
    traceLog(options, "mattermostbot_session_append_skipped", input.trace, {
      message_count: 0,
    });
  }
  if (!input.executeMessage) return null;
  if (callbacks.shouldExecute && !(await callbacks.shouldExecute())) return null;
  const executeStartedAtMs = nowMs();
  const execution = await recordSessionApiOperation(
    options,
    { action: "execute session", operation: "execute_session" },
    () =>
      executeSession(
        options,
        input.threadId,
        input.executeMessage!,
        input.model,
        input.reasoning,
        input.provider,
        input.metadataModel,
        input.metadataHarnessType,
        input.contextPreamble,
        input.proactiveContext,
      ),
  );
  mattermostbotMetrics.executionsStarted.inc();
  traceLog(options, "mattermostbot_session_execute_complete", input.trace, {
    execution_id: execution.execution_id,
    phase_ms: elapsedMs(executeStartedAtMs),
  });
  await callbacks.onExecutionStarted?.(execution);
  if (!input.openStream) return null;

  return openSessionEventStream(options, input);
}

/**
 * Execute the session turn on its own (start the agent run), returning the
 * execution. Split out of forwardToSessionApi so the render stream can run it
 * AFTER the 👀 working reaction lands — the execute call blocks on cold
 * sandbox spin-up. Idempotent via the request's idempotency_key, so a render
 * retry won't re-spawn the sandbox.
 */
export async function executeSessionTurn(
  options: MattermostbotOptions,
  input: ForwardSessionInput,
): Promise<MattermostbotExecuteSessionResponse | null> {
  if (!input.executeMessage) return null;
  const executeStartedAtMs = nowMs();
  const execution = await recordSessionApiOperation(
    options,
    { action: "execute session", operation: "execute_session" },
    () =>
      executeSession(
        options,
        input.threadId,
        input.executeMessage!,
        input.model,
        input.reasoning,
        input.provider,
        input.metadataModel,
        input.metadataHarnessType,
        input.contextPreamble,
        input.proactiveContext,
      ),
  );
  mattermostbotMetrics.executionsStarted.inc();
  traceLog(options, "mattermostbot_session_execute_complete", input.trace, {
    execution_id: execution.execution_id,
    phase_ms: elapsedMs(executeStartedAtMs),
  });
  return execution;
}

export async function interruptSessionExecution(
  options: MattermostbotOptions,
  threadId: string,
  reason: string,
): Promise<MattermostbotInterruptSessionResponse> {
  return recordSessionApiOperation(
    options,
    { action: "interrupt session", operation: "interrupt_session" },
    async () => {
      const fetchFn = options.fetch ?? fetch;
      const response = await fetchFn(
        apiSessionUrl(options.apiUrl, threadId, "interrupt"),
        {
          method: "POST",
          headers: apiHeaders(options),
          body: JSON.stringify({ reason }),
        },
      );
      await ensureApiOk(response, "interrupt session", options);
      // A stopped turn is counted once, from its session.execution_cancelled
      // event; stop_commands_total records the stop itself.
      return (await response.json()) as MattermostbotInterruptSessionResponse;
    },
  );
}
export async function openSessionEventStream(
  options: MattermostbotOptions,
  input: Pick<
    ForwardSessionInput,
    "afterEventId" | "executionId" | "onEventId" | "threadId" | "trace"
  >,
): Promise<AsyncIterable<MattermostbotRendererSource>> {
  const streamStartedAtMs = nowMs();
  const stream = await recordSessionApiOperation(
    options,
    { action: "stream events", operation: "open_event_stream" },
    () =>
      streamSessionNotifications(
        options,
        input.threadId,
        input.afterEventId,
        input.executionId,
        input.onEventId,
      ),
  );
  traceLog(options, "mattermostbot_session_events_opened", input.trace, {
    after_event_id: input.afterEventId,
    execution_id: input.executionId,
    phase_ms: elapsedMs(streamStartedAtMs),
  });
  return stream;
}

// Deliberate delta from slackbotv2 (which removed this entirely): the
// synthetic starting item primes the mapper's task state so answer deltas
// stream immediately instead of waiting out the pre-stream grace period.
export function startingStreamNotification(threadId: string): JsonObject {
  return {
    method: "item/started",
    params: {
      threadId,
      turnId: "mattermostbot-starting-turn",
      startedAtMs: Date.now(),
      item: {
        id: "mattermostbot-starting",
        memoryCitation: null,
        phase: "commentary",
        text: "",
        type: "agentMessage",
      },
    },
  };
}

export function sessionStreamError(error: unknown): RustSessionStreamEvent {
  return {
    data: { error: error instanceof Error ? error.message : String(error) },
    event: "session.stream_error",
    eventKind: "session.stream_error",
  };
}

/** Largest attachment we are willing to buffer in memory and inline as base64. */
export const MAX_INLINE_ATTACHMENT_BYTES = 100 * 1024 * 1024;

/**
 * Largest JSON codex input line we will emit. A `data:` URL inlined directly in
 * the user message blows past this for larger images, so anything bigger is
 * delivered out-of-band as `attachment.chunk` lines and referenced by a staged
 * attachment id (mirrors slackbotv2).
 */
const MAX_CODEX_INPUT_LINE_CHARS = 900 * 1024;
const STAGED_ATTACHMENT_CHUNK_CHARS = 700 * 1024;

type MattermostAttachmentAuth = {
  baseUrl: string;
  botToken: string;
};

export async function serializeAttachment(
  attachment: Attachment,
  fetchFn: MattermostbotFetch = fetch,
  auth?: MattermostAttachmentAuth,
): Promise<MattermostbotApiAttachment> {
  const serialized: MattermostbotApiAttachment = {
    fetchMetadata: attachment.fetchMetadata,
    height: attachment.height,
    mimeType: attachment.mimeType,
    name: attachment.name,
    size: attachment.size,
    type: attachment.type,
    url: attachment.url,
    width: attachment.width,
  };

  if (
    typeof attachment.size === "number" &&
    attachment.size > MAX_INLINE_ATTACHMENT_BYTES
  ) {
    serialized.fetchError = attachmentTooLargeError(attachment.size);
    return serialized;
  }

  try {
    const data =
      attachment.data ??
      (await attachment.fetchData?.()) ??
      (await fetchAttachmentData(attachment.url, fetchFn, auth));
    if (data) {
      const byteLength = Buffer.isBuffer(data)
        ? data.length
        : data instanceof Blob
          ? data.size
          : data.byteLength;
      if (byteLength > MAX_INLINE_ATTACHMENT_BYTES) {
        serialized.fetchError = attachmentTooLargeError(byteLength);
        return serialized;
      }
      serialized.dataBase64 = await bytesToBase64(data);
    }
  } catch (error) {
    serialized.fetchError =
      error instanceof Error ? error.message : String(error);
  }

  return serialized;
}

const MAX_ATTACHMENT_REDIRECTS = 5;

async function fetchAttachmentData(
  url: string | undefined,
  fetchFn: MattermostbotFetch,
  auth?: MattermostAttachmentAuth,
): Promise<Buffer | undefined> {
  if (!url) return undefined;
  let currentUrl = url;
  for (let redirect = 0; redirect <= MAX_ATTACHMENT_REDIRECTS; redirect += 1) {
    const headers: HeadersInit = {};
    if (auth && sameOrigin(currentUrl, auth.baseUrl)) {
      headers.authorization = `Bearer ${auth.botToken}`;
    }
    const response = await fetchFn(currentUrl, {
      headers,
      redirect: "manual",
    });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) {
        throw new Error(
          `failed to download attachment (${response.status} redirect without location)`,
        );
      }
      if (redirect === MAX_ATTACHMENT_REDIRECTS) {
        throw new Error("failed to download attachment (too many redirects)");
      }
      currentUrl = new URL(location, currentUrl).toString();
      continue;
    }
    if (!response.ok) {
      throw new Error(
        `failed to download attachment (${response.status} ${response.statusText})`,
      );
    }
    return Buffer.from(await response.arrayBuffer());
  }
  return undefined;
}

function sameOrigin(left: string, right: string): boolean {
  try {
    return new URL(left).origin === new URL(right).origin;
  } catch {
    return false;
  }
}

function attachmentTooLargeError(bytes: number): string {
  return `attachment too large to inline (${bytes} bytes > ${MAX_INLINE_ATTACHMENT_BYTES} byte limit)`;
}

async function bytesToBase64(
  data: Buffer | Blob | ArrayBuffer,
): Promise<string> {
  if (Buffer.isBuffer(data)) return data.toString("base64");
  const bytes = data instanceof Blob ? await data.arrayBuffer() : data;
  return Buffer.from(bytes).toString("base64");
}

type CreateSessionOutcome = {
  harnessSwitched: boolean;
  harnessType?: string;
  personaId?: string | null;
  unavailableRequestedPersonaId?: string;
  personaModel?: string;
};

async function createSession(
  options: MattermostbotOptions,
  threadId: string,
  harnessType?: string,
  personaId?: string,
  conversationName?: string,
): Promise<CreateSessionOutcome> {
  const requested =
    harnessType ?? options.defaultHarnessType ?? "codex";
  if (
    options.enabledHarnesses !== undefined &&
    !options.enabledHarnesses.includes(requested)
  ) {
    throw new Error(`Harness ${requested} is not enabled for this deployment`);
  }
  const response = await postCreateSession(
    options,
    threadId,
    requested,
    personaId,
    conversationName,
    harnessType ? "restart" : undefined,
  );
  if (response.ok) return sessionOutcomeFromResponse(response);

  const body = await response.text().catch(() => "");
  const existing =
    response.status === 409 ? existingHarnessFromConflict(body) : undefined;
  if (existing && existing !== requested) {
    const existingEnabled =
      options.enabledHarnesses === undefined ||
      options.enabledHarnesses.includes(existing);
    const retry = await postCreateSession(
      options,
      threadId,
      existingEnabled ? existing : requested,
      personaId,
      conversationName,
      existingEnabled ? undefined : "restart",
    );
    await ensureApiOk(retry, "create session", options);
    return sessionOutcomeFromResponse(retry);
  }
  throw new SessionApiError({
    action: "create session",
    body,
    retryable: isRetryableApiStatus(response.status),
    status: response.status,
    statusText: response.statusText,
  });
}

async function postCreateSession(
  options: MattermostbotOptions,
  threadId: string,
  harnessType: string,
  personaId?: string,
  conversationName?: string,
  onHarnessConflict?: "reject" | "restart",
): Promise<Response> {
  const fetchFn = options.fetch ?? fetch;
  const name = conversationName?.trim();
  const body: MattermostbotCreateSessionRequest = {
    harness_type: harnessType,
    metadata: {
      source: "mattermostbot",
      platform: "mattermost",
      thread_id: threadId,
      ...(name ? { mattermost_conversation_name: name } : {}),
    },
    ...(personaId ? { persona_id: personaId } : {}),
    ...(onHarnessConflict ? { on_harness_conflict: onHarnessConflict } : {}),
  };
  return fetchFn(apiSessionUrl(options.apiUrl, threadId), {
    method: "POST",
    headers: apiHeaders(options),
    body: JSON.stringify(body),
  });
}

async function sessionOutcomeFromResponse(
  response: Response,
): Promise<CreateSessionOutcome> {
  try {
    const payload: unknown = await response.json();
    if (!isJsonObject(payload)) return { harnessSwitched: false };
    const harnessType = stringValue(payload.harness_type);
    const personaId =
      typeof payload.persona_id === "string"
        ? payload.persona_id
        : "persona_id" in payload
          ? null
          : undefined;
    const unavailableRequestedPersonaId = stringValue(
      payload.unavailable_requested_persona_id,
    );
    const personaModel = stringValue(payload.persona_model);
    return {
      harnessSwitched: payload.harness_switched === true,
      ...(harnessType ? { harnessType } : {}),
      ...(personaId !== undefined ? { personaId } : {}),
      ...(unavailableRequestedPersonaId
        ? { unavailableRequestedPersonaId }
        : {}),
      ...(personaModel ? { personaModel } : {}),
    };
  } catch {
    return { harnessSwitched: false };
  }
}

function existingHarnessFromConflict(body: string): string | undefined {
  try {
    const payload: unknown = JSON.parse(body);
    if (isJsonObject(payload)) {
      const existing = stringValue(payload.existing_harness);
      if (existing) return existing;
    }
  } catch {
    // Fall through to the legacy error-string form.
  }
  return /already exists with harness_type ([A-Za-z0-9_-]+)/.exec(body)?.[1];
}

async function appendSessionMessages(
  options: MattermostbotOptions,
  threadId: string,
  messages: MattermostbotApiMessage[],
): Promise<void> {
  const fetchFn = options.fetch ?? fetch;
  const body: MattermostbotAppendMessagesRequest = {
    messages: messages.map(toSessionMessage),
  };
  const response = await fetchFn(
    apiSessionUrl(options.apiUrl, threadId, "messages"),
    {
      method: "POST",
      headers: apiHeaders(options),
      body: JSON.stringify(body),
    },
  );
  await ensureApiOk(response, "append session messages", options);
}

async function executeSession(
  options: MattermostbotOptions,
  threadId: string,
  message: MattermostbotApiMessage,
  model?: string,
  reasoning?: string,
  provider?: string,
  metadataModel?: string,
  metadataHarnessType?: string,
  contextPreamble?: string,
  proactiveContext?: string,
): Promise<MattermostbotExecuteSessionResponse> {
  const fetchFn = options.fetch ?? fetch;
  const recordedModel = metadataModel ?? model;
  const body: MattermostbotExecuteSessionRequest = {
    idempotency_key: message.id,
    metadata: sessionMetadata(message, {
      action: "execute",
      ...(recordedModel ? { model: recordedModel } : {}),
      ...(metadataHarnessType ? { harness_type: metadataHarnessType } : {}),
    }),
    input_lines: toCodexInputLines(
      message,
      threadId,
      model,
      reasoning,
      provider,
      contextPreamble,
      proactiveContext,
    ),
    ...(options.idleTimeoutMs === undefined
      ? {}
      : { idle_timeout_ms: options.idleTimeoutMs }),
    ...(options.maxDurationMs === undefined
      ? {}
      : { max_duration_ms: options.maxDurationMs }),
  };
  const response = await fetchFn(
    apiSessionUrl(options.apiUrl, threadId, "execute"),
    {
      method: "POST",
      headers: apiHeaders(options),
      body: JSON.stringify(body),
    },
  );
  await ensureApiOk(response, "execute session", options);
  return (await response.json()) as MattermostbotExecuteSessionResponse;
}

async function ensureApiOk(
  response: Response,
  action: string,
  options: MattermostbotOptions,
): Promise<void> {
  if (response.ok) return;
  let body = "";
  try {
    body = await response.text();
  } catch {
    body = "";
  }
  // api-rs is internal and unauthenticated; keep detailed error bodies in
  // server logs while exposing only a generic message to Mattermost users.
  if (body) {
    (options.logger ?? noopLogger).warn("mattermostbot_session_api_error", {
      action,
      status: response.status,
      status_text: response.statusText,
      body,
    });
  }
  throw new SessionApiError({
    action,
    body,
    retryable: isRetryableApiStatus(response.status),
    status: response.status,
    statusText: response.statusText,
  });
}

function isRetryableApiStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

async function streamSessionNotifications(
  options: MattermostbotOptions,
  threadId: string,
  afterEventId: number,
  executionId: string | undefined,
  onEventId: (eventId: number) => void,
): Promise<AsyncIterable<MattermostbotRendererSource>> {
  const fetchFn = options.fetch ?? fetch;
  const url = new URL(apiSessionUrl(options.apiUrl, threadId, "events"));
  url.searchParams.set("after_event_id", String(afterEventId));
  if (executionId) url.searchParams.set("execution_id", executionId);
  const response = await fetchFn(url.toString(), {
    method: "GET",
    headers: apiHeaders(options, false),
  });
  await ensureApiOk(response, "stream events", options);
  if (!response.body) return toAsyncIterable([]);
  return parseSessionEventStream(response.body, onEventId);
}

function apiSessionUrl(
  apiUrl: string,
  threadId: string,
  suffix?: "messages" | "execute" | "events" | "interrupt",
): string {
  const path = `/api/session/${encodeURIComponent(threadId)}${suffix ? `/${suffix}` : ""}`;
  return new URL(path, ensureTrailingSlash(apiUrl)).toString();
}

function ensureTrailingSlash(value: string): string {
  return value.endsWith("/") ? value : `${value}/`;
}

function apiHeaders(options: MattermostbotOptions, jsonBody = true): HeadersInit {
  const apiKey = options.apiKey ?? process.env.MATTERMOSTBOT_API_KEY;
  return {
    ...(jsonBody ? { "content-type": "application/json" } : {}),
    ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
  };
}

function toSessionMessage(
  message: MattermostbotApiMessage,
): MattermostbotSessionMessage {
  return {
    client_message_id: message.id,
    role: message.author.isMe ? "assistant" : "user",
    parts: sessionMessageParts(message),
    metadata: sessionMetadata(message),
  };
}

function sessionMessageParts(message: MattermostbotApiMessage): JsonValue[] {
  const parts: JsonValue[] = [];
  if (message.text.trim()) {
    parts.push({ type: "text", text: message.text });
  }
  for (const attachment of message.attachments) {
    parts.push(sessionAttachmentPart(attachment));
  }
  return parts.length > 0 ? parts : [{ type: "text", text: "" }];
}

function sessionAttachmentPart(attachment: MattermostbotApiAttachment): JsonObject {
  const part: JsonObject = {
    ...attachment,
    attachment_type: attachment.type,
    type: "attachment",
  };
  // Don't persist megabytes of base64 in the stored session message; the
  // executing turn delivers the bytes separately (inline or staged chunks).
  if (
    typeof attachment.dataBase64 === "string" &&
    attachment.dataBase64.length > MAX_CODEX_INPUT_LINE_CHARS
  ) {
    delete part.dataBase64;
    part.dataBase64Omitted = `${attachment.dataBase64.length} base64 chars omitted from stored session message`;
  }
  return part;
}

export function sessionMetadata(
  message: MattermostbotApiMessage,
  extra: JsonObject = {},
): JsonObject {
  return {
    source: "mattermostbot",
    platform: "mattermost",
    message_id: message.id,
    thread_id: message.threadId,
    is_mention: message.isMention,
    timestamp: message.timestamp,
    user_id: message.author.userId,
    user_name: message.author.userName,
    ...extra,
  };
}

/**
 * Build the codex input lines for an execute turn. Attachments whose inlined
 * `data:` URL would push the user-message line past `MAX_CODEX_INPUT_LINE_CHARS`
 * are streamed ahead of it as `attachment.chunk` lines and referenced by a
 * staged attachment id; everything else stays inline. Mirrors slackbotv2.
 */
export function toCodexInputLines(
  message: MattermostbotApiMessage,
  threadId: string,
  model?: string,
  reasoning?: string,
  provider?: string,
  contextPreamble?: string,
  proactiveContext?: string,
): string[] {
  const staged = new Map<MattermostbotApiAttachment, string>();
  const lines: string[] = [];
  for (const attachment of message.attachments) {
    if (!attachment.dataBase64) continue;
    const inlineLine = toCodexInputLineWithStaged(
      message,
      threadId,
      staged,
      model,
      reasoning,
      provider,
      contextPreamble,
      proactiveContext,
    );
    if (
      inlineLine.length <= MAX_CODEX_INPUT_LINE_CHARS &&
      attachment.dataBase64.length <= MAX_CODEX_INPUT_LINE_CHARS
    ) {
      continue;
    }
    const stagedAttachmentId = `att-${message.id}-${staged.size + 1}`;
    staged.set(attachment, stagedAttachmentId);
    lines.push(...stagedAttachmentInputLines(attachment, stagedAttachmentId));
  }
  lines.push(
    toCodexInputLineWithStaged(
      message,
      threadId,
      staged,
      model,
      reasoning,
      provider,
      contextPreamble,
      proactiveContext,
    ),
  );
  return lines;
}

function toCodexInputLineWithStaged(
  message: MattermostbotApiMessage,
  threadId: string,
  staged: Map<MattermostbotApiAttachment, string>,
  model?: string,
  reasoning?: string,
  provider?: string,
  contextPreamble?: string,
  proactiveContext?: string,
): string {
  const content: JsonValue[] = [];
  if (contextPreamble?.trim()) {
    content.push({ type: "text", text: contextPreamble });
  }
  if (proactiveContext?.trim()) {
    content.push({ type: "text", text: proactiveContext });
  }
  content.push(...codexInputContent(message, staged));
  return JSON.stringify({
    type: "user",
    thread_key: threadId,
    ...(model ? { model } : {}),
    ...(provider ? { provider } : {}),
    ...(reasoning ? { reasoning } : {}),
    trace_metadata: sessionMetadata(message, {
      action: "execute",
      ...(model ? { model } : {}),
      ...(provider ? { provider } : {}),
      ...(reasoning ? { reasoning } : {}),
    }),
    message: {
      role: "user",
      content,
    },
  });
}

function stagedAttachmentInputLines(
  attachment: MattermostbotApiAttachment,
  stagedAttachmentId: string,
): string[] {
  const dataBase64 = attachment.dataBase64;
  if (!dataBase64) return [];
  const lines: string[] = [];
  // Keep chunks on a base64 boundary (multiple of 4) so each decodes cleanly.
  const chunkSize =
    STAGED_ATTACHMENT_CHUNK_CHARS - (STAGED_ATTACHMENT_CHUNK_CHARS % 4);
  for (
    let offset = 0, index = 0;
    offset < dataBase64.length;
    offset += chunkSize, index += 1
  ) {
    const chunk = dataBase64.slice(offset, offset + chunkSize);
    lines.push(
      JSON.stringify({
        type: "attachment.chunk",
        attachmentId: stagedAttachmentId,
        name: attachment.name,
        mimeType: attachment.mimeType,
        attachmentType: attachment.type,
        chunkIndex: index,
        final: offset + chunkSize >= dataBase64.length,
        dataBase64: chunk,
      }),
    );
  }
  return lines;
}

function codexInputContent(
  message: MattermostbotApiMessage,
  staged: Map<MattermostbotApiAttachment, string> = new Map(),
): JsonValue[] {
  const content: JsonValue[] = [];
  if (message.text.trim()) {
    content.push({ type: "text", text: message.text });
  }
  for (const attachment of message.attachments) {
    content.push(codexAttachmentInput(attachment, staged.get(attachment)));
  }
  return content.length > 0 ? content : [{ type: "text", text: "continue" }];
}

export function codexAttachmentInput(
  attachment: MattermostbotApiAttachment,
  stagedAttachmentId?: string,
): JsonValue {
  if (stagedAttachmentId) {
    return {
      type: "attachment",
      attachment_type: attachment.type,
      stagedAttachmentId,
      name: attachment.name,
      mimeType: attachment.mimeType,
      size: attachment.size,
    };
  }
  const dataUrl =
    attachment.dataBase64 && attachment.mimeType
      ? `data:${attachment.mimeType};base64,${attachment.dataBase64}`
      : undefined;
  if (attachment.type === "image" && (dataUrl || attachment.url)) {
    return {
      type: "image",
      url: dataUrl ?? attachment.url,
      detail: "auto",
      name: attachment.name,
    };
  }
  if (attachment.dataBase64) {
    return {
      type: "attachment",
      attachment_type: attachment.type,
      dataBase64: attachment.dataBase64,
      mimeType: attachment.mimeType,
      name: attachment.name,
      size: attachment.size,
    };
  }
  return {
    type: "text",
    text: attachmentDescription(attachment),
  };
}

function attachmentDescription(attachment: MattermostbotApiAttachment): string {
  const fields = [
    `name=${attachment.name ?? "attachment"}`,
    `type=${attachment.type}`,
    attachment.mimeType ? `mime=${attachment.mimeType}` : undefined,
    attachment.url ? `url=${attachment.url}` : undefined,
    attachment.dataBase64Omitted
      ? `content=${attachment.dataBase64Omitted}`
      : undefined,
    attachment.fetchError ? `fetch_error=${attachment.fetchError}` : undefined,
  ].filter(Boolean);
  return `[Mattermost attachment: ${fields.join(" ")}]`;
}

type ParsedSessionEvent = {
  data: string;
  event?: string;
  id?: number;
};

async function* parseSessionEventStream(
  stream: ReadableStream<Uint8Array>,
  onEventId: (eventId: number) => void,
): AsyncIterable<MattermostbotRendererSource> {
  for await (const event of parseSseEvents(stream)) {
    if (typeof event.id === "number") onEventId(event.id);
    if (event.event === "session.output.line") {
      const terminalOutcome = terminalOutputOutcome(event.data);
      yield {
        data: event.data,
        event: event.event,
        eventId: event.id,
        eventKind: event.event,
      } satisfies RustSessionStreamEvent;
      if (terminalOutcome === "completed") {
        mattermostbotMetrics.executionsCompleted.inc();
      } else if (terminalOutcome === "failed") {
        mattermostbotMetrics.executionsFailed.inc({ reason: "output_line" });
      }
      if (terminalOutcome) return;
      continue;
    }
    if (event.event === "session.activity_summary") {
      yield {
        data: sessionEventData(event),
        event: event.event,
        eventId: event.id,
        eventKind: event.event,
      } satisfies RustSessionStreamEvent;
      continue;
    }
    if (
      event.event === "session.execution_failed" ||
      event.event === "session.stream_error"
    ) {
      mattermostbotMetrics.executionsFailed.inc({ reason: event.event });
      yield {
        data: { error: sessionErrorMessage(event) },
        event: event.event,
        eventId: event.id,
        eventKind: event.event,
      } satisfies RustSessionStreamEvent;
      return;
    }
    if (event.event === "session.execution_cancelled") {
      mattermostbotMetrics.executionsInterrupted.inc();
      yield {
        data: { error: sessionErrorMessage(event, "Execution cancelled") },
        event: event.event,
        eventId: event.id,
        eventKind: event.event,
      } satisfies RustSessionStreamEvent;
      return;
    }
    if (event.event === "session.execution_completed") {
      mattermostbotMetrics.executionsCompleted.inc();
      yield {
        data: sessionEventData(event),
        event: event.event,
        eventId: event.id,
        eventKind: event.event,
      } satisfies RustSessionStreamEvent;
      return;
    }
  }
}

async function* parseSseEvents(
  stream: ReadableStream<Uint8Array>,
): AsyncIterable<ParsedSessionEvent> {
  const reader = stream.getReader();
  mattermostbotMetrics.sessionEventStreamsOpen.inc();
  let reason: "cancelled" | "done" | "error" = "done";
  const decoder = new TextDecoder();
  let buffer = "";
  let eventName: string | undefined;
  let eventId: number | undefined;
  let data: string[] = [];

  // The consumer returns early on terminal events, abandoning this generator
  // at a yield point. Always release the reader and cancel the SSE response.
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        const emitted = parseSseLine(line, { data, eventId, eventName });
        data = emitted.state.data;
        eventId = emitted.state.eventId;
        eventName = emitted.state.eventName;
        if (emitted.event) yield emitted.event;
      }
    }

    buffer += decoder.decode();
    if (buffer) {
      const emitted = parseSseLine(buffer, { data, eventId, eventName });
      data = emitted.state.data;
      eventId = emitted.state.eventId;
      eventName = emitted.state.eventName;
      if (emitted.event) yield emitted.event;
    }
    if (data.length > 0) {
      yield { data: data.join("\n"), event: eventName, id: eventId };
    }
  } catch (error) {
    reason = "error";
    throw error;
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
    mattermostbotMetrics.sessionEventStreamsOpen.dec();
    mattermostbotMetrics.sessionEventStreamClosures.inc({ reason });
  }
}

function parseSseLine(
  line: string,
  state: {
    data: string[];
    eventId?: number;
    eventName?: string;
  },
): {
  event?: ParsedSessionEvent;
  state: { data: string[]; eventId?: number; eventName?: string };
} {
  if (!line.trim()) {
    const event =
      state.data.length > 0
        ? {
            data: state.data.join("\n"),
            event: state.eventName,
            id: state.eventId,
          }
        : undefined;
    return { event, state: { data: [] } };
  }
  if (line.startsWith(":")) return { state };

  const separator = line.indexOf(":");
  const field = separator >= 0 ? line.slice(0, separator) : line;
  const value =
    separator >= 0 ? line.slice(separator + 1).replace(/^ /, "") : "";
  if (field === "event") return { state: { ...state, eventName: value } };
  if (field === "id") {
    const id = Number.parseInt(value, 10);
    return {
      state: { ...state, eventId: Number.isFinite(id) ? id : undefined },
    };
  }
  if (field === "data" && value !== "[DONE]") {
    return { state: { ...state, data: [...state.data, value] } };
  }

  return { state };
}

function terminalOutputOutcome(
  line: string,
): "completed" | "failed" | undefined {
  let payload: unknown;
  try {
    payload = JSON.parse(line);
  } catch {
    // Non-JSON stdout lines (e.g. sandbox bootstrap notices) are noise, not a
    // signal that the turn finished; treating them as terminal drops the answer.
    return undefined;
  }
  if (!isJsonObject(payload) || isRetryableCodexErrorNotification(payload)) {
    return undefined;
  }
  if (payload.type === "turn.failed" || payload.method === "error") {
    return "failed";
  }
  if (
    payload.type === "turn.completed" ||
    payload.type === "turn.done" ||
    payload.method === "turn/completed"
  ) {
    return "completed";
  }
  return undefined;
}

function sessionEventData(event: ParsedSessionEvent): unknown {
  try {
    return JSON.parse(event.data);
  } catch {
    return event.data;
  }
}

function sessionErrorMessage(
  event: ParsedSessionEvent,
  fallback?: string,
): string {
  let message = fallback ?? `${event.event ?? "session error"}`;
  try {
    const payload = JSON.parse(event.data);
    if (isJsonObject(payload)) {
      message =
        stringValue(payload.error) ?? stringValue(payload.message) ?? message;
    }
  } catch {
    if (event.data.trim()) message = event.data.trim();
  }
  return message;
}
