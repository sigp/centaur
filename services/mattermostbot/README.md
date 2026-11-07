# mattermostbot

Mattermost chat ingress for the Centaur agent. The service uses Chat SDK's `chat-adapter-mattermost` WebSocket transport, forwards allowlisted mentions and subscribed-thread follow-ups to api-rs, and renders each reply in the same Mattermost thread in the background so the thread lock is released while a turn runs.

## Behavior

- A mentioned stop command (`stop`, `cancel`, `kill`, or `end`, with common
  polite variants) interrupts the api-rs execution and never starts a new turn.
- Inline flags select the harness, model, provider, persona, and per-turn
  reasoning (`--codex`, `--claude`, `--model <id>`, `--provider <id>`,
  `--persona <id>`, `-rsn <effort>`). Flags are removed from the current
  message and initial context. Harness, model, and provider choices stick to a
  thread; a conflicting explicit harness flag restarts the thread on that
  harness.
- `MATTERMOSTBOT_CHANNEL_DEFAULTS` supplies per-channel JSON defaults. A
  thread override wins over a channel default, which wins over deployment
  defaults.
- Attachment downloads send the bot token only to the configured Mattermost
  origin. History-fetch failures release the team execution slot and post an
  in-thread permission/error notice.

Run one replica per bot token. Two consumers on one Mattermost token receive the same WebSocket events and can execute a turn twice. Deploy with one replica and a `Recreate` strategy.

## Environment

| Variable | Required | Notes |
| --- | --- | --- |
| `PORT` | No | Health port; defaults to `3001`. |
| `CENTAUR_API_URL` | No | api-rs base URL; defaults to `http://127.0.0.1:8080`. |
| `MATTERMOST_BASE_URL` | Yes | Mattermost server URL. |
| `MATTERMOST_BOT_TOKEN` | Yes | Token from the Mattermost bot account. |
| `MATTERMOSTBOT_API_KEY` | Yes | Bearer key accepted by api-rs. |
| `MATTERMOSTBOT_DATABASE_URL` | Yes | PostgreSQL URL for `@chat-adapter/state-pg`. |
| `MATTERMOSTBOT_USER_NAME` | No | Username used before `/users/me`; defaults to `centaur`. |
| `MATTERMOSTBOT_DEFAULT_HARNESS` | No | Harness for new threads; defaults to `codex`. |
| `MATTERMOSTBOT_ENABLED_HARNESSES` | No | Comma-separated enabled harness wire values. |
| `MATTERMOSTBOT_MESSAGE_OVERRIDES_STRATEGY` | No | `flags` or `llm`; defaults to `flags`. |
| `MATTERMOSTBOT_MESSAGE_OVERRIDES_MODEL` | No | Decisions model for `llm`; defaults to `gpt-6-luna`. |
| `MATTERMOSTBOT_MESSAGE_OVERRIDES_OPENAI_BASE_URL` | No | OpenAI-compatible Decisions API base URL. |
| `MATTERMOSTBOT_MESSAGE_OVERRIDES_OPENAI_API_KEY` | No | Decisions API key; falls back to `OPENAI_API_KEY`. |
| `MATTERMOSTBOT_MESSAGE_OVERRIDES_TIMEOUT_MS` | No | Decisions request timeout. |
| `MATTERMOSTBOT_CHANNEL_DEFAULTS` | No | JSON map keyed by Mattermost channel id. |
| `CLAUDE_MODEL` / `CODEX_MODEL` | No | Deployment-configured default model metadata. |
| `CODEX_MODEL_REASONING_EFFORT` | No | Deployment-configured Codex/Nanocodex reasoning default. |
| `CENTAUR_PI_MODEL` / `CENTAUR_OMP_MODEL` | No | Deployment-configured Pi/OMP default model metadata. |
| `MATTERMOSTBOT_TEAM_ALLOWLIST` | Yes to do anything | Comma/space-separated team IDs. Empty means inert. |
| `MATTERMOSTBOT_TRIGGER_BOT_ALLOWLIST` | No | Comma/space-separated bot author IDs allowed to trigger or append. |
| `MATTERMOSTBOT_MAX_POST_CHARS` | No | Maximum answer post size; defaults to `16000` (below Mattermost's default `16383` limit). |
| `SESSION_IDLE_TIMEOUT_MS` | No | Forwarded to api-rs execute. |
| `SESSION_MAX_DURATION_MS` | No | Forwarded to api-rs execute. |

## Mattermost setup

1. Open **System Console → Integrations → Bot Accounts**, create a bot account, and store its token as `MATTERMOST_BOT_TOKEN`.
2. Ensure bot accounts, the REST API, and the WebSocket gateway are enabled.
3. Add the bot account to each channel it should serve and grant permission to read history and create/edit posts.
4. Record the team IDs and set `MATTERMOSTBOT_TEAM_ALLOWLIST`. The ingress intentionally ignores every event until this is set.
5. Set `MATTERMOSTBOT_API_KEY` and `MATTERMOSTBOT_DATABASE_URL` from the deployment secret store.

This version has no interactive buttons, so it does not use a callback URL or `MATTERMOST_CALLBACK_SECRET`.

## Development

```bash
bun run check:types
bun run test
bun run dev
```

The health endpoint is `GET /health`. It returns `200` only while the Mattermost WebSocket is connected, otherwise `503`.

Build from the repository root:

```bash
docker build -f services/mattermostbot/Dockerfile .
```
