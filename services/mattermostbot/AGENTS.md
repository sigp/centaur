# Mattermostbot Guide

Mattermostbot is Centaur's Mattermost chat ingress. It connects to the Mattermost REST v4 API and `/api/v4/websocket` with one bot token, accepts mentions and mention-gated subscribed-thread follow-ups from allowlisted teams, forwards each turn to api-rs, and renders the answer in the background into the same Mattermost thread.

## Invariants

- Run exactly one replica per bot token. Multiple websocket consumers receive the same events and execute turns twice; deploy with `replicas: 1` and `Recreate`.
- The team allowlist is fail-closed. An empty or unset `MATTERMOSTBOT_TEAM_ALLOWLIST` leaves the bot inert. Direct-message (`D`) and group-message (`G`) channels are always denied.
- The adapter's thread ID is the Centaur thread key verbatim: `mattermost:<base64url channel id>[:<base64url root post id>]`. Do not invent a second key format.
- The service ignores its own posts and ignores other bot/webhook posts unless the author ID is in `MATTERMOSTBOT_TRIGGER_BOT_ALLOWLIST`.
- `/health` is 200 only while the adapter's websocket is open. REST/API failures do not make the service appear healthy.
- Mattermost uses background post-and-edit streaming. The handler only performs
  the session create/append handoff, so mentioned follow-ups are appended while
  an execution is active instead of being dropped by the thread lock.

- `POST /api/mattermost/actions` accepts Mattermost interactive workflow
  actions only after validating the api-rs-signed button context, resolving the
  channel through Mattermost REST, and checking the clicked post's channel.
  Mattermost does not sign action requests; never treat the callback body alone
  as authentication. Posts fetched through REST have their action
  integrations stripped, so never send a fetched post's props back with live
  buttons in them: the click update only replaces a post whose every button
  belongs to the clicked group (ids `cw` + group hex).
- `POST /api/mattermost/commands` accepts form-encoded `/centaur` requests
  only with a configured constant-time token match. `run` is restricted to
  `MATTERMOSTBOT_SLASH_WORKFLOWS`; prompts reuse the normal mention turn flow
  with a synthetic user-authored message. A command typed in a thread's reply
  box carries that thread's `root_id`: prompts and `run` notices stay in the
  thread, and `stop` interrupts its turn through the same
  `stopThreadExecution` as a mentioned stop. Slash replies use Mattermost's
  command response (`response_type`, `text`); `ephemeral_text` belongs to
  action responses only and Mattermost ignores it on a slash command.

- Unmentioned subscribed-thread posts never reach a running turn on their own:
  the next mention collects them as context. With proactivity enabled they are
  classified once a mention makes the thread eligible, and operator rules can
  also match unmentioned top-level posts and start a reply thread. A rule's
  context rides only on the first execution it starts in a thread (again after
  a harness restart), and a stop silences proactive replies until the next
  mention.
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
- Successful execution replies may carry a trailing markdown response footer.
  `MATTERMOSTBOT_RESPONSE_METADATA_MODE` defaults to `first` and also accepts
  `always` and `never`; `MATTERMOSTBOT_RESPONSE_SERVICE_TIER_ENABLED` only
  adds the Codex tier to an otherwise-selected footer. The footer is appended
  to the last answer post only when it fits below `maxPostChars`; otherwise it
  is a separate short reply. `response-context.ts` reads defaults directly
  from `harness/claude/settings.json` and `harness/codex/config.toml`, and the
  Docker image must copy `harness/`.
- `GET /metrics` is Prometheus text on `PORT`; all series use the
  `mattermostbot_` prefix. Keep metric updates on the corresponding success,
  failure, recovery, reaction, stop, override, and websocket paths, and keep
  the registry resettable for tests.
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
| `MATTERMOSTBOT_PROACTIVITY_ENABLED` | No | Enable proactive replies; defaults to `false`. |
| `MATTERMOSTBOT_PROACTIVITY_CLASSIFIER` | No | Classifier backend; defaults to `openai`. |
| `MATTERMOSTBOT_PROACTIVITY_MODEL` | No | Decisions model; defaults to `gpt-6-luna`. |
| `MATTERMOSTBOT_PROACTIVITY_OPENAI_BASE_URL` | No | OpenAI-compatible Decisions API base URL. |
| `MATTERMOSTBOT_PROACTIVITY_OPENAI_API_KEY` | No | Decisions API key; falls back to `OPENAI_API_KEY`. |
| `MATTERMOSTBOT_PROACTIVITY_TIMEOUT_MS` | No | One decision timeout; defaults to `2000` ms. |
| `MATTERMOSTBOT_PROACTIVITY_DEBOUNCE_MS` | No | Idle-thread burst quiet period; unset means no debounce. |
| `MATTERMOSTBOT_PROACTIVITY_RULES_DIR` | No | Directory containing `default.json` and optional `<channelId>.json` rule arrays. |
| `CLAUDE_MODEL`, `CODEX_MODEL` | No | Deployment model defaults. |
| `CODEX_MODEL_REASONING_EFFORT` | No | Codex/Nanocodex default reasoning. |
| `CENTAUR_PI_MODEL`, `CENTAUR_OMP_MODEL` | No | Pi/OMP deployment model defaults. |
| `MATTERMOSTBOT_TEAM_ALLOWLIST` | Yes to do anything | Comma/space-separated Mattermost team IDs. Empty means inert. |
| `MATTERMOSTBOT_SLASH_COMMAND_TOKENS` | No | Comma/space-separated slash-command tokens. Unset or empty disables `/api/mattermost/commands`; keep secret. |
| `MATTERMOSTBOT_SLASH_WORKFLOWS` | No | Comma/space-separated workflow names allowed by `/centaur run`; empty disables `run`. |
| `MATTERMOSTBOT_TRIGGER_BOT_ALLOWLIST` | No | Comma/space-separated bot author IDs allowed to trigger or append. Empty means all bot posts are ignored. |
| `MATTERMOSTBOT_MAX_POST_CHARS` | No | Maximum answer post size; defaults to `16000`, below Mattermost's default `16383` limit. |
| `MATTERMOSTBOT_RESPONSE_METADATA_MODE` | No | Model footer mode: `first` (default), `always`, or `never`. |
| `MATTERMOSTBOT_RESPONSE_SERVICE_TIER_ENABLED` | No | Include the Codex service tier in the footer; defaults to `false`. |
| `MATTERMOSTBOT_STATE_KEY_PREFIX` | No | State row prefix; defaults to `centaur-mattermostbot`. |
| `SESSION_IDLE_TIMEOUT_MS` | No | Forwarded to api-rs execute. |
| `SESSION_MAX_DURATION_MS` | No | Forwarded to api-rs execute. |

## Mattermost setup

1. In **System Console → Integrations → Bot Accounts**, create a bot account and copy its token into `MATTERMOST_BOT_TOKEN`.
2. Ensure bot accounts, the REST API, and websocket gateway are enabled.
3. Add the bot account to each channel it should serve. Mattermost websocket events are limited to channels the account can access.
4. Record the team IDs and set `MATTERMOSTBOT_TEAM_ALLOWLIST`; the service intentionally does nothing until this is set.
5. Give the bot permission to read channel history and create/edit posts.

6. In Mattermost **Product menu → Integrations → Slash Commands**, create
   `/centaur` with `POST` and request URL
   `<publicUrl>/api/mattermost/commands`; store its token in
   `MATTERMOSTBOT_SLASH_COMMAND_TOKENS` and configure workflow names in
   `MATTERMOSTBOT_SLASH_WORKFLOWS`.

Workflow button callbacks use
`https://<host>/api/mattermost/actions`. Mattermost does not sign action
requests; api-rs signs the button context and the bot verifies the clicked post
and channel before invoking it.

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
