// Reliability behaviour of the Mattermost runtime, driven through the real
// chat-adapter-mattermost against a fake Mattermost server and a fake api-rs
// (same harness style as mattermost-e2e.test.ts): background execution with
// follow-ups appended mid-turn, transient create/append retry, bounded render
// retries, render-obligation recovery on startup, and long-answer splitting.
import { afterEach, describe, expect, it } from "bun:test";
import { createMemoryState } from "@chat-adapter/state-memory";
import type { StateAdapter } from "chat";
import {
  createMattermostbot,
  type Mattermostbot,
  type MattermostbotApiMessage,
  type MattermostbotOptions,
} from "../src/index";

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
  edits: Record<string, unknown>[];
  eventRequests: Array<{ executionId: string | null; threadKey: string }>;
  executes: Record<string, unknown>[];
  /** Number of upcoming append requests to answer with 503. */
  failAppends: number;
  /** Answer every event-stream open with 503. */
  failEvents: boolean;
  /** Text streamed as the final answer, one delta per entry. */
  answerChunks: string[];
  /** When set, the event stream emits its first delta, then waits on this. */
  hold: { promise: Promise<void>; release(): void } | null;
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
    failAppends: 0,
    failEvents: false,
    hold: null,
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

      if (url.pathname.startsWith("/api/session/")) {
        const pieces = url.pathname.split("/").filter(Boolean);
        const threadKey = decodeURIComponent(pieces[2] ?? "");
        const suffix = pieces[3] ?? "";
        if (request.method === "POST" && !suffix) {
          harness.creates.push((await request.json()) as Record<string, unknown>);
          return Response.json({ ok: true });
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
          harness.executes.push((await request.json()) as Record<string, unknown>);
          return Response.json({
            execution_id: "exec-1",
            ok: true,
            status: "running",
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
          const encoder = new TextEncoder();
          const body = new ReadableStream<Uint8Array>({
            async start(controller) {
              let id = 1;
              for (const [index, chunk] of chunks.entries()) {
                controller.enqueue(encoder.encode(sseOutputLine(id++, chunk)));
                if (index === 0 && hold) await hold.promise;
              }
              controller.enqueue(
                encoder.encode(
                  `id: ${id}\nevent: session.execution_completed\ndata: {}\n\n`,
                ),
              );
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
      const threadMatch = url.pathname.match(/^\/api\/v4\/posts\/([^/]+)\/thread$/);
      if (threadMatch) {
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

    h.sendPosted(makePost("followup1", "also look at the logs", ROOT_ID));
    await waitFor(() => appendedIds(h).includes("followup1"));

    // The follow-up must not have started a second execution.
    expect(h.executes).toHaveLength(1);

    h.hold.release();
    await waitFor(async () => (await threadState(state))?.activeExecution === false);
    expect(h.botPostTexts().join("\n")).toContain("first streamed reply");
    expect(h.executes).toHaveLength(1);
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
    await startBotAndConnect({ state });

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
});
