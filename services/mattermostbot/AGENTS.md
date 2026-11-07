# Mattermostbot Guide

Mattermostbot is Centaur's Mattermost chat ingress. It connects to the Mattermost REST v4 API and `/api/v4/websocket` with one bot token, accepts mentions and subscribed-thread follow-ups from allowlisted teams, forwards each turn to api-rs, and renders the answer in the background into the same Mattermost thread.

## Invariants

- Run exactly one replica per bot token. Multiple websocket consumers receive the same events and execute turns twice; deploy with `replicas: 1` and `Recreate`.
- The team allowlist is fail-closed. An empty or unset `MATTERMOSTBOT_TEAM_ALLOWLIST` leaves the bot inert. Direct-message (`D`) and group-message (`G`) channels are always denied.
- The adapter's thread ID is the Centaur thread key verbatim: `mattermost:<base64url channel id>[:<base64url root post id>]`. Do not invent a second key format.
- The service ignores its own posts and ignores other bot/webhook posts unless the author ID is in `MATTERMOSTBOT_TRIGGER_BOT_ALLOWLIST`.
- `/health` is 200 only while the adapter's websocket is open. REST/API failures do not make the service appear healthy.
- Mattermost uses background post-and-edit streaming. The handler only performs the session create/append handoff, so subscribed follow-ups are appended while an execution is active instead of being dropped by the thread lock.
- Transient session create/append failures retry. Render retries are bounded; exhaustion posts an in-thread failure, clears `activeExecution`, and leaves the obligation for a later recovery.
- Render obligations are indexed in persistent state, leased per thread, and recovered at startup. Keep the state adapter persistent so subscriptions, locks, dedupe state, and render progress survive restarts.
- Long answers are split into ordered posts below `MATTERMOSTBOT_MAX_POST_CHARS` (default 16000, below Mattermost's default MaxPostSize of 16383).

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
