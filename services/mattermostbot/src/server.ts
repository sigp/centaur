import { createMattermostbot, type MattermostbotOptions } from "./index";

const port = numberEnv("PORT", 3001);
const apiUrl = stringEnv("CENTAUR_API_URL", "http://127.0.0.1:8080");
const baseUrl = requiredEnv("MATTERMOST_BASE_URL");
const botToken = requiredEnv("MATTERMOST_BOT_TOKEN");
const apiKey = requiredEnv("MATTERMOSTBOT_API_KEY");
const postgresUrl = requiredEnv("MATTERMOSTBOT_DATABASE_URL");

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
