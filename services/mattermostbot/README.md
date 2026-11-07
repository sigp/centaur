# mattermostbot

Mattermost chat ingress for the Centaur agent. The service uses Chat SDK's `chat-adapter-mattermost` WebSocket transport, forwards allowlisted mentions and mention-gated subscribed-thread follow-ups to api-rs, and renders each reply in the same Mattermost thread in the background so the thread lock is released while a turn runs.

## Behavior

- A mentioned stop command (`stop`, `cancel`, `kill`, or `end`, with common
  polite variants) interrupts the api-rs execution and never starts a new turn.
- Mention gating: an unmentioned post in a subscribed thread does not reach the
  agent on its own; the next mention brings it in as context. With proactivity
  enabled, such a post in a thread made eligible by a mention goes to the
  classifier, and an accepted one is handled like a mentioned follow-up.
  Operator rules can also match unmentioned top-level channel posts and start a
  reply thread; the first matching rule wins, and its `context` rides only on
  the first execution it starts in a thread (again after a harness restart). A
  stop silences proactive replies until the next mention.
- Proactive decisions use the OpenAI Decisions API after the debounce quiet
  period (idle threads only). A burst is judged as one message; a mention takes
  over the burst, and classifier failures or timeouts do not reply.
- A turn-starting mention gets the configured acknowledgement reaction. A
  mentioned follow-up can get the optional steering reaction; each reaction is
  removed after the response (or a failure) is posted.
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
  in-thread error notice.
- Successful replies can end with a trailing model footer. `first` shows it on
  the first assistant reply in a thread, `always` on every reply, and `never`
  suppresses it. If the footer would exceed `MATTERMOSTBOT_MAX_POST_CHARS`, it
  is posted as a short separate reply. `GET /metrics` serves Prometheus text.

- Mattermost exposes `POST /api/mattermost/actions` for workflow button
  callbacks and `POST /api/mattermost/commands` for the `/centaur` slash
  command. Slash command workflow names are explicitly allowlisted. A command
  typed in a thread's reply box acts on that thread: prompts and `run`
  notices stay there, and `/centaur stop` interrupts its running turn.
- Action callbacks are not signed by Mattermost. Authentication comes from the
  api-rs-signed button context plus a REST lookup that binds the click to the
  requested Mattermost post and channel. Team allowlists and the existing
  direct-message/group-channel refusal apply to both routes.
- After api-rs starts the run, the clicked button row becomes "⏳ <label>:
  Processing…". Mattermost strips action integrations from posts it returns to
  clients, so the bot finds the group by its action ids (`cw` + the group's hex,
  set by `ctx.mattermost_buttons`) and rewrites the post only when no other
  button shares it; otherwise only the clicker sees the status.

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
| `CLAUDE_MODEL` / `CODEX_MODEL` | No | Deployment-configured default model metadata. |
| `CODEX_MODEL_REASONING_EFFORT` | No | Deployment-configured Codex/Nanocodex reasoning default. |
| `CENTAUR_PI_MODEL` / `CENTAUR_OMP_MODEL` | No | Deployment-configured Pi/OMP default model metadata. |
| `MATTERMOSTBOT_TEAM_ALLOWLIST` | Yes to do anything | Comma/space-separated team IDs. Empty means inert. |
| `MATTERMOSTBOT_SLASH_COMMAND_TOKENS` | No | Comma/space-separated slash-command tokens. Unset or empty disables `/api/mattermost/commands`. Keep secret. |
| `MATTERMOSTBOT_SLASH_WORKFLOWS` | No | Comma/space-separated workflow names allowed by `/centaur run`; empty disables `run`. |
| `MATTERMOSTBOT_TRIGGER_BOT_ALLOWLIST` | No | Comma/space-separated bot author IDs allowed to trigger or append. |
| `MATTERMOSTBOT_MAX_POST_CHARS` | No | Maximum answer post size; defaults to `16000` (below Mattermost's default `16383` limit). |
| `MATTERMOSTBOT_RESPONSE_METADATA_MODE` | No | Model footer mode: `first` (default), `always`, or `never`. |
| `MATTERMOSTBOT_RESPONSE_SERVICE_TIER_ENABLED` | No | Include the configured Codex service tier in the footer; defaults to `false`. |
| `MATTERMOSTBOT_STATE_KEY_PREFIX` | No | State row prefix; defaults to `centaur-mattermostbot`. |
| `SESSION_IDLE_TIMEOUT_MS` | No | Forwarded to api-rs execute. |
| `SESSION_MAX_DURATION_MS` | No | Forwarded to api-rs execute. |

## Metrics

`GET /metrics` on `PORT` returns Prometheus text. All series are always
registered and use the `mattermostbot_` prefix. Labels are listed in
parentheses; a dash means no labels:

- `mattermostbot_active_live_renders` (—)
- `mattermostbot_executions_completed_total` (—)
- `mattermostbot_executions_failed_total` (`reason`)
- `mattermostbot_executions_interrupted_total` (—)
- `mattermostbot_executions_started_total` (—)
- `mattermostbot_forward_retries_total` (`outcome`)
- `mattermostbot_info` (—)
- `mattermostbot_last_successful_render_timestamp_seconds` (`source`)
- `mattermostbot_message_override_fields_total` (`field`)
- `mattermostbot_message_overrides_total` (`outcome`)
- `mattermostbot_message_overrides_duration_seconds` (`outcome`)
- `mattermostbot_proactive_decisions_total` (`outcome`)
- `mattermostbot_reaction_kinds_disabled` (`kind`)
- `mattermostbot_reactions_total` (`kind`, `operation`, `outcome`)
- `mattermostbot_render_attempt_duration_seconds` (`source`, `outcome`)
- `mattermostbot_render_attempts_total` (`source`, `outcome`)
- `mattermostbot_render_obligations_indexed_total` (—)
- `mattermostbot_render_recovery_obligations` (`state`)
- `mattermostbot_render_recovery_scan_duration_seconds` (`outcome`)
- `mattermostbot_render_recovery_scans_total` (`outcome`)
- `mattermostbot_render_recovery_thread_events_total` (`event`)
- `mattermostbot_response_footers_total` (`placement`)
- `mattermostbot_session_api_operation_duration_seconds` (`operation`, `outcome`)
- `mattermostbot_session_api_operations_total` (`operation`, `outcome`)
- `mattermostbot_session_event_stream_closures_total` (`reason`)
- `mattermostbot_session_event_streams_open` (—)
- `mattermostbot_stop_commands_total` (`outcome`)
- `mattermostbot_slash_commands_total` (`subcommand`, `outcome`)
- `mattermostbot_workflow_actions_total` (`outcome`)
- `mattermostbot_websocket_connected` (—)

## Mattermost setup

1. Open **System Console → Integrations → Bot Accounts**, create a bot account, and store its token as `MATTERMOST_BOT_TOKEN`.
2. Ensure bot accounts, the REST API, and the WebSocket gateway are enabled.
3. Add the bot account to each channel it should serve and grant permission to read history and create/edit posts.
4. Record the team IDs and set `MATTERMOSTBOT_TEAM_ALLOWLIST`. The ingress intentionally ignores every event until this is set.
5. Set `MATTERMOSTBOT_API_KEY` and `MATTERMOSTBOT_DATABASE_URL` from the deployment secret store.

6. Under **Product menu → Integrations → Slash Commands**, create `/centaur`
   with method `POST` and request URL
   `<publicUrl>/api/mattermost/commands`; put the generated token in
   `MATTERMOSTBOT_SLASH_COMMAND_TOKENS` and list permitted workflows in
   `MATTERMOSTBOT_SLASH_WORKFLOWS`.

Workflow buttons use the public
`https://<host>/api/mattermost/actions` URL. Mattermost does not sign action
requests, so the bot relies on the api-rs-signed button context and verifies the
clicked post belongs to the authorized channel before invoking a workflow.

## Development

```bash
bun run check:types
bun run test
bun run dev
```

The health endpoint is `GET /health`. It returns `200` only while the Mattermost WebSocket is connected, otherwise `503`. Prometheus scrapes `GET /metrics` on the same port.

Build from the repository root:

```bash
docker build -f services/mattermostbot/Dockerfile .
```
