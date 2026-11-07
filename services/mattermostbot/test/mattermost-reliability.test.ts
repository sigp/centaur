// Reliability behaviour of the Mattermost runtime, driven through the real
// chat-adapter-mattermost against a fake Mattermost server and a fake api-rs
// (same harness style as mattermost-e2e.test.ts): background execution with
// follow-ups appended mid-turn, transient create/append retry, bounded render
// retries, render-obligation recovery on startup, and long-answer splitting.
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createMemoryState } from "@chat-adapter/state-memory";
import type { StateAdapter } from "chat";
import {
  createMattermostbot,
  type Mattermostbot,
  type MattermostbotApiMessage,
  type MattermostbotOptions,
} from "../src/index";
import { createOpenAiProactiveClassifier } from "../src/proactive-classifier";
import { resetMattermostbotMetricsForTests } from "../src/metrics";

const CHANNEL_ID = "channelallowed";
const ROOT_ID = "rootallowed";
const THREAD_KEY = "mattermost:Y2hhbm5lbGFsbG93ZWQ:cm9vdGFsbG93ZWQ";
const BOT_ID = "bot-id";

type MattermostPost = {
  id: string;
  channel_id: string;
  user_id: string;
  message: string;
  type: string;
  create_at: number;
  update_at: number;
  edit_at: number;
  delete_at: number;
  is_pinned: boolean;
  root_id: string;
  metadata?: Record<string, unknown>;
};

function makePost(
  id: string,
  message: string,
  rootId = "",
): MattermostPost {
  return {
    id,
    channel_id: CHANNEL_ID,
    user_id: "user-1",
    message,
    type: "",
    create_at: Date.now(),
    update_at: 0,
    edit_at: 0,
    delete_at: 0,
    is_pinned: false,
    root_id: rootId,
  };
}

function nativeAssistantDelta(text: string, seq: number): string {
  return JSON.stringify({
    protocol_version: 1,
    request_id: "fake-execution",
    seq,
    type: "assistant.delta",
    payload: { phase: "final_answer", text },
  });
}

function sseOutputLine(id: number, text: string): string {
  return `id: ${id}\nevent: session.output.line\ndata: ${nativeAssistantDelta(text, id)}\n\n`;
}

function sleep(ms: number): Promise<void> {
  // The fake websocket/HTTP server runs on the platform clock; fake timers do
  // not advance those I/O events, so polling only yields to the integration
  // harness here.
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 5_000,
): Promise<void> {
  const started = Date.now();
  while (!(await predicate())) {
    if (Date.now() - started >= timeoutMs) {
      throw new Error("timed out waiting for condition");
    }
    await sleep(10);
  }
}

type Harness = {
  appendAttempts: Record<string, unknown>[];
  appends: Record<string, unknown>[];
  baseUrl: string;
  creates: Record<string, unknown>[];
  /** Optional api-rs session-create payload for persona reconciliation tests. */
  createResponse?: Record<string, unknown>;
  edits: Record<string, unknown>[];
  eventRequests: Array<{ executionId: string | null; threadKey: string }>;
  executes: Record<string, unknown>[];
  decisionRequests: Record<string, unknown>[];
  decisionResponses: Record<string, unknown>[];
  decisionFail: number;
  decisionHold: { promise: Promise<void>; release(): void } | null;
  reactions: Array<{
    emoji: string;
    method: "add" | "remove";
    postId: string;
  }>;
  refuseReactionAdds: number;
  refuseReactionRemoves: number;
  /** Number of upcoming append requests to answer with 503. */
  failAppends: number;
  /** Number of upcoming thread-history requests to answer with HTTP 500. */
  failHistory: number;
  /** Answer every event-stream open with 503. */
  failEvents: boolean;
  /** Text streamed as the final answer, one delta per entry. */
  answerChunks: string[];
  /** When set, the event stream emits its first delta, then waits on this. */
  hold: { promise: Promise<void>; release(): void } | null;
  fileRequests: Array<{ authorization: string | null; path: string }>;
  interrupts: Record<string, unknown>[];
  executeHold: { promise: Promise<void>; release(): void } | null;
  posts: Record<string, unknown>[];
  sockets: Array<{ send(data: string): void }>;
  close(): void;
  /** Final text of every bot post, in post order. */
  botPostTexts(): string[];
  sendPosted(post: MattermostPost): void;
};

function newGate(): { promise: Promise<void>; release(): void } {
  const { promise, resolve } = Promise.withResolvers<void>();
  return { promise, release: resolve };
}

function startHarness(): Harness {
  const stored = new Map<string, MattermostPost>();
  const botPostIds: string[] = [];
  let nextReply = 1;
  const harness: Harness = {
    answerChunks: ["first", " streamed reply"],
    appendAttempts: [],
    appends: [],
    baseUrl: "",
    botPostTexts: () =>
      botPostIds.map((id) => String(stored.get(id)?.message ?? "")),
    close: () => server.stop(true),
    creates: [],
    edits: [],
    eventRequests: [],
    executes: [],
    reactions: [],
    refuseReactionAdds: 0,
    refuseReactionRemoves: 0,
    failAppends: 0,
    decisionFail: 0,
    decisionHold: null,
    decisionRequests: [],
    decisionResponses: [],
    failEvents: false,
    failHistory: 0,
    fileRequests: [],
    hold: null,
    interrupts: [],
    executeHold: null,
    posts: [],
    sendPosted: (post) => {
      stored.set(post.id, post);
      harness.sockets[0]?.send(
        JSON.stringify({
          event: "posted",
          data: {
            channel_type: "O",
            post: JSON.stringify(post),
            sender_name: "alice",
          },
        }),
      );
    },
    sockets: [],
  };

  const server = Bun.serve<undefined>({
    port: 0,
    fetch: async (request, srv) => {
      const url = new URL(request.url);
      if (url.pathname === "/api/v4/websocket") {
        if (srv.upgrade(request)) return undefined;
        return new Response("upgrade failed", { status: 400 });
      }
      if (url.pathname === "/decisions" && request.method === "POST") {
        harness.decisionRequests.push(
          (await request.json()) as Record<string, unknown>,
        );
        if (harness.decisionHold) await harness.decisionHold.promise;
        if (harness.decisionFail > 0) {
          harness.decisionFail -= 1;
          return new Response("decision unavailable", {
            status: 503,
            statusText: "Service Unavailable",
          });
        }
        return Response.json(
          harness.decisionResponses.shift() ?? {
            answers: [{ name: "respond", probability: 0 }],
          },
        );
      }


      if (url.pathname.startsWith("/api/session/")) {
        const pieces = url.pathname.split("/").filter(Boolean);
        const threadKey = decodeURIComponent(pieces[2] ?? "");
        const suffix = pieces[3] ?? "";
        if (request.method === "POST" && !suffix) {
          harness.creates.push((await request.json()) as Record<string, unknown>);
          return Response.json({ ok: true, ...(harness.createResponse ?? {}) });
        }
        if (request.method === "POST" && suffix === "messages") {
          const body = (await request.json()) as Record<string, unknown>;
          harness.appendAttempts.push(body);
          if (harness.failAppends > 0) {
            harness.failAppends -= 1;
            return new Response("unavailable", {
              status: 503,
              statusText: "Service Unavailable",
            });
          }
          harness.appends.push(body);
          return Response.json({ ok: true });
        }
        if (request.method === "POST" && suffix === "execute") {
          const execute = (await request.json()) as Record<string, unknown>;
          harness.executes.push(execute);
          if (harness.executeHold) await harness.executeHold.promise;
          return Response.json({
            execution_id: "exec-1",
            ok: true,
            status: "running",
            thread_key: threadKey,
          });
        }
        if (request.method === "POST" && suffix === "interrupt") {
          harness.interrupts.push((await request.json()) as Record<string, unknown>);
          return Response.json({
            execution_id: "exec-1",
            interrupted: true,
            ok: true,
            status: "stopped",
            thread_key: threadKey,
          });
        }
        if (request.method === "GET" && suffix === "events") {
          harness.eventRequests.push({
            executionId: url.searchParams.get("execution_id"),
            threadKey,
          });
          if (harness.failEvents) {
            return new Response("unavailable", {
              status: 503,
              statusText: "Service Unavailable",
            });
          }
          const chunks = harness.answerChunks;
          const hold = harness.hold;
          const interruptsAtOpen = harness.interrupts.length;
          const encoder = new TextEncoder();
          const body = new ReadableStream<Uint8Array>({
            async start(controller) {
              let id = 1;
              for (const [index, chunk] of chunks.entries()) {
                controller.enqueue(encoder.encode(sseOutputLine(id++, chunk)));
                if (index === 0 && hold) await hold.promise;
              }
              // api-rs ends a turn interrupted while it ran as cancelled.
              const terminal =
                harness.interrupts.length > interruptsAtOpen
                  ? "session.execution_cancelled"
                  : "session.execution_completed";
              controller.enqueue(encoder.encode(`id: ${id}\nevent: ${terminal}\ndata: {}\n\n`));
              controller.close();
            },
          });
          return new Response(body, {
            headers: { "content-type": "text/event-stream" },
          });
        }
      }

      if (url.pathname === "/api/v4/users/me") {
        return Response.json({ id: BOT_ID, username: "centaur", is_bot: true });
      }
      if (url.pathname === "/api/v4/users/user-1") {
        return Response.json({ id: "user-1", username: "alice", is_bot: false });
      }
      if (url.pathname === `/api/v4/channels/${CHANNEL_ID}`) {
        return Response.json({
          id: CHANNEL_ID,
          name: "ops",
          display_name: "Ops",
          team_id: "team-allowed",
          type: "O",
        });
      }
      if (url.pathname === "/api/v4/reactions" && request.method === "POST") {
        const body = (await request.json()) as {
          emoji_name?: string;
          post_id?: string;
        };
        harness.reactions.push({
          emoji: String(body.emoji_name ?? ""),
          method: "add",
          postId: String(body.post_id ?? ""),
        });
        if (harness.refuseReactionAdds > 0) {
          harness.refuseReactionAdds -= 1;
          return new Response("reaction denied", { status: 403 });
        }
        return Response.json({});
      }
      const reactionMatch = url.pathname.match(
        /^\/api\/v4\/users\/[^/]+\/posts\/([^/]+)\/reactions\/([^/]+)$/,
      );
      if (reactionMatch && request.method === "DELETE") {
        harness.reactions.push({
          emoji: decodeURIComponent(reactionMatch[2] ?? ""),
          method: "remove",
          postId: reactionMatch[1] ?? "",
        });
        if (harness.refuseReactionRemoves > 0) {
          harness.refuseReactionRemoves -= 1;
          return new Response("reaction denied", { status: 403 });
        }
        return new Response(null, { status: 204 });
      }
      if (url.pathname.startsWith("/api/v4/files/") && request.method === "GET") {
        harness.fileRequests.push({
          authorization: request.headers.get("authorization"),
          path: url.pathname,
        });
        return new Response("file-bytes", {
          headers: { "content-type": "text/plain" },
        });
      }
      const threadMatch = url.pathname.match(/^\/api\/v4\/posts\/([^/]+)\/thread$/);
      if (threadMatch) {
        if (harness.failHistory > 0) {
          harness.failHistory -= 1;
          return new Response("history unavailable", { status: 500 });
        }
        const rootId = threadMatch[1] ?? "";
        const members = [...stored.values()].filter(
          (candidate) => candidate.id === rootId || candidate.root_id === rootId,
        );
        return Response.json({
          order: members.map((member) => member.id),
          posts: Object.fromEntries(members.map((member) => [member.id, member])),
        });
      }
      const postMatch = url.pathname.match(/^\/api\/v4\/posts\/([^/]+)$/);
      if (postMatch && request.method === "GET") {
        const found = stored.get(postMatch[1] ?? "");
        return found ? Response.json(found) : new Response("not found", { status: 404 });
      }
      if (url.pathname === "/api/v4/posts" && request.method === "POST") {
        const body = (await request.json()) as Record<string, unknown>;
        const created = {
          ...makePost(
            `reply-${nextReply++}`,
            String(body.message ?? ""),
            String(body.root_id ?? ""),
          ),
          user_id: BOT_ID,
        };
        stored.set(created.id, created);
        botPostIds.push(created.id);
        harness.posts.push(body);
        return Response.json(created);
      }
      if (postMatch && request.method === "PUT") {
        const body = (await request.json()) as Record<string, unknown>;
        const id = postMatch[1] ?? "";
        harness.edits.push(body);
        const updated = {
          ...stored.get(id),
          ...body,
          id,
          user_id: BOT_ID,
        } as MattermostPost;
        stored.set(id, updated);
        return Response.json(updated);
      }
      return new Response("not found", { status: 404 });
    },
    websocket: {
      open(socket) {
        harness.sockets.push(socket);
      },
      message(socket, data) {
        const payload = JSON.parse(String(data)) as {
          action?: string;
          seq?: number;
        };
        if (payload.action !== "authentication_challenge") return;
        socket.send(JSON.stringify({ seq_reply: payload.seq, status: "OK" }));
      },
    },
  });
  harness.baseUrl = `http://127.0.0.1:${server.port}`;
  return harness;
}

let harness: Harness | undefined;
const bots: Mattermostbot[] = [];
beforeEach(() => {
  resetMattermostbotMetricsForTests();
});

afterEach(async () => {
  for (const bot of bots.splice(0)) {
    await bot.chat.shutdown().catch(() => undefined);
  }
  harness?.close();
  harness = undefined;
});

function startBot(
  overrides: Partial<MattermostbotOptions> = {},
): Mattermostbot {
  if (!harness) throw new Error("harness not started");
  const bot = createMattermostbot({
    answerEditIntervalMs: 20,
    apiKey: "MATTERMOSTBOT_API_KEY",
    apiUrl: harness.baseUrl,
    baseUrl: harness.baseUrl,
    botToken: "MATTERMOST_BOT_TOKEN",
    state: createMemoryState(),
    teamAllowlist: ["team-allowed"],
    userName: "centaur",
    websocket: { reconnectDelayMs: 10, maxReconnectDelayMs: 50 },
    ...overrides,
  });
  bots.push(bot);
  return bot;
}

async function startBotAndConnect(
  overrides: Partial<MattermostbotOptions> = {},
): Promise<Mattermostbot> {
  const bot = startBot(overrides);
  await bot.chat.initialize();
  await waitFor(() => (harness?.sockets.length ?? 0) === 1);
  return bot;
}
function fakeProactivity(
  h: Harness,
  options: {
    debounceMs?: number;
    rules?: {
      default?: Array<{ name: string; when: string; context?: string }>;
      channels?: Record<
        string,
        Array<{ name: string; when: string; context?: string }>
      >;
    };
  } = {},
) {
  return {
    classifier: createOpenAiProactiveClassifier({
      apiKey: "OPENAI_API_KEY",
      baseUrl: h.baseUrl,
      model: "test-proactivity-model",
    }),
    debounceMs: options.debounceMs,
    rules: options.rules,
    timeoutMs: 100,
  };
}


function threadState(
  state: StateAdapter,
): Promise<Record<string, unknown> | null> {
  return state.get<Record<string, unknown>>(`thread-state:${THREAD_KEY}`);
}

function appendedIds(h: Harness): string[] {
  return h.appends.flatMap((body) =>
    ((body.messages as Array<{ client_message_id?: string }>) ?? []).map(
      (message) => String(message.client_message_id),
    ),
  );
}

describe("Mattermost reliability", () => {
  it("strips inline flags in the Mattermost flow and forwards create/execute controls", async () => {
    harness = startHarness();
    const h = harness;
    const state = createMemoryState();
    await startBotAndConnect({ state });

    h.sendPosted(
      makePost(
        ROOT_ID,
        "@centaur --claude-code --persona eng --model opus --provider bedrock -rsn high inspect this",
      ),
    );
    await waitFor(async () => (await threadState(state))?.activeExecution === false);
    await waitFor(() => h.executes.length === 1);
    expect(JSON.stringify(h.appends)).toContain("inspect this");
    expect(JSON.stringify(h.appends)).not.toContain("--claude-code");
    expect(h.creates[0]).toMatchObject({
      harness_type: "claudecode",
      persona_id: "eng",
    });
    expect(JSON.stringify(h.executes)).toContain("claude-opus-5-5");
    expect(JSON.stringify(h.executes)).toContain("amazon-bedrock");
    expect(JSON.stringify(h.executes)).toContain("high");
  });
  it("downloads Mattermost files with the bot token and forwards their bytes to api-rs", async () => {
    harness = startHarness();
    const h = harness;
    const state = createMemoryState();
    await startBotAndConnect({ state });

    h.sendPosted({
      ...makePost(ROOT_ID, "@centaur inspect this file"),
      metadata: {
        files: [
          {
            id: "file-1",
            mime_type: "text/plain",
            name: "note.txt",
            size: 10,
          },
        ],
      },
    });
    await waitFor(async () => (await threadState(state))?.activeExecution === false);
    await waitFor(() => h.appends.length > 0);
    expect(
      h.fileRequests.some(
        (request) =>
          request.authorization === "Bearer MATTERMOST_BOT_TOKEN" &&
          request.path === "/api/v4/files/file-1",
      ),
    ).toBe(true);
    expect(JSON.stringify(h.appends)).toContain("ZmlsZS1ieXRlcw==");
  });
  it("keeps explicit harness, model and provider sticky on a later plain mention", async () => {
    harness = startHarness();
    const h = harness;
    const state = createMemoryState();
    await startBotAndConnect({ state });

    h.sendPosted(
      makePost(
        ROOT_ID,
        "@centaur --claude --model opus --provider bedrock -rsn high first",
      ),
    );
    await waitFor(async () => (await threadState(state))?.activeExecution === false);
    h.sendPosted(makePost("sticky-followup", "@centaur plain followup", ROOT_ID));
    await waitFor(async () => (await threadState(state))?.activeExecution === false && h.executes.length === 2);

    const second = JSON.stringify(h.executes[1]);
    expect(second).toContain("claude-opus-5-5");
    expect(second).toContain("amazon-bedrock");
    expect(second).toContain('"harness_type":"claudecode"');
  });
  it("applies channel defaults above deployment defaults and pins the channel persona", async () => {
    harness = startHarness();
    const h = harness;
    const state = createMemoryState();
    const channelDefaults: NonNullable<MattermostbotOptions["channelDefaults"]> = {
      [CHANNEL_ID]: {
        harnessType: "claudecode",
        model: "claude-opus-5-5",
        personaId: "channel-persona",
      },
    };
    await startBotAndConnect({
      channelDefaults,
      defaultHarnessType: "codex",
      harnessDefaultModels: { codex: "deployment-model" },
      state,
    });

    h.sendPosted(makePost(ROOT_ID, "@centaur use the channel default"));
    await waitFor(async () => (await threadState(state))?.activeExecution === false);
    expect(h.creates[0]).toMatchObject({
      harness_type: "claudecode",
      persona_id: "channel-persona",
    });
    expect(JSON.stringify(h.executes[0])).toContain("claude-opus-5-5");
    expect(JSON.stringify(h.executes[0])).not.toContain("deployment-model");

    channelDefaults[CHANNEL_ID] = {
      harnessType: "codex",
      model: "changed-channel-model",
      personaId: "changed-persona",
    };
    h.sendPosted(makePost("channel-default-followup", "@centaur follow up", ROOT_ID));
    await waitFor(async () => (await threadState(state))?.activeExecution === false && h.executes.length === 2);
    expect(h.creates[1]).toMatchObject({ persona_id: "channel-persona" });
  });
  it("restarts a pinned thread when a conflicting harness flag is requested", async () => {
    harness = startHarness();
    const h = harness;
    const state = createMemoryState();
    await startBotAndConnect({ state });

    h.sendPosted(makePost(ROOT_ID, "@centaur --claude first harness"));
    await waitFor(async () => (await threadState(state))?.activeExecution === false);
    h.sendPosted(makePost("harness-switch", "@centaur --codex second harness", ROOT_ID));
    await waitFor(async () => (await threadState(state))?.activeExecution === false && h.executes.length === 2);

    expect(h.creates).toHaveLength(2);
    expect(h.creates[0]).toMatchObject({ harness_type: "claudecode" });
    expect(h.creates[1]).toMatchObject({
      harness_type: "codex",
      on_harness_conflict: "restart",
    });
    expect(JSON.stringify(h.executes[1])).toContain('"harness_type":"codex"');
  });

  it("falls back to the deployment harness when a disabled harness is requested", async () => {
    harness = startHarness();
    const h = harness;
    const state = createMemoryState();
    await startBotAndConnect({
      defaultHarnessType: "codex",
      enabledHarnesses: ["codex"],
      state,
    });

    h.sendPosted(makePost(ROOT_ID, "@centaur --claude disabled request"));
    await waitFor(async () => (await threadState(state))?.activeExecution === false);
    expect(h.creates[0]).toMatchObject({ harness_type: "codex" });
    expect(JSON.stringify(h.executes[0])).toContain('"harness_type":"codex"');
    expect(JSON.stringify(h.creates[0])).not.toContain("claudecode");
  });
  it("interrupts an active turn for a mentioned stop without starting another execution", async () => {
    harness = startHarness();
    const h = harness;
    h.hold = newGate();
    const state = createMemoryState();
    const bot = await startBotAndConnect({ state });

    h.sendPosted(makePost(ROOT_ID, "@centaur start work"));
    await waitFor(() => h.eventRequests.length === 1);
    h.sendPosted(makePost("stop-active", "@centaur stop", ROOT_ID));
    await waitFor(() => h.interrupts.length === 1);
    expect(h.interrupts[0]).toMatchObject({
      reason: "Interrupted from Mattermost by user-1",
    });
    expect(h.executes).toHaveLength(1);
    expect(appendedIds(h)).toEqual([ROOT_ID]);
    h.hold.release();
    await waitFor(async () => (await threadState(state))?.activeExecution === false);
    expect((await threadState(state))?.proactiveEligible).toBe(false);
    const metricsText = async () =>
      (await bot.app.fetch(new Request("http://mattermost.test/metrics"))).text();
    await waitFor(async () => /mattermostbot_active_live_renders 0\n/.test(await metricsText()));
    const metrics = await metricsText();
    expect(metrics).toMatch(/mattermostbot_executions_interrupted_total 1\n/);
    expect(metrics).toMatch(/mattermostbot_stop_commands_total\{outcome="interrupted"\} 1/);
  });
  it("does not start execution when a stop is recorded before the execute handoff", async () => {
    harness = startHarness();
    const h = harness;
    const state = createMemoryState();
    await state.connect();
    await state.set(`thread-state:${THREAD_KEY}`, {
      proactiveEligible: false,
      stopRequestedAt: Date.now() + 60_000,
    });
    await startBotAndConnect({ state });

    h.sendPosted(makePost(ROOT_ID, "@centaur start work"));
    await waitFor(() => h.appends.length >= 1);
    await sleep(20);
    expect(h.executes).toHaveLength(0);
    expect(appendedIds(h)).toEqual([ROOT_ID]);
  });
  it("appends a follow-up posted while an execution is active instead of dropping it", async () => {
    harness = startHarness();
    const h = harness;
    h.hold = newGate();
    const state = createMemoryState();
    await startBotAndConnect({ state });

    h.sendPosted(makePost(ROOT_ID, "@centaur hello"));
    // The render is open and parked after its first delta: the turn is active.
    await waitFor(() => h.eventRequests.length === 1);
    await waitFor(() => h.posts.length === 1);
    expect(appendedIds(h)).toContain(ROOT_ID);

    h.sendPosted(makePost("followup1", "@centaur also look at the logs", ROOT_ID));
    await waitFor(() => appendedIds(h).includes("followup1"));

    // The follow-up must not have started a second execution.
    expect(h.executes).toHaveLength(1);

    h.hold.release();
    await waitFor(async () => (await threadState(state))?.activeExecution === false);
    expect(h.botPostTexts().join("\n")).toContain("first streamed reply");
    expect(h.executes).toHaveLength(1);
  });

  it("holds an unmentioned follow-up until the next mention refreshes context", async () => {
    harness = startHarness();
    const h = harness;
    h.hold = newGate();
    const state = createMemoryState();
    await startBotAndConnect({ state });

    h.sendPosted(makePost(ROOT_ID, "@centaur hello"));
    await waitFor(() => h.eventRequests.length === 1);
    await waitFor(() => h.posts.length === 1);

    h.sendPosted(makePost("unmentioned-followup", "also look at the logs", ROOT_ID));
    await sleep(50);
    expect(appendedIds(h)).toEqual([ROOT_ID]);
    expect(h.executes).toHaveLength(1);

    h.sendPosted(
      makePost("mentioned-followup", "@centaur now include those logs", ROOT_ID),
    );
    await waitFor(() => appendedIds(h).includes("unmentioned-followup"));
    expect(appendedIds(h)).toContain("mentioned-followup");
    expect(h.executes).toHaveLength(1);

    h.hold.release();
    await waitFor(async () => (await threadState(state))?.activeExecution === false);
  });

  it("adds the ack reaction at turn start and removes it after the reply", async () => {
    harness = startHarness();
    const h = harness;
    h.hold = newGate();
    const state = createMemoryState();
    await startBotAndConnect({ state });

    h.sendPosted(makePost(ROOT_ID, "@centaur take a while"));
    await waitFor(() =>
      h.reactions.some(
        (reaction) =>
          reaction.method === "add" &&
          reaction.emoji === "eyes" &&
          reaction.postId === ROOT_ID,
      ),
    );
    expect(
      h.reactions.some(
        (reaction) => reaction.method === "remove" && reaction.postId === ROOT_ID,
      ),
    ).toBe(false);

    h.hold.release();
    await waitFor(async () => (await threadState(state))?.activeExecution === false);
    await waitFor(() =>
      h.reactions.some(
        (reaction) => reaction.method === "remove" && reaction.postId === ROOT_ID,
      ),
    );
  });

  it("disables a reaction kind for the process when Mattermost refuses it", async () => {
    harness = startHarness();
    const h = harness;
    h.refuseReactionAdds = 1;
    const state = createMemoryState();
    await startBotAndConnect({ state });

    h.sendPosted(makePost(ROOT_ID, "@centaur first"));
    await waitFor(() => h.botPostTexts().length === 1);
    h.sendPosted(makePost("rootsecond", "@centaur second"));
    await waitFor(() => h.botPostTexts().length === 2);

    // The refused add is the only attempt: no removal of a reaction that was
    // never added, and no add on the later turn.
    expect(h.reactions).toEqual([{ emoji: "eyes", method: "add", postId: ROOT_ID }]);
  });

  it("adds a steering reaction only when enabled and removes it after the turn", async () => {
    harness = startHarness();
    const h = harness;
    h.hold = newGate();
    const state = createMemoryState();
    await startBotAndConnect({ steeringReactionEnabled: true, state });

    h.sendPosted(makePost(ROOT_ID, "@centaur start work"));
    await waitFor(() => h.eventRequests.length === 1);
    await waitFor(() => h.posts.length === 1);

    const steeringId = "steering-1";
    h.sendPosted(makePost(steeringId, "@centaur also check the logs", ROOT_ID));
    await waitFor(() =>
      h.reactions.some(
        (reaction) =>
          reaction.method === "add" &&
          reaction.emoji === "hourglass_flowing_sand" &&
          reaction.postId === steeringId,
      ),
    );
    expect(
      h.reactions.some(
        (reaction) => reaction.method === "remove" && reaction.postId === steeringId,
      ),
    ).toBe(false);

    h.hold.release();
    await waitFor(async () => (await threadState(state))?.activeExecution === false);
    await waitFor(() =>
      h.reactions.some(
        (reaction) => reaction.method === "remove" && reaction.postId === steeringId,
      ),
    );
  });

  it("keeps a steering reaction when an append retry starts a new execution", async () => {
    harness = startHarness();
    const h = harness;
    h.hold = newGate();
    const state = createMemoryState();
    await startBotAndConnect({
      forwardRetryDelaysMs: [500],
      steeringReactionEnabled: true,
      state,
    });

    h.sendPosted(makePost(ROOT_ID, "@centaur start work"));
    await waitFor(() => h.eventRequests.length === 1);
    await waitFor(() => h.posts.length === 1);
    await waitFor(() => h.appends.length === 1);
    h.failAppends = 1;

    const steeringId = "steering-retry";
    h.sendPosted(makePost(steeringId, "@centaur retry as the next turn", ROOT_ID));
    await waitFor(() =>
      h.reactions.some(
        (reaction) =>
          reaction.method === "add" &&
          reaction.emoji === "hourglass_flowing_sand" &&
          reaction.postId === steeringId,
      ),
    );
    h.hold.release();
    // Hold the upgraded turn so its reaction can be checked while it runs.
    const upgradedTurn = newGate();
    h.hold = upgradedTurn;
    await waitFor(() => h.executes.length === 2);
    await waitFor(() => h.eventRequests.length === 2);
    const steeringReactions = () =>
      h.reactions
        .filter((reaction) => reaction.postId === steeringId)
        .map((reaction) => reaction.method);
    expect(steeringReactions()).toEqual(["add"]);
    upgradedTurn.release();
    await waitFor(() => steeringReactions().length === 2);
    expect(steeringReactions()).toEqual(["add", "remove"]);
  });

  it("retries a transient 503 on append and completes the turn", async () => {
    harness = startHarness();
    const h = harness;
    h.failAppends = 1;
    const state = createMemoryState();
    await startBotAndConnect({ forwardRetryDelaysMs: [10, 10], state });

    h.sendPosted(makePost(ROOT_ID, "@centaur hello"));
    await waitFor(async () => (await threadState(state))?.activeExecution === false);
    await waitFor(() => h.botPostTexts().join("\n").includes("first streamed reply"));

    expect(h.appendAttempts).toHaveLength(2);
    expect(h.appends).toHaveLength(1);
    expect(appendedIds(h)).toContain(ROOT_ID);
    expect(h.executes).toHaveLength(1);
    expect(h.botPostTexts().join("\n")).not.toContain("could not complete");
  });

  it("recovers a persisted render obligation on startup, posts once and clears activeExecution", async () => {
    harness = startHarness();
    const h = harness;
    h.answerChunks = ["Recovered request."];
    const state = createMemoryState();
    await state.connect();
    const message: MattermostbotApiMessage = {
      attachments: [],
      author: {
        fullName: "Alice",
        isBot: false,
        isMe: false,
        userId: "user-1",
        userName: "alice",
      },
      id: ROOT_ID,
      isMention: true,
      raw: {},
      text: "@centaur recover a completed run",
      threadId: THREAD_KEY,
      timestamp: "2026-01-01T00:00:00.000Z",
    };
    // What a pod that died mid-turn leaves behind: the execution was committed
    // (flag + obligation + index entry) but the reply was never posted.
    await state.set(`thread-state:${THREAD_KEY}`, {
      activeExecution: true,
      activeExecutionStartedAt: Date.now(),
      executedMessageIds: [ROOT_ID],
      forwardedMessageIds: [ROOT_ID],
      historyForwarded: true,
      lastEventId: 0,
      renderObligation: {
        afterEventId: 0,
        executionId: "exec-recovery",
        message,
      },
    });
    await state.appendToList("mattermostbot:render:index", THREAD_KEY);

    startBot({ state });

    await waitFor(() => h.eventRequests.length === 1);
    await waitFor(async () => (await threadState(state))?.renderObligation === null);

    expect(h.eventRequests).toEqual([
      { executionId: "exec-recovery", threadKey: THREAD_KEY },
    ]);
    expect(h.creates).toHaveLength(0);
    expect(h.appends).toHaveLength(0);
    expect(h.executes).toHaveLength(0);
    expect(h.posts).toHaveLength(1);
    expect(h.posts[0]).toMatchObject({
      channel_id: CHANNEL_ID,
      root_id: ROOT_ID,
    });
    expect(h.botPostTexts().join("\n")).toContain("Recovered request.");
    expect(await threadState(state)).toEqual(
      expect.objectContaining({
        activeExecution: false,
        renderObligation: null,
      }),
    );
    // A second sweep must not replay the already-rendered obligation.
    await sleep(100);
    expect(h.eventRequests).toHaveLength(1);
    expect(h.posts).toHaveLength(1);
  });

  it("splits a long answer across several posts within the configured limit, in order", async () => {
    harness = startHarness();
    const h = harness;
    const paragraphs = Array.from(
      { length: 8 },
      (_, index) => `Paragraph ${index + 1}: ${"lorem ipsum ".repeat(8).trim()}.`,
    );
    h.answerChunks = paragraphs.map((paragraph) => `${paragraph}\n\n`);
    const state = createMemoryState();
    await startBotAndConnect({ maxPostChars: 200, state });

    h.sendPosted(makePost(ROOT_ID, "@centaur write a lot"));
    await waitFor(async () => (await threadState(state))?.activeExecution === false);
    await waitFor(() => h.botPostTexts().join("\n").includes("Paragraph 8"));

    const texts = h.botPostTexts();
    expect(texts.length).toBeGreaterThanOrEqual(3);
    for (const text of texts) expect(text.length).toBeLessThanOrEqual(200);
    for (const body of [...h.posts, ...h.edits]) {
      expect(String(body.message).length).toBeLessThanOrEqual(200);
      expect(body).toMatchObject({ channel_id: CHANNEL_ID, root_id: ROOT_ID });
    }
    // Every paragraph appears exactly once, in order, across the posts.
    const joined = texts.join("\n");
    let cursor = 0;
    for (const [index] of paragraphs.entries()) {
      const at = joined.indexOf(`Paragraph ${index + 1}:`, cursor);
      expect(at).toBeGreaterThanOrEqual(cursor);
      cursor = at;
    }
    expect(joined.match(/Paragraph 1:/g)).toHaveLength(1);
  });

  it("splits at 16000 characters by default, safely under Mattermost's 16383 limit", async () => {
    harness = startHarness();
    const h = harness;
    const line = `${"x".repeat(78)}\n`;
    h.answerChunks = Array.from({ length: 5 }, () => line.repeat(60));
    const state = createMemoryState();
    await startBotAndConnect({ responseMetadataMode: "never", state });

    h.sendPosted(makePost(ROOT_ID, "@centaur write a novel"));
    await waitFor(async () => (await threadState(state))?.activeExecution === false);

    const texts = h.botPostTexts();
    expect(texts.length).toBeGreaterThanOrEqual(2);
    for (const text of texts) expect(text.length).toBeLessThanOrEqual(16_000);
    expect(texts.join("").replaceAll("\n", "").length).toBe(5 * 60 * 78);
  });

  it("posts an in-thread failure and clears activeExecution when render retries are exhausted", async () => {
    harness = startHarness();
    const h = harness;
    h.failEvents = true;
    const state = createMemoryState();
    await startBotAndConnect({
      renderRetryInitialDelayMs: 5,
      renderRetryMaxAttempts: 2,
      renderRetryMaxDelayMs: 10,
      state,
    });

    h.sendPosted(makePost(ROOT_ID, "@centaur exhaust the retries"));
    await waitFor(() =>
      h.botPostTexts().join("\n").includes("Streaming retries exhausted"),
    );
    await waitFor(async () => (await threadState(state))?.activeExecution === false);
    await waitFor(() =>
      h.reactions.some(
        (reaction) => reaction.method === "remove" && reaction.postId === ROOT_ID,
      ),
    );

    // Initial attempt + 2 retries, all idempotent on the message id.
    expect(h.executes).toHaveLength(3);
    expect(
      new Set(h.executes.map((execute) => execute.idempotency_key)),
    ).toEqual(new Set([ROOT_ID]));
    expect(h.botPostTexts()).toHaveLength(1);
    expect(h.posts[0]).toMatchObject({ channel_id: CHANNEL_ID, root_id: ROOT_ID });
    // The obligation is kept so a restart can still retry the render.
    expect((await threadState(state))?.renderObligation).not.toBeNull();
  });

  it("releases the team slot and replies when history fetches fail, then executes a later mention", async () => {
    harness = startHarness();
    const h = harness;
    h.failHistory = 3;
    const state = createMemoryState();
    await startBotAndConnect({
      maxConcurrentExecutionsPerTeam: 1,
      state,
    });

    for (const [index, text] of ["first", "second", "third"].entries()) {
      h.sendPosted(makePost(`history-${index + 1}`, `@centaur ${text}`, ROOT_ID));
      await waitFor(() => h.botPostTexts().length >= index + 1);
    }
    expect(
      h.botPostTexts().filter((text) =>
        text.includes("I couldn't read this thread's history"),
      ),
    ).toHaveLength(3);
    expect(h.posts.every((post) => String(post.root_id) === ROOT_ID)).toBe(true);

    h.sendPosted(makePost("history-4", "@centaur fourth", ROOT_ID));
    await waitFor(async () => (await threadState(state))?.activeExecution === false);
    await waitFor(() => h.botPostTexts().join("\n").includes("first streamed reply"));
    expect(h.executes).toHaveLength(1);
  });
  it("renders the response footer only on the first reply by default", async () => {
    harness = startHarness();
    const h = harness;
    const state = createMemoryState();
    await startBotAndConnect({ responseMetadataMode: "first", state });

    h.sendPosted(makePost(ROOT_ID, "@centaur first"));
    await waitFor(async () => (await threadState(state))?.activeExecution === false);
    await waitFor(() => h.botPostTexts().length >= 1);
    h.sendPosted(makePost("second-root", "@centaur second", ROOT_ID));
    await waitFor(() => h.executes.length === 2);
    await waitFor(() => h.botPostTexts().length >= 2);

    const texts = h.botPostTexts();
    expect(texts.filter((text) => text.includes("Sol 5.6"))).toHaveLength(1);
    expect(texts.filter((text) => text.includes("Codex"))).toHaveLength(1);
  });

  it("renders the response footer on every reply in always mode", async () => {
    harness = startHarness();
    const h = harness;
    const state = createMemoryState();
    await startBotAndConnect({ responseMetadataMode: "always", state });

    h.sendPosted(makePost(ROOT_ID, "@centaur first"));
    await waitFor(async () => (await threadState(state))?.activeExecution === false);
    h.sendPosted(makePost("second-root", "@centaur second", ROOT_ID));
    await waitFor(() => h.executes.length === 2);
    await waitFor(() => h.botPostTexts().length >= 2);

    expect(h.botPostTexts().filter((text) => text.includes("Sol 5.6"))).toHaveLength(2);
  });

  it("does not render the response footer in never mode", async () => {
    harness = startHarness();
    const h = harness;
    const state = createMemoryState();
    await startBotAndConnect({ responseMetadataMode: "never", state });

    h.sendPosted(makePost(ROOT_ID, "@centaur first"));
    await waitFor(async () => (await threadState(state))?.activeExecution === false);
    await waitFor(() => h.botPostTexts().length >= 1);

    expect(h.botPostTexts().join("\n")).not.toContain("Sol 5.6");
    expect(h.botPostTexts().join("\n")).not.toContain("Codex");
  });

  it("adds the service tier without changing first-footer eligibility", async () => {
    harness = startHarness();
    const h = harness;
    const state = createMemoryState();
    await startBotAndConnect({
      responseMetadataMode: "first",
      responseServiceTierEnabled: true,
      state,
    });

    h.sendPosted(makePost(ROOT_ID, "@centaur first"));
    await waitFor(async () => (await threadState(state))?.activeExecution === false);
    h.sendPosted(makePost("second-root", "@centaur second", ROOT_ID));
    await waitFor(() => h.executes.length === 2);
    await waitFor(() => h.botPostTexts().length >= 2);

    expect(h.botPostTexts().filter((text) => text.includes("Fast"))).toHaveLength(1);
  });

  it("uses the flag model and then a changed channel default in footers", async () => {
    harness = startHarness();
    const h = harness;
    const defaults = { [CHANNEL_ID]: { model: "gpt-5.6-sol" } };
    const state = createMemoryState();
    await startBotAndConnect({
      channelDefaults: defaults,
      responseMetadataMode: "always",
      state,
    });

    h.sendPosted(makePost(ROOT_ID, "@centaur --model gpt-6-luna flagged"));
    await waitFor(async () => (await threadState(state))?.activeExecution === false);
    expect(h.botPostTexts().join("\n")).toContain("Luna 6");

    defaults[CHANNEL_ID] = { model: "gpt-6.1-terra" };
    h.sendPosted(makePost("rootsecond", "@centaur channel default"));
    await waitFor(() => h.executes.length === 2);
    await waitFor(() => h.botPostTexts().join("\n").includes("Terra 6.1"));
  });

  it("shows a persona-pinned model over model and provider flags", async () => {
    harness = startHarness();
    const h = harness;
    h.createResponse = {
      harness_type: "codex",
      persona_id: "eng",
      persona_model: "gpt-6-ultra",
    };
    const state = createMemoryState();
    await startBotAndConnect({ responseMetadataMode: "always", state });

    h.sendPosted(
      makePost(
        ROOT_ID,
        "@centaur --persona eng --model gpt-5.6-sol --provider openai inspect",
      ),
    );
    await waitFor(async () => (await threadState(state))?.activeExecution === false);
    await waitFor(() => h.botPostTexts().length >= 1);
    expect(h.botPostTexts().join("\n")).toContain("GPT 6 Ultra");
  });

  it("posts a footer separately when the answer post has no room", async () => {
    harness = startHarness();
    const h = harness;
    h.answerChunks = ["ok"];
    const state = createMemoryState();
    await startBotAndConnect({
      maxPostChars: 28,
      responseMetadataMode: "always",
      state,
    });

    h.sendPosted(makePost(ROOT_ID, "@centaur short"));
    await waitFor(async () => (await threadState(state))?.activeExecution === false);
    await waitFor(() => h.botPostTexts().length >= 2);

    const texts = h.botPostTexts();
    expect(texts).toContain("ok");
    expect(texts.some((text) => text.includes("Codex"))).toBe(true);
    expect(texts.every((text) => text.length <= 28)).toBe(true);
  });

  it("serves key metric series after a completed turn", async () => {
    harness = startHarness();
    const h = harness;
    const state = createMemoryState();
    const bot = await startBotAndConnect({
      responseMetadataMode: "always",
      state,
    });

    h.sendPosted(makePost(ROOT_ID, "@centaur metrics"));
    await waitFor(async () => (await threadState(state))?.activeExecution === false);
    await waitFor(() =>
      h.reactions.some(
        (reaction) => reaction.method === "remove" && reaction.postId === ROOT_ID,
      ),
    );

    const response = await bot.app.fetch(
      new Request("http://mattermost.test/metrics"),
    );
    const text = await response.text();
    expect(response.status).toBe(200);
    expect(text).toMatch(/mattermostbot_executions_started_total 1/);
    expect(text).toMatch(/mattermostbot_executions_completed_total 1/);
    expect(text).toMatch(
      /mattermostbot_session_api_operations_total\{operation="create_session",outcome="success"\} 1/,
    );
    expect(text).toMatch(
      /mattermostbot_session_api_operations_total\{operation="execute_session",outcome="success"\} 1/,
    );
    expect(text).toMatch(
      /mattermostbot_reactions_total\{kind="ack",operation="add",outcome="success"\} 1/,
    );
    expect(text).toMatch(
      /mattermostbot_reactions_total\{kind="ack",operation="remove",outcome="success"\} 1/,
    );
    expect(text).toMatch(
      /mattermostbot_render_attempts_total\{source="live",outcome="complete"\} 1/,
    );
    expect(text).toMatch(/mattermostbot_active_live_renders 0/);
    expect(text).toMatch(/mattermostbot_websocket_connected 1/);
  });
});

function respondDecision(probability = 1): Record<string, unknown> {
  return { answers: [{ name: "respond", probability }] };
}

function ruleDecision(
  probabilities: number[],
): Record<string, unknown> {
  return {
    answers: probabilities.map((probability, index) => ({
      name: `rule_${index + 1}`,
      probability,
    })),
  };
}

describe("Mattermost proactive replies", () => {
  it("classifies only eligible unmentioned follow-ups and accepts person-directed replies", async () => {
    harness = startHarness();
    const h = harness;
    const state = createMemoryState();
    await startBotAndConnect({
      proactivity: fakeProactivity(h),
      state,
    });

    h.sendPosted(makePost(ROOT_ID, "not eligible yet"));
    await sleep(50);
    expect(h.decisionRequests).toHaveLength(0);
    expect(h.executes).toHaveLength(0);

    h.sendPosted(makePost("eligible-mention", "@centaur start a thread", ROOT_ID));
    await waitFor(() => h.executes.length === 1);
    await waitFor(async () => (await threadState(state))?.activeExecution === false);

    h.decisionResponses.push(respondDecision());
    h.sendPosted(makePost("unmentioned-followup", "@alice please check this", ROOT_ID));
    await waitFor(() => h.executes.length === 2);
    expect(h.decisionRequests).toHaveLength(1);
    expect(appendedIds(h)).toContain("unmentioned-followup");
  });

  it("answers a rule-matched top-level post in a new thread and then treats it as mentioned", async () => {
    harness = startHarness();
    const h = harness;
    const state = createMemoryState();
    const rules = {
      default: [
        {
          name: "incident",
          when: "The message reports an incident.",
          context: "Use the incident workflow.",
        },
        {
          name: "fallback",
          when: "The message asks for ordinary help.",
          context: "Use the fallback workflow.",
        },
      ],
    };
    const proactivity = fakeProactivity(h, { rules });
    await startBotAndConnect({ proactivity, state });

    h.decisionResponses.push(ruleDecision([0.9, 0.9]));
    h.sendPosted(makePost(ROOT_ID, "database is down"));
    await waitFor(() => h.executes.length === 1);
    await waitFor(() => h.posts.length === 1);
    expect(h.posts[0]).toMatchObject({ root_id: ROOT_ID });
    expect(JSON.stringify(h.executes[0])).toContain("incident workflow");
    expect(JSON.stringify(h.executes[0])).not.toContain("fallback workflow");

    // Remove the operator layer after the first answer; the thread must still
    // be eligible through the mention-equivalent proactive handoff.
    rules.default = [];
    h.decisionResponses.push(respondDecision());
    h.sendPosted(makePost("rule-followup", "what should we check next?", ROOT_ID));
    await waitFor(() => h.executes.length === 2);
    expect(h.decisionRequests).toHaveLength(2);
  });

  it("sends operator context once per harness and again after a harness restart", async () => {
    harness = startHarness();
    const h = harness;
    const state = createMemoryState();
    const proactivity = fakeProactivity(h, {
      rules: {
        default: [{
          name: "incident",
          when: "The message reports an incident.",
          context: "Include the incident commander and the current impact.",
        }],
      },
    });
    await startBotAndConnect({ proactivity, state });

    h.decisionResponses.push(ruleDecision([1]));
    h.sendPosted(makePost(ROOT_ID, "--codex database is down"));
    await waitFor(() => h.executes.length === 1);
    await waitFor(async () => (await threadState(state))?.activeExecution === false);
    expect(JSON.stringify(h.executes[0])).toContain("current impact");

    h.decisionResponses.push(respondDecision(), ruleDecision([1]));
    h.sendPosted(makePost("rule-second", "the outage continues", ROOT_ID));
    await waitFor(() => h.executes.length === 2);
    expect(JSON.stringify(h.executes[1])).not.toContain("current impact");

    h.decisionResponses.push(respondDecision(), ruleDecision([1]));
    h.sendPosted(makePost("rule-restart", "--claude investigate the outage", ROOT_ID));
    await waitFor(() => h.executes.length === 3);
    expect(h.creates[1]).toMatchObject({ on_harness_conflict: "restart" });
    expect(JSON.stringify(h.executes[2])).toContain("current impact");
  });

  it("debounces a burst into one decision and lets a mention take over the burst", async () => {
    harness = startHarness();
    const h = harness;
    const state = createMemoryState();
    await startBotAndConnect({
      proactivity: fakeProactivity(h, { debounceMs: 40 }),
      state,
    });

    h.sendPosted(makePost(ROOT_ID, "@centaur start"));
    await waitFor(() => h.executes.length === 1);
    await waitFor(async () => (await threadState(state))?.activeExecution === false);

    h.decisionResponses.push(respondDecision());
    h.sendPosted(makePost("burst-one", "first part", ROOT_ID));
    h.sendPosted(makePost("burst-two", "second part", ROOT_ID));
    await waitFor(() => h.executes.length === 2);
    expect(JSON.stringify(h.decisionRequests[0])).toContain("first part");
    expect(JSON.stringify(h.decisionRequests[0])).toContain("second part");
    expect(appendedIds(h)).toEqual(
      expect.arrayContaining(["burst-one", "burst-two"]),
    );

    const before = h.decisionRequests.length;
    h.sendPosted(makePost("debounced-old", "old part", ROOT_ID));
    await sleep(5);
    h.sendPosted(makePost("debounced-mention", "@centaur take over", ROOT_ID));
    await waitFor(() => h.executes.length === 3);
    await sleep(60);
    expect(h.decisionRequests).toHaveLength(before);
  });

  it("does not classify top-level posts in a channel whose rule list is empty", async () => {
    harness = startHarness();
    const h = harness;
    const state = createMemoryState();
    await startBotAndConnect({
      proactivity: fakeProactivity(h, {
        rules: {
          default: [{ name: "incident", when: "Any incident." }],
          channels: { [CHANNEL_ID]: [] },
        },
      }),
      state,
    });

    h.sendPosted(makePost(ROOT_ID, "database is down"));
    await sleep(50);
    expect(h.decisionRequests).toHaveLength(0);
    expect(h.executes).toHaveLength(0);
  });

  it("fails closed for failed and timed-out decisions", async () => {
    harness = startHarness();
    const h = harness;
    const state = createMemoryState();
    const bot = await startBotAndConnect({
      proactivity: fakeProactivity(h),
      state,
    });
    h.sendPosted(makePost(ROOT_ID, "@centaur start"));
    await waitFor(() => h.executes.length === 1);
    await waitFor(async () => (await threadState(state))?.activeExecution === false);

    h.decisionFail = 1;
    h.sendPosted(makePost("failed-decision", "please decide", ROOT_ID));
    await sleep(60);
    expect(h.executes).toHaveLength(1);

    h.decisionHold = newGate();
    h.sendPosted(makePost("timed-out-decision", "please decide again", ROOT_ID));
    await waitFor(() => h.decisionRequests.length === 2);
    await sleep(150);
    h.decisionHold.release();
    await sleep(30);
    expect(h.executes).toHaveLength(1);

    const metrics = await (
      await bot.app.fetch(new Request("http://mattermost.test/metrics"))
    ).text();
    expect(metrics).toMatch(
      /mattermostbot_proactive_decisions_total\{outcome="error"\} 2/,
    );
  });

  it("steers a turn that starts while classifying instead of doubling it", async () => {
    harness = startHarness();
    const h = harness;
    const state = createMemoryState();
    await startBotAndConnect({
      proactivity: fakeProactivity(h),
      state,
    });
    h.sendPosted(makePost(ROOT_ID, "@centaur start"));
    await waitFor(() => h.executes.length === 1);
    await waitFor(async () => (await threadState(state))?.activeExecution === false);

    h.decisionHold = newGate();
    h.decisionResponses.push(respondDecision());
    h.sendPosted(makePost("classifying", "continue this", ROOT_ID));
    await waitFor(() => h.decisionRequests.length === 1);
    h.sendPosted(makePost("mention-takeover", "@centaur continue now", ROOT_ID));
    await waitFor(() => h.executes.length === 2);
    h.decisionHold.release();
    await waitFor(() => appendedIds(h).includes("classifying"));
    expect(h.executes).toHaveLength(2);
  });

  it("steers two accepted unmentioned replies into one active execution", async () => {
    harness = startHarness();
    const h = harness;
    h.hold = newGate();
    const state = createMemoryState();
    await startBotAndConnect({
      proactivity: fakeProactivity(h),
      state,
    });
    h.sendPosted(makePost(ROOT_ID, "@centaur start"));
    await waitFor(() => h.eventRequests.length === 1);
    h.decisionResponses.push(respondDecision(), respondDecision());
    h.sendPosted(makePost("accepted-one", "one", ROOT_ID));
    h.sendPosted(makePost("accepted-two", "two", ROOT_ID));
    await waitFor(() => appendedIds(h).includes("accepted-one"));
    await waitFor(() => appendedIds(h).includes("accepted-two"));
    expect(h.executes).toHaveLength(1);
    expect(h.interrupts).toHaveLength(0);
    h.hold.release();
  });

  it("treats an accepted unmentioned stop phrase as a steer, while a mentioned stop silences proactivity", async () => {
    harness = startHarness();
    const h = harness;
    const state = createMemoryState();
    await startBotAndConnect({
      proactivity: fakeProactivity(h),
      state,
    });
    h.sendPosted(makePost(ROOT_ID, "@centaur start"));
    await waitFor(() => h.executes.length === 1);
    await waitFor(async () => (await threadState(state))?.activeExecution === false);

    h.decisionResponses.push(respondDecision());
    h.sendPosted(makePost("accepted-stop", "stop", ROOT_ID));
    await waitFor(() => appendedIds(h).includes("accepted-stop"));
    expect(h.interrupts).toHaveLength(0);

    h.sendPosted(makePost("real-stop", "@centaur stop", ROOT_ID));
    await waitFor(() => h.interrupts.length === 1);
    h.sendPosted(makePost("silenced", "continue without mention", ROOT_ID));
    await sleep(60);
    expect(h.decisionRequests).toHaveLength(1);

    h.sendPosted(makePost("resume", "@centaur resume", ROOT_ID));
    await waitFor(() => h.executes.length === 2);
    h.decisionResponses.push(respondDecision());
    h.sendPosted(makePost("after-resume", "continue now", ROOT_ID));
    await waitFor(() => h.executes.length === 3);
  });
});
