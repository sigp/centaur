import { afterEach, describe, expect, it } from "bun:test";
import { createMemoryState } from "@chat-adapter/state-memory";
import { type Hono } from "hono";
import {
  clearMattermostChannelCacheForTests,
  createMattermostbot,
} from "../src/index";
import { encodeMattermostThreadKey } from "../src/mattermost-allowlist";

const CHANNEL_ID = "channelallowed";
const POST_ID = "post-1";
const MIXED_POST_ID = "post-mixed";
const TEAM_ID = "team-allowed";
const GROUP_ID = "123e4567-e89b-12d3-a456-426614174000";
const GROUP_ACTION_PREFIX = `cw${GROUP_ID.replaceAll("-", "")}`;
const BOT_ID = "bot-id";

type FakePost = {
  id: string;
  channel_id: string;
  user_id: string;
  message: string;
  props?: Record<string, unknown>;
  create_at: number;
  root_id: string;
};

type WorkflowHarness = {
  actionStatus: number;
  actionCreated: boolean;
  actionInvocations: Record<string, unknown>[];
  channelType: string;
  edits: Record<string, unknown>[];
  executePaths: string[];
  executes: Record<string, unknown>[];
  interruptResult: boolean;
  interrupts: { body: Record<string, unknown>; path: string }[];
  posts: Record<string, unknown>[];
  runStatus: number;
  runResponses: Record<string, unknown>[];
  runs: Record<string, unknown>[];
  sessionAppends: Record<string, unknown>[];
  sessionCreates: Record<string, unknown>[];
  app: Hono;
  close(): void;
};

async function startHarness(
  config: { slashTokens?: readonly string[] } = {},
): Promise<WorkflowHarness> {

  const stored = new Map<string, FakePost>([
    [
      POST_ID,
      {
        id: POST_ID,
        channel_id: CHANNEL_ID,
        user_id: "user-1",
        message: "Choose",
        // As Mattermost returns posts to clients: action integrations stripped.
        props: {
          attachments: [
            {
              text: "Choose",
              actions: [
                { id: `${GROUP_ACTION_PREFIX}0`, name: "Run" },
                { id: `${GROUP_ACTION_PREFIX}1`, name: "Other" },
              ],
            },
          ],
        },
        create_at: Date.now(),
        root_id: "",
      },
    ],
    [
      MIXED_POST_ID,
      {
        id: MIXED_POST_ID,
        channel_id: CHANNEL_ID,
        user_id: "user-1",
        message: "Choose",
        props: {
          attachments: [
            { text: "Choose", actions: [{ id: `${GROUP_ACTION_PREFIX}0`, name: "Run" }] },
            { text: "Elsewhere", actions: [{ id: `cw${"f".repeat(32)}0`, name: "Different" }] },
          ],
        },
        create_at: Date.now(),
        root_id: "",
      },
    ],
  ]);
  let nextPost = 1;
  const harness = {
    actionStatus: 200,
    actionCreated: true,
    actionInvocations: [],
    channelType: "O",
    edits: [],
    executePaths: [],
    executes: [],
    interruptResult: true,
    interrupts: [],
    posts: [],
    runStatus: 200,
    runResponses: [{ run_id: "run-1" }],
    runs: [],
    sessionAppends: [],
    sessionCreates: [],
  } as unknown as WorkflowHarness;
  const server = Bun.serve({
    port: 0,
    fetch: async (request) => {
      const url = new URL(request.url);
      if (url.pathname === `/api/v4/channels/${CHANNEL_ID}`) {
        return Response.json({
          id: CHANNEL_ID,
          name: "ops",
          display_name: "Ops",
          team_id: TEAM_ID,
          type: harness.channelType,
        });
      }
      const postMatch = url.pathname.match(/^\/api\/v4\/posts\/([^/]+)$/);
      if (postMatch && request.method === "GET") {
        const post = stored.get(postMatch[1]!);
        return post ? Response.json(post) : new Response("not found", { status: 404 });
      }
      if (postMatch && request.method === "PUT") {
        const body = await request.json() as Record<string, unknown>;
        harness.edits.push(body);
        const old = stored.get(postMatch[1]!);
        if (old) stored.set(postMatch[1]!, { ...old, ...body });
        return Response.json(stored.get(postMatch[1]!) ?? body);
      }
      if (url.pathname === "/api/v4/posts" && request.method === "POST") {
        const body = await request.json() as Record<string, unknown>;
        const post: FakePost = {
          channel_id: String(body.channel_id),
          create_at: Date.now(),
          id: `root-${nextPost++}`,
          message: String(body.message),
          root_id: typeof body.root_id === "string" ? body.root_id : "",
          user_id: BOT_ID,
        };
        stored.set(post.id, post);
        harness.posts.push(body);
        return Response.json(post);
      }
      const threadMatch = url.pathname.match(/^\/api\/v4\/posts\/([^/]+)\/thread$/);
      if (threadMatch) {
        const root = stored.get(threadMatch[1]!);
        return Response.json({
          order: root ? [root.id] : [],
          posts: root ? { [root.id]: root } : {},
        });
      }
      if (url.pathname === "/api/workflows/actions/invoke") {
        harness.actionInvocations.push(await request.json() as Record<string, unknown>);
        if (harness.actionStatus !== 200) return new Response("unavailable", { status: harness.actionStatus });
        return Response.json({ created: harness.actionCreated, run_id: "run-button" });
      }
      if (url.pathname === "/api/workflows/runs") {
        harness.runs.push(await request.json() as Record<string, unknown>);
        if (harness.runStatus !== 200) return new Response("failed", { status: harness.runStatus });
        return Response.json(harness.runResponses.shift() ?? { run_id: "run-1" });
      }
      if (url.pathname === "/api/v4/users/user-1") {
        return Response.json({ id: "user-1", username: "alice", is_bot: false });
      }
      if (url.pathname.startsWith("/api/session/")) {
        if (request.method === "POST" && url.pathname.endsWith("/messages")) {
          harness.sessionAppends.push(await request.json() as Record<string, unknown>);
          return Response.json({ ok: true });
        }
        if (request.method === "POST" && url.pathname.endsWith("/execute")) {
          harness.executePaths.push(decodeURIComponent(url.pathname));
          harness.executes.push(await request.json() as Record<string, unknown>);
          return Response.json({ execution_id: "exec-1", ok: true, status: "running" });
        }
        if (request.method === "POST" && url.pathname.endsWith("/interrupt")) {
          harness.interrupts.push({
            body: await request.json() as Record<string, unknown>,
            path: decodeURIComponent(url.pathname),
          });
          return Response.json({
            execution_id: harness.interruptResult ? "exec-1" : null,
            interrupted: harness.interruptResult,
            ok: true,
          });
        }
        if (request.method === "GET" && url.pathname.endsWith("/events")) {
          return new Response("", { headers: { "content-type": "text/event-stream" } });
        }
        if (request.method === "POST") {
          harness.sessionCreates.push(await request.json() as Record<string, unknown>);
          return Response.json({ ok: true });
        }
        return Response.json({ ok: true });
      }
      return new Response("not found", { status: 404 });
    },
  });
  const state = createMemoryState();
  await state.connect();
  const bot = createMattermostbot({
    apiKey: "api-key",
    apiUrl: `http://127.0.0.1:${server.port}`,
    baseUrl: `http://127.0.0.1:${server.port}`,
    botToken: "bot-token",
    recoverRenderObligationsOnStart: false,
    slashCommandTokens: config.slashTokens ?? ["slash-token"],
    slashWorkflows: ["deploy"],
    state,
    teamAllowlist: [TEAM_ID],
    userName: "centaur",
  });
  harness.app = bot.app;
  harness.close = () => {
    void bot.chat.shutdown().catch(() => undefined);
    server.stop(true);
  };
  return harness;
}

function actionRequest(overrides: Record<string, unknown> = {}): Request {
  return new Request("http://bot.test/api/mattermost/actions", {
    body: JSON.stringify({
      channel_id: CHANNEL_ID,
      context: {
        button: "v1.signed",
        centaur_workflow_action: `centaur.workflow.action:${GROUP_ID}:run`,
        label: "Run",
      },
      post_id: POST_ID,
      team_id: TEAM_ID,
      trigger_id: "trigger-1",
      user_id: "user-1",
      user_name: "alice",
      ...overrides,
    }),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
}

function commandRequest(text: string, overrides: Record<string, string> = {}): Request {
  const body = new URLSearchParams({
    channel_id: CHANNEL_ID,
    team_id: TEAM_ID,
    text,
    token: "slash-token",
    trigger_id: "trigger-1",
    user_id: "user-1",
    user_name: "alice",
    ...overrides,
  });
  return new Request("http://bot.test/api/mattermost/commands", {
    body,
    headers: { "content-type": "application/x-www-form-urlencoded" },
    method: "POST",
  });
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 1_000,
): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started >= timeoutMs) throw new Error("timed out waiting");
    await Bun.sleep(5);
  }
}

let harness: WorkflowHarness | undefined;
afterEach(() => {
  clearMattermostChannelCacheForTests();
  harness?.close();
  harness = undefined;
});

describe("Mattermost workflow routes", () => {
  it("invokes a signed action and returns a processing update", async () => {
    harness = await startHarness();
    const response = await harness.app.fetch(actionRequest());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      update: {
        message: "Choose",
        props: { attachments: [{ text: "Choose\n⏳ Run: Processing…" }] },
      },
    });
    expect(harness.actionInvocations).toHaveLength(1);
    expect(harness.actionInvocations[0]).toMatchObject({
      platform: "mattermost",
      button: "v1.signed",
      click: {
        action: "run",
        channel_id: CHANNEL_ID,
        id: GROUP_ID,
        post_id: POST_ID,
        team_id: TEAM_ID,
        trigger_id: "trigger-1",
        user_id: "user-1",
        user_name: "alice",
      },
    });
    expect(harness.actionInvocations[0]?.idempotency_key).toMatch(/^mattermost\.button:[0-9a-f]{64}$/);
  });

  it("leaves a post alone when another button shares it", async () => {
    harness = await startHarness();
    // Echoing the stripped copy back would kill the other group's button.
    const response = await harness.app.fetch(actionRequest({ post_id: MIXED_POST_ID }));
    expect(await response.json()).toEqual({ ephemeral_text: "⏳ Run: Processing…" });
    expect(harness.actionInvocations).toHaveLength(1);
  });

  it("rejects duplicate and unavailable actions", async () => {
    harness = await startHarness();
    harness.actionCreated = false;
    expect(await (await harness.app.fetch(actionRequest())).json()).toEqual({
      ephemeral_text: "This action is already being processed.",
    });
    harness.actionCreated = true;
    harness.actionStatus = 403;
    expect(await (await harness.app.fetch(actionRequest())).json()).toEqual({
      ephemeral_text: "This request is no longer available.",
    });
  });

  it("refuses malformed, mismatched, unallowlisted, and DM actions", async () => {
    harness = await startHarness();
    expect((await harness.app.fetch(actionRequest({ context: {} }))).status).toBe(400);
    expect(await (await harness.app.fetch(actionRequest({ post_id: "missing" }))).json()).toEqual({
      ephemeral_text: "This request is no longer available.",
    });
    expect(await (await harness.app.fetch(actionRequest({ team_id: "other-team" }))).json()).toEqual({
      ephemeral_text: "This request is no longer available.",
    });
    harness.channelType = "D";
    clearMattermostChannelCacheForTests();
    expect(await (await harness.app.fetch(actionRequest())).json()).toEqual({
      ephemeral_text: "This request is no longer available.",
    });
  });

  it("checks slash tokens and serves help and stop", async () => {
    harness = await startHarness();
    expect((await harness.app.fetch(commandRequest("help", { token: "wrong" }))).status).toBe(401);
    expect(await (await harness.app.fetch(commandRequest("help"))).json()).toEqual({
      response_type: "ephemeral",
      text: "Usage: `/centaur run <workflow> [JSON]`, `/centaur stop` inside a thread, or type a prompt.",
    });
    expect(await (await harness.app.fetch(commandRequest("stop"))).json()).toEqual({
      response_type: "ephemeral",
      text: "Run `/centaur stop` inside the thread you want to stop.",
    });
    expect(harness.interrupts).toEqual([]);
  });

  it("stops the turn of the thread /centaur stop is typed in", async () => {
    harness = await startHarness();
    const stop = await harness.app.fetch(commandRequest("stop", { root_id: POST_ID }));
    expect(await stop.json()).toEqual({
      response_type: "ephemeral",
      text: "Stopped the current turn.",
    });
    expect(harness.interrupts).toEqual([
      {
        body: { reason: "Interrupted from Mattermost by user-1" },
        path: `/api/session/${encodeMattermostThreadKey(CHANNEL_ID, POST_ID)}/interrupt`,
      },
    ]);

    harness.interruptResult = false;
    const idle = await harness.app.fetch(commandRequest("stop", { root_id: POST_ID }));
    expect(await idle.json()).toEqual({
      response_type: "ephemeral",
      text: "Nothing is running in this thread.",
    });
  });

  it("keeps prompts and workflow runs typed in a thread in that thread", async () => {
    harness = await startHarness();
    const prompt = await harness.app.fetch(commandRequest("look again", { root_id: POST_ID }));
    expect(await prompt.json()).toEqual({});
    await waitFor(() => harness!.executes.length === 1);
    expect(harness.posts[0]).toEqual({
      channel_id: CHANNEL_ID,
      message: "@alice asked: look again",
      root_id: POST_ID,
    });
    expect(harness.executePaths).toEqual([
      `/api/session/${encodeMattermostThreadKey(CHANNEL_ID, POST_ID)}/execute`,
    ]);

    const run = await harness.app.fetch(
      commandRequest("run deploy", { root_id: POST_ID, trigger_id: "trigger-2" }),
    );
    expect(await run.json()).toEqual({
      response_type: "ephemeral",
      text: "Started `deploy` (run run-1).",
    });
    // The prompt turn's own reply also lands in this thread, so find the
    // workflow notice by content rather than position.
    expect(harness.posts).toContainEqual({
      channel_id: CHANNEL_ID,
      message: "@alice started workflow `deploy`",
      root_id: POST_ID,
    });
    expect(harness.runs[0]).toMatchObject({
      input: { mattermost: { root_id: POST_ID } },
    });
  });

  it("disables slash commands without configured tokens and refuses DMs", async () => {
    harness = await startHarness({ slashTokens: [] });
    expect((await harness.app.fetch(commandRequest("help"))).status).toBe(404);

    harness.close();
    harness = await startHarness();
    harness.channelType = "D";
    clearMattermostChannelCacheForTests();
    expect(await (await harness.app.fetch(commandRequest("help"))).json()).toEqual({
      response_type: "ephemeral",
      text: "This command is not available in this channel.",
    });
  });

  it("runs an allowlisted workflow and edits the root on failure", async () => {
    harness = await startHarness();
    const success = await harness.app.fetch(commandRequest('run deploy {"region":"prod"}'));
    expect(await success.json()).toEqual({
      response_type: "ephemeral",
      text: "Started `deploy` (run run-1).",
    });
    expect(harness.posts[0]).toEqual({ channel_id: CHANNEL_ID, message: "@alice started workflow `deploy`" });
    expect(harness.runs[0]).toMatchObject({
      workflow_name: "deploy",
      input: { region: "prod", mattermost: { channel_id: CHANNEL_ID, user_id: "user-1", root_id: "root-1" } },
      idempotency_key: "mattermost.command:trigger-1",
    });
    expect(await (await harness.app.fetch(commandRequest("run unknown"))).json()).toEqual({
      response_type: "ephemeral",
      text: "Workflow `unknown` is not allowed.",
    });
    harness.runStatus = 500;
    const failure = await harness.app.fetch(commandRequest("run deploy"));
    expect(await failure.json()).toEqual({
      response_type: "ephemeral",
      text: "Centaur couldn't start this right now. Try again.",
    });
    expect(harness.edits.at(-1)).toMatchObject({ id: "root-2", message: "@alice started workflow `deploy`\n\nCentaur couldn't start this workflow." });
  });

  it("posts a prompt root and accepts inline flags through the turn flow", async () => {
    harness = await startHarness();
    const response = await harness.app.fetch(commandRequest("--claude inspect this"));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({});
    await waitFor(() => harness!.executes.length === 1);
    expect(harness.sessionAppends[0]?.messages).toEqual([
      expect.objectContaining({
        client_message_id: "root-1",
        metadata: expect.objectContaining({
          is_mention: true,
          user_id: "user-1",
          user_name: "alice",
        }),
        parts: [{ text: "inspect this", type: "text" }],
        role: "user",
      }),
    ]);
  });
});
