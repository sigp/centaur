import { createMattermostbot, type MattermostbotOptions } from "./index";
import {
  parseChannelDefaults,
} from "./channel-defaults";
import {
  createFlagMessageOverridesStrategy,
  createOpenAiMessageOverridesStrategy,
} from "./message-overrides-strategy";
import { createOpenAiProactiveClassifier } from "./proactive-classifier";
import { loadProactivityRules } from "./proactivity-rules";
import { isHarnessEnabled, parseEnabledHarnesses } from "./overrides";

const port = numberEnv("PORT", 3001);
const apiUrl = stringEnv("CENTAUR_API_URL", "http://127.0.0.1:8080");
const baseUrl = requiredEnv("MATTERMOST_BASE_URL");
const botToken = requiredEnv("MATTERMOST_BOT_TOKEN");
const apiKey = requiredEnv("MATTERMOSTBOT_API_KEY");
const postgresUrl = requiredEnv("MATTERMOSTBOT_DATABASE_URL");
const enabledHarnesses = parseEnabledHarnesses(
  optionalEnv("MATTERMOSTBOT_ENABLED_HARNESSES"),
);
const defaultHarnessType = stringEnv("MATTERMOSTBOT_DEFAULT_HARNESS", "codex");
if (!isHarnessEnabled(defaultHarnessType, enabledHarnesses)) {
  throw new Error(
    "MATTERMOSTBOT_DEFAULT_HARNESS must be enabled in MATTERMOSTBOT_ENABLED_HARNESSES",
  );
}
const messageOverridesStrategyMode = messageOverridesStrategyModeEnv(
  "MATTERMOSTBOT_MESSAGE_OVERRIDES_STRATEGY",
);
const messageOverridesStrategyApiKey =
  optionalEnv("MATTERMOSTBOT_MESSAGE_OVERRIDES_OPENAI_API_KEY") ??
  optionalEnv("OPENAI_API_KEY");

const logger = {
  debug: (message: string, data?: unknown) => log("debug", message, data),
  info: (message: string, data?: unknown) => log("info", message, data),
  warn: (message: string, data?: unknown) => log("warn", message, data),
  error: (message: string, data?: unknown) => log("error", message, data),
  child: () => logger,
};

const options: MattermostbotOptions = {
  apiKey,
  apiUrl,
  baseUrl,
  botToken,
  channelDefaults: parseChannelDefaults(
    optionalEnv("MATTERMOSTBOT_CHANNEL_DEFAULTS"),
    (reason) =>
      logger.warn("mattermostbot MATTERMOSTBOT_CHANNEL_DEFAULTS", { reason }),
  ),
  defaultHarnessType,
  enabledHarnesses,
  harnessDefaultModels: {
    ...(optionalEnv("CLAUDE_MODEL")
      ? { claudecode: optionalEnv("CLAUDE_MODEL")! }
      : {}),
    ...(optionalEnv("CODEX_MODEL")
      ? {
          codex: optionalEnv("CODEX_MODEL")!,
          nanocodex: optionalEnv("CODEX_MODEL")!,
        }
      : {}),
    ...(optionalEnv("CENTAUR_PI_MODEL")
      ? { pi: optionalEnv("CENTAUR_PI_MODEL")! }
      : {}),
    ...(optionalEnv("CENTAUR_OMP_MODEL")
      ? { omp: optionalEnv("CENTAUR_OMP_MODEL")! }
      : {}),
  },
  harnessDefaultReasoning: optionalEnv("CODEX_MODEL_REASONING_EFFORT")
    ? {
        codex: optionalEnv("CODEX_MODEL_REASONING_EFFORT")!,
        nanocodex: optionalEnv("CODEX_MODEL_REASONING_EFFORT")!,
      }
    : {},
  proactivity: createProactivityOptions(),
  messageOverridesStrategy: createMessageOverridesStrategy(),
  ackReactionEnabled: booleanEnv("MATTERMOSTBOT_ACK_REACTION_ENABLED", true),
  ackReactionName: stringEnv("MATTERMOSTBOT_ACK_REACTION", "eyes"),
  steeringReactionEnabled: booleanEnv(
    "MATTERMOSTBOT_STEERING_REACTION_ENABLED",
    false,
  ),
  steeringReactionName: stringEnv(
    "MATTERMOSTBOT_STEERING_REACTION",
    "hourglass_flowing_sand",
  ),
  idleTimeoutMs: optionalNumberEnv("SESSION_IDLE_TIMEOUT_MS"),
  logger,
  maxDurationMs: optionalNumberEnv("SESSION_MAX_DURATION_MS"),
  maxPostChars: optionalNumberEnv("MATTERMOSTBOT_MAX_POST_CHARS"),
  postgresUrl,
  stateKeyPrefix: optionalEnv("MATTERMOSTBOT_STATE_KEY_PREFIX"),
  teamAllowlist: optionalList("MATTERMOSTBOT_TEAM_ALLOWLIST"),
  triggerBotAllowlist: optionalList("MATTERMOSTBOT_TRIGGER_BOT_ALLOWLIST"),
  userName: stringEnv("MATTERMOSTBOT_USER_NAME", "centaur"),
};

const { app, chat } = createMattermostbot(options);
const server = Bun.serve({ port, fetch: app.fetch });

log("info", "mattermostbot_started", {
  api_url: apiUrl,
  port: server.port,
});

const shutdown = async (signal: string): Promise<void> => {
  log("info", "mattermostbot_shutdown_started", { signal });
  await chat.shutdown().catch((error) =>
    log("warn", "mattermostbot_chat_shutdown_failed", {
      error: error instanceof Error ? error.message : String(error),
    }),
  );
  server.stop();
  log("info", "mattermostbot_shutdown_complete", { signal });
  process.exit(0);
};
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

await chat.initialize();
function messageOverridesStrategyModeEnv(name: string): "flags" | "llm" {
  const value = optionalEnv(name)?.toLowerCase();
  if (!value) return "flags";
  if (value === "flags" || value === "llm") return value;
  throw new Error(`${name} must be "flags" or "llm"`);
}

function createMessageOverridesStrategy(): MattermostbotOptions["messageOverridesStrategy"] {
  if (messageOverridesStrategyMode !== "llm") {
    return createFlagMessageOverridesStrategy();
  }
  if (!messageOverridesStrategyApiKey) {
    return async () => ({ overrides: {} });
  }
  return createOpenAiMessageOverridesStrategy({
    apiKey: messageOverridesStrategyApiKey,
    baseUrl: optionalEnv(
      "MATTERMOSTBOT_MESSAGE_OVERRIDES_OPENAI_BASE_URL",
    ),
    logger,
    model: stringEnv("MATTERMOSTBOT_MESSAGE_OVERRIDES_MODEL", "gpt-6-luna"),
    timeoutMs: optionalNumberEnv(
      "MATTERMOSTBOT_MESSAGE_OVERRIDES_TIMEOUT_MS",
    ),
  });
}

function proactivityClassifierBackend(): string {
  return stringEnv("MATTERMOSTBOT_PROACTIVITY_CLASSIFIER", "openai").toLowerCase();
}

function createProactivityOptions(): MattermostbotOptions["proactivity"] {
  if (!booleanEnv("MATTERMOSTBOT_PROACTIVITY_ENABLED", false)) return undefined;
  return {
    classifier: createProactiveClassifier(proactivityClassifierBackend()),
    debounceMs: optionalNumberEnv("MATTERMOSTBOT_PROACTIVITY_DEBOUNCE_MS"),
    rules: proactivityRules(),
    timeoutMs: optionalNumberEnv("MATTERMOSTBOT_PROACTIVITY_TIMEOUT_MS"),
  };
}

function proactivityRules(): NonNullable<
  MattermostbotOptions["proactivity"]
>["rules"] {
  const dir = optionalEnv("MATTERMOSTBOT_PROACTIVITY_RULES_DIR");
  if (!dir) return undefined;
  try {
    return loadProactivityRules(dir);
  } catch (error) {
    // Run without any rules rather than a partial set: a missing empty
    // channel file would otherwise let the default rules apply there.
    logger.warn("mattermostbot_proactivity_rules_unreadable", {
      dir,
      error: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }
}

function createProactiveClassifier(
  backend: string,
): NonNullable<MattermostbotOptions["proactivity"]>["classifier"] {
  switch (backend) {
    case "openai": {
      const apiKey =
        optionalEnv("MATTERMOSTBOT_PROACTIVITY_OPENAI_API_KEY") ??
        optionalEnv("OPENAI_API_KEY");
      if (!apiKey) {
        throw new Error(
          "MATTERMOSTBOT_PROACTIVITY_OPENAI_API_KEY or OPENAI_API_KEY is required for the openai proactivity classifier",
        );
      }
      return createOpenAiProactiveClassifier({
        apiKey,
        baseUrl: optionalEnv("MATTERMOSTBOT_PROACTIVITY_OPENAI_BASE_URL"),
        model: stringEnv("MATTERMOSTBOT_PROACTIVITY_MODEL", "gpt-6-luna"),
      });
    }
    default:
      throw new Error(
        `MATTERMOSTBOT_PROACTIVITY_CLASSIFIER must be "openai" (got "${backend}")`,
      );
  }
}

function optionalEnv(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

function optionalList(name: string): string[] | undefined {
  const value = optionalEnv(name);
  if (!value) return undefined;
  return value
    .split(/[\s,]+/)
    .map((part) => part.trim())
    .filter(Boolean);
}

function requiredEnv(name: string): string {
  const value = optionalEnv(name);
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function stringEnv(name: string, fallback: string): string {
  return optionalEnv(name) ?? fallback;
}

function numberEnv(name: string, fallback: number): number {
  return optionalNumberEnv(name) ?? fallback;
}

function optionalNumberEnv(name: string): number | undefined {
  const value = optionalEnv(name);
  if (!value) return undefined;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}
function booleanEnv(name: string, fallback: boolean): boolean {
  const value = optionalEnv(name);
  if (!value) return fallback;
  if (["1", "true", "yes", "on"].includes(value.toLowerCase())) return true;
  if (["0", "false", "no", "off"].includes(value.toLowerCase())) return false;
  throw new Error(`${name} must be a boolean`);
}

function log(level: string, message: string, data?: unknown): void {
  console.log(
    JSON.stringify({
      level,
      service: "mattermostbot",
      timestamp: new Date().toISOString(),
      event: message,
      ...(data && typeof data === "object"
        ? (data as Record<string, unknown>)
        : {}),
    }),
  );
}
