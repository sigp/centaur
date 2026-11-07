# Mattermostbot Guide

Mattermostbot is Centaur's Mattermost chat ingress. It connects to the Mattermost REST v4 API and `/api/v4/websocket` with one bot token, accepts mentions and mention-gated subscribed-thread follow-ups from allowlisted teams, forwards each turn to api-rs, and renders the answer in the background into the same Mattermost thread.

## Invariants

- Run exactly one replica per bot token. Multiple websocket consumers receive the same events and execute turns twice; deploy with `replicas: 1` and `Recreate`.
- The team allowlist is fail-closed. An empty or unset `MATTERMOSTBOT_TEAM_ALLOWLIST` leaves the bot inert. Direct-message (`D`) and group-message (`G`) channels are always denied.
- The adapter's thread ID is the Centaur thread key verbatim: `mattermost:<base64url channel id>[:<base64url root post id>]`. Do not invent a second key format.
- The service ignores its own posts and ignores other bot/webhook posts unless the author ID is in `MATTERMOSTBOT_TRIGGER_BOT_ALLOWLIST`.
- `/health` is 200 only while the adapter's websocket is open. REST/API failures do not make the service appear healthy.
- Mattermost uses background post-and-edit streaming. The handler only performs the session create/append handoff, so mentioned follow-ups are appended while an execution is active instead of being dropped by the thread lock. Unmentioned subscribed-thread posts are ignored and collected by the next mention; the single unmentioned-message handler is the hook for the later proactive classifier.
- Transient session create/append failures retry. Render retries are bounded; exhaustion posts an in-thread failure, clears `activeExecution`, and leaves the obligation for a later recovery.
- Render obligations are indexed in persistent state, leased per thread, and recovered at startup. Keep the state adapter persistent so subscriptions, locks, dedupe state, and render progress survive restarts.
- A mentioned stop command is handled before session sync: it records
  `stopRequestedAt`/`proactiveEligible`, interrupts api-rs, and never starts a
  turn. Inline harness/model/provider/persona flags are stripped before
  persistence or execution; harness, model, and provider selections are sticky
  per thread, and a conflicting explicit harness restarts the session.
- Channel defaults are keyed by Mattermost channel ID and have lower
  precedence than thread overrides but higher precedence than deployment
  defaults. Persona selection applies only at session creation.
- Attachment authorization is origin-scoped to `MATTERMOST_BASE_URL`; never
  forward the Mattermost bot token to a foreign URL or redirect.
- Team execution slots are released on every failure before render handoff.
  History-fetch failures post an in-thread notice instead of silently wedging
  the team cap.
- Long answers are split into ordered posts below `MATTERMOSTBOT_MAX_POST_CHARS` (default 16000, below Mattermost's default MaxPostSize of 16383).
- Turn-start mentions receive an acknowledgement reaction (`eyes` by default). Mentioned follow-ups may receive the optional steering reaction (`hourglass_flowing_sand`); reactions are best-effort, removed after response/failure, and a refused kind is disabled for the process with one warning.

## Environment

| Variable | Required | Notes |
| --- | --- | --- |
| `PORT` | No | Health server port; defaults to `3001`. |
| `CENTAUR_API_URL` | No | api-rs base URL; defaults to `http://127.0.0.1:8080`. |
| `MATTERMOST_BASE_URL` | Yes | Mattermost server base URL. |
| `MATTERMOST_BOT_TOKEN` | Yes | Bot account access token. Keep secret. |
| `MATTERMOSTBOT_API_KEY` | Yes | Bearer key accepted by api-rs. Keep secret. |
| `MATTERMOSTBOT_DATABASE_URL` | Yes | PostgreSQL URL used by `@chat-adapter/state-pg`. |
| `MATTERMOSTBOT_USER_NAME` | No | Configured bot username before `/users/me`; defaults to `centaur`. |
| `MATTERMOSTBOT_DEFAULT_HARNESS` | No | New-thread harness; defaults to `codex`. |
| `MATTERMOSTBOT_ENABLED_HARNESSES` | No | Enabled harness wire values. |
| `MATTERMOSTBOT_MESSAGE_OVERRIDES_STRATEGY` | No | `flags` or `llm`; defaults to `flags`. |
| `MATTERMOSTBOT_MESSAGE_OVERRIDES_MODEL` | No | LLM decisions model; defaults to `gpt-6-luna`. |
| `MATTERMOSTBOT_MESSAGE_OVERRIDES_OPENAI_BASE_URL` | No | OpenAI-compatible decisions endpoint. |
| `MATTERMOSTBOT_MESSAGE_OVERRIDES_OPENAI_API_KEY` | No | LLM key; falls back to `OPENAI_API_KEY`. |
| `MATTERMOSTBOT_MESSAGE_OVERRIDES_TIMEOUT_MS` | No | LLM decision timeout. |
| `MATTERMOSTBOT_CHANNEL_DEFAULTS` | No | JSON channel-id to default overrides map. |
| `MATTERMOSTBOT_ACK_REACTION_ENABLED` | No | Turn-start acknowledgement; defaults to `true`. |
| `MATTERMOSTBOT_ACK_REACTION` | No | Mattermost emoji name; defaults to `eyes`. |
| `MATTERMOSTBOT_STEERING_REACTION_ENABLED` | No | Mentioned follow-up acknowledgement; defaults to `false`. |
| `MATTERMOSTBOT_STEERING_REACTION` | No | Mattermost emoji name; defaults to `hourglass_flowing_sand`. |
| `CLAUDE_MODEL`, `CODEX_MODEL` | No | Deployment model defaults. |
| `CODEX_MODEL_REASONING_EFFORT` | No | Codex/Nanocodex default reasoning. |
| `CENTAUR_PI_MODEL`, `CENTAUR_OMP_MODEL` | No | Pi/OMP deployment model defaults. |
| `MATTERMOSTBOT_TEAM_ALLOWLIST` | Yes to do anything | Comma/space-separated Mattermost team IDs. Empty means inert. |
| `MATTERMOSTBOT_TRIGGER_BOT_ALLOWLIST` | No | Comma/space-separated bot author IDs allowed to trigger or append. Empty means all bot posts are ignored. |
| `MATTERMOSTBOT_MAX_POST_CHARS` | No | Maximum answer post size; defaults to `16000`, below Mattermost's default `16383` limit. |
| `MATTERMOSTBOT_STATE_KEY_PREFIX` | No | State row prefix; defaults to `centaur-mattermostbot`. |
| `SESSION_IDLE_TIMEOUT_MS` | No | Forwarded to api-rs execute. |
| `SESSION_MAX_DURATION_MS` | No | Forwarded to api-rs execute. |

## Mattermost setup

1. In **System Console → Integrations → Bot Accounts**, create a bot account and copy its token into `MATTERMOST_BOT_TOKEN`.
2. Ensure bot accounts, the REST API, and websocket gateway are enabled.
3. Add the bot account to each channel it should serve. Mattermost websocket events are limited to channels the account can access.
4. Record the team IDs and set `MATTERMOSTBOT_TEAM_ALLOWLIST`; the service intentionally does nothing until this is set.
5. Give the bot permission to read channel history and create/edit posts.

The service does not use interactive callbacks in this version, so do not configure a callback URL or `MATTERMOST_CALLBACK_SECRET`.

## Develop and test

```bash
bun run check:types
bun run test
bun run dev
```

Docker builds use the repository root as context:

```bash
docker build -f services/mattermostbot/Dockerfile .
```
