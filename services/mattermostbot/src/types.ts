import type { RustSessionStreamEvent } from "@centaur/harness-events";
import type { CodexAppServerToChatStreamOptions } from "@centaur/rendering";
import type { Attachment, Chat, Logger, StateAdapter } from "chat";
import type { MattermostAdapter } from "chat-adapter-mattermost";
import type { Hono } from "hono";
import type { HarnessOverrides } from "./overrides";
import type { ChannelDefaults } from "./channel-defaults";

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
export type JsonObject = { [key: string]: JsonValue | undefined };

export type MattermostbotApiAuthor = {
  fullName: string;
  isBot: boolean | "unknown";
  isMe: boolean;
  userId: string;
  userName: string;
};

export type MattermostbotApiAttachment = {
  dataBase64?: string;
  dataBase64Omitted?: string;
  fetchError?: string;
  fetchMetadata?: Record<string, string>;
  height?: number;
  mimeType?: string;
  name?: string;
  size?: number;
  type: Attachment["type"];
  url?: string;
  width?: number;
};

export type MattermostbotApiMessage = {
  attachments: MattermostbotApiAttachment[];
  author: MattermostbotApiAuthor;
  id: string;
  isMention: boolean;
  raw: unknown;
  text: string;
  threadId: string;
  timestamp: string;
};

export type MattermostbotSessionMessageRole =
  | "user"
  | "assistant"
  | "system"
  | "tool";

export type MattermostbotSessionMessage = {
  client_message_id?: string;
  metadata: JsonObject;
  parts: JsonValue[];
  role: MattermostbotSessionMessageRole;
};

export type MattermostbotAppendMessagesRequest = {
  messages: MattermostbotSessionMessage[];
};

export type MattermostbotCreateSessionRequest = {
  harness_type: string;
  metadata: JsonObject;
  /** 'restart': switch the thread to harness_type if it is pinned elsewhere. */
  on_harness_conflict?: "reject" | "restart";
  /** Persona requested when the thread is created; api-rs pins the first value. */
  persona_id?: string;
};

export type MattermostbotExecuteSessionRequest = {
  idempotency_key?: string;
  idle_timeout_ms?: number;
  input_lines: string[];
  max_duration_ms?: number;
  metadata: JsonObject;
};

export type MattermostbotInterruptSessionResponse = {
  execution_id?: string;
  interrupted: boolean;
  ok: boolean;
  thread_key: string;
};

export type MessageOverridesStrategyInput = { text: string };



export type MessageOverridesStrategyResult = {
  cleanedText?: string;
  overrides: HarnessOverrides;
};

export type MessageOverridesStrategy = (
  input: MessageOverridesStrategyInput,
) => Promise<MessageOverridesStrategyResult>;
export type MattermostbotExecuteSessionResponse = {
  execution_id: string;
  ok: boolean;
  status: string;
  thread_key: string;
};

export type MattermostbotFetch = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

export type MattermostbotOptions = {
  /**
   * TTL after which a persisted `activeExecution` flag is treated as stale (a
   * crash between marking and clearing would otherwise wedge the thread
   * forever — websocket ingress has no redelivery to kick it).
   */
  activeExecutionTtlMs?: number;
  /** Edit cadence for the in-progress answer post. */
  answerEditIntervalMs?: number;
  /**
   * Retry delays for the synchronous session create/append handoff. Defaults
   * to 1000ms and 3000ms; tests may use shorter delays.
   */
  forwardRetryDelaysMs?: readonly number[];
  /** Maximum characters per Mattermost post. Defaults to 16000. */
  maxPostChars?: number;
  /** Maximum render retries after the initial attempt. Defaults to 10. */
  renderRetryMaxAttempts?: number;
  /** Initial render retry delay. Defaults to 250ms. */
  renderRetryInitialDelayMs?: number;
  /** Maximum render retry delay. Defaults to 5000ms. */
  renderRetryMaxDelayMs?: number;
  apiKey?: string;
  apiUrl: string;
  /** Mattermost server base URL, e.g. https://mattermost.example.com */
  baseUrl: string;
  channelDefaults?: ChannelDefaults;
  /** Harness for new threads when no explicit message override is given. */
  defaultHarnessType?: string;
  enabledHarnesses?: readonly string[];
  /** Deployment-configured model defaults, mirrored from harness env vars. */
  harnessDefaultModels?: Record<string, string>;
  /** Deployment-configured reasoning defaults for Codex-compatible harnesses. */
  harnessDefaultReasoning?: Record<string, string>;
  /** Strategy for resolving message-level harness/model/provider/reasoning overrides. */
  messageOverridesStrategy?: MessageOverridesStrategy;
  botToken: string;
  fetch?: MattermostbotFetch;
  idleTimeoutMs?: number;
  logger?: Logger;
  mapper?: CodexAppServerToChatStreamOptions;
  /** Per-team cap on concurrently executing runs. Default 3. */
  maxConcurrentExecutionsPerTeam?: number;
  maxDurationMs?: number;
  postgresUrl?: string;
  recoverRenderObligationsOnStart?: boolean;
  state?: StateAdapter;
  stateKeyPrefix?: string;
  /**
   * Mattermost team ids the bot serves. Fail-closed: empty/unset means the bot
   * ignores every message; DMs and group messages are always denied.
   */
  teamAllowlist?: readonly string[];
  /**
   * User ids of bot (or webhook-posting) accounts whose messages may
   * trigger/append despite being bot-authored.
   */
  triggerBotAllowlist?: readonly string[];
  userName?: string;
  /** Websocket reconnect tuning forwarded to the adapter (tests). */
  websocket?: { reconnectDelayMs?: number; maxReconnectDelayMs?: number };
};

export type Mattermostbot = {
  app: Hono;
  chat: Chat;
  adapter: MattermostAdapterWithHealth;
};

/** The Mattermost adapter plus a probe for its live websocket. */
export type MattermostAdapterWithHealth = MattermostAdapter & {
  isWebSocketConnected(): boolean;
};

export type MattermostbotThreadState = {
  activeExecution?: boolean;
  /**
   * Epoch ms when `activeExecution` was last (re)confirmed; the flag is ignored
   * once this is older than the active-execution TTL. Cleared (null) together
   * with the flag.
   */
  activeExecutionStartedAt?: number | null;
  /** Sticky per-thread harness/model/provider/persona choices. */
  harnessType?: string | null;
  model?: string | null;
  personaId?: string | null;
  provider?: string | null;
  /** Timestamp of the most recent stop command; used to suppress its run. */
  stopRequestedAt?: number | null;
  /** Set once a mention makes the thread eligible for proactive replies. */
  proactiveEligible?: boolean;
  executedMessageIds?: string[];
  forwardedMessageIds?: string[];
  historyForwarded?: boolean;
  lastEventId?: number;
  renderObligation?: MattermostbotRenderObligation | null;
};

export type MattermostbotRenderObligation = {
  afterEventId: number;
  executionId: string;
  message: MattermostbotApiMessage;
};

export type MattermostbotMessageMode = "append" | "execute";

export type MattermostbotRendererSource = RustSessionStreamEvent | JsonObject;

export type MattermostbotTrace = {
  includeContext: boolean;
  messageId: string;
  mode: MattermostbotMessageMode;
  openStream: boolean;
  startedAtMs: number;
  threadId: string;
};

export type ForwardSessionInput = {
  afterEventId: number;
  /**
   * Human-readable channel name carried in the create-session metadata as
   * `mattermost_conversation_name`; api-rs uses it as the session principal's
   * display name.
   */
  conversationName?: string;
  /** Explicit/sticky execution controls forwarded to api-rs. */
  harnessType?: string;
  metadataHarnessType?: string;
  metadataModel?: string;
  model?: string;
  personaId?: string;
  provider?: string;
  reasoning?: string;
  contextPreamble?: string;
  executionId?: string;
  executeMessage?: MattermostbotApiMessage;
  messages: MattermostbotApiMessage[];
  onEventId(eventId: number): void;
  openStream: boolean;
  threadId: string;
  trace?: MattermostbotTrace;
};

/** Minimal slice of the Mattermost adapter used to send a typing indicator. */
export type TypingCapableAdapter = {
  startTyping?(threadId: string, status?: string): Promise<void>;
};
