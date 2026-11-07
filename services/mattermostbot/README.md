# mattermostbot

Mattermost chat ingress for the Centaur agent. The service uses Chat SDK's `chat-adapter-mattermost` WebSocket transport, forwards allowlisted mentions and subscribed-thread follow-ups to api-rs, and renders each reply in the same Mattermost thread in the background so the thread lock is released while a turn runs.

## Behavior

- A Mattermost `@centaur` mention in an allowlisted public or private team channel starts or selects a thread.
- Follow-ups in a subscribed thread append to the same Centaur session, including while an execution is active; a new mention starts another execution when no live execution is running.
- Session create/append handoffs retry transient api-rs failures. Render retries are bounded; exhaustion posts an in-thread failure and clears the live execution flag while retaining the obligation for restart recovery.
- Render obligations are indexed in persistent state and recovered on startup, so a pod restart can finish an in-flight reply and clear `activeExecution`.
- Thread keys are the adapter IDs verbatim: `mattermost:<base64url channel id>` or `mattermost:<base64url channel id>:<base64url root post id>`.
- The session create metadata includes `mattermost_conversation_name` from the channel display name.
- Long answers are split across ordered Mattermost posts, each no longer than `MATTERMOSTBOT_MAX_POST_CHARS`.
- Direct messages and group messages are denied. The service is inert until `MATTERMOSTBOT_TEAM_ALLOWLIST` is configured.
- Own posts are ignored. Bot/webhook posts require their author ID in `MATTERMOSTBOT_TRIGGER_BOT_ALLOWLIST`.

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
