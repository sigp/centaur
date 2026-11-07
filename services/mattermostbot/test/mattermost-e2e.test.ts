import { afterEach, describe, expect, it } from "bun:test";
import { createMemoryState } from "@chat-adapter/state-memory";
import { createMattermostbot } from "../src/index";

let activeServer: ReturnType<typeof Bun.serve> | undefined;
let activeBot: ReturnType<typeof createMattermostbot> | undefined;

afterEach(async () => {
  await activeBot?.chat.shutdown().catch(() => undefined);
  activeBot = undefined;
  activeServer?.stop(true);
  activeServer = undefined;
});

function waitFor(
  predicate: () => boolean,
  timeoutMs = 5_000,
): Promise<void> {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const check = (): void => {
      if (predicate()) {
        resolve();
        return;
      }
      if (Date.now() - started >= timeoutMs) {
        reject(new Error("timed out waiting for fake Mattermost event"));
        return;
      }
      setTimeout(check, 10);
    };
    check();
  });
}

function post(id: string, channelId: string, message: string) {
  return {
    id,
    channel_id: channelId,
    user_id: "user-1",
    message,
    type: "",
    create_at: Date.now(),
    update_at: 0,
    edit_at: 0,
    delete_at: 0,
    is_pinned: false,
    root_id: "",
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

describe("Mattermost real adapter wiring", () => {
  it("authorizes the team, forwards the verbatim thread key, and posts then edits a streamed reply", async () => {
    const sockets: Array<{ send(data: string): void }> = [];
    const sessionCreates: Array<{
      authorization: string | null;
      threadKey: string;
      body: Record<string, unknown>;
    }> = [];
    const sessionAppends: Record<string, unknown>[] = [];
    const sessionExecutes: Array<{
      authorization: string | null;
      threadKey: string;
      body: Record<string, unknown>;
    }> = [];
    const postedReplies: Record<string, unknown>[] = [];
    const editedReplies: Record<string, unknown>[] = [];
    const storedPosts = new Map<string, ReturnType<typeof post>>();

    activeServer = Bun.serve<undefined>({
      port: 0,
      fetch: async (request, server) => {
        const url = new URL(request.url);
        if (url.pathname === "/api/v4/websocket") {
          if (server.upgrade(request)) return undefined;
          return new Response("upgrade failed", { status: 400 });
        }

        if (url.pathname.startsWith("/api/session/")) {
          const pieces = url.pathname.split("/").filter(Boolean);
          const encodedKey = pieces[2] ?? "";
          const threadKey = decodeURIComponent(encodedKey);
          const suffix = pieces[3] ?? "";
          const authorization = request.headers.get("authorization");
          if (request.method === "POST" && !suffix) {
            sessionCreates.push({
              authorization,
              threadKey,
              body: (await request.json()) as Record<string, unknown>,
            });
            return Response.json({ ok: true });
          }
          if (request.method === "POST" && suffix === "messages") {
            sessionAppends.push((await request.json()) as Record<string, unknown>);
            return Response.json({ ok: true });
          }
          if (request.method === "POST" && suffix === "execute") {
            sessionExecutes.push({
              authorization,
              threadKey,
              body: (await request.json()) as Record<string, unknown>,
            });
            return Response.json({
              execution_id: "exec-1",
              ok: true,
              status: "running",
              thread_key: threadKey,
            });
          }
          if (request.method === "GET" && suffix === "events") {
            const sse = [
              `id: 1\nevent: session.output.line\ndata: ${nativeAssistantDelta("first", 1)}\n\n`,
              `id: 2\nevent: session.output.line\ndata: ${nativeAssistantDelta(" streamed reply", 2)}\n\n`,
              "id: 3\nevent: session.execution_completed\ndata: {}\n\n",
            ].join("");
            return new Response(sse, {
              headers: { "content-type": "text/event-stream" },
            });
          }
        }

        if (url.pathname === "/api/v4/users/me") {
          return Response.json({ id: "bot-id", username: "centaur", is_bot: true });
        }
        if (url.pathname === "/api/v4/users/user-1") {
          return Response.json({ id: "user-1", username: "alice", is_bot: false });
        }
        if (url.pathname === "/api/v4/channels/channelallowed") {
          return Response.json({
            id: "channelallowed",
            name: "ops",
            display_name: "Ops",
            team_id: "team-allowed",
            type: "O",
          });
        }
        if (url.pathname === "/api/v4/channels/channeld") {
          return Response.json({
            id: "channeld",
            name: "other",
            display_name: "Other",
            team_id: "team-denied",
            type: "O",
          });
        }
        if (url.pathname === "/api/v4/posts/rootallowed/thread") {
          const root = storedPosts.get("rootallowed") ?? post("rootallowed", "channelallowed", "@centaur hello");
          return Response.json({ order: [root.id], posts: { [root.id]: root } });
        }
        if (url.pathname === "/api/v4/posts/rootallowed") {
          return Response.json(storedPosts.get("rootallowed") ?? post("rootallowed", "channelallowed", "@centaur hello"));
        }
        if (url.pathname === "/api/v4/posts/reply-1" && request.method === "GET") {
          return Response.json(
            storedPosts.get("reply-1") ?? post("reply-1", "channel-allowed", "first"),
          );
        }
        if (url.pathname === "/api/v4/posts" && request.method === "POST") {
          const body = (await request.json()) as Record<string, unknown>;
          const created = {
            ...post(
              "reply-1",
              String(body.channel_id),
              String(body.message ?? ""),
            ),
            user_id: "bot-id",
            root_id: String(body.root_id ?? ""),
          };
          storedPosts.set(created.id, created);
          postedReplies.push(body);
          return Response.json(created);
        }
        if (url.pathname === "/api/v4/posts/reply-1" && request.method === "PUT") {
          const body = (await request.json()) as Record<string, unknown>;
          editedReplies.push(body);
          const updated = {
            ...storedPosts.get("reply-1"),
            ...body,
            id: "reply-1",
            user_id: "bot-id",
          };
          storedPosts.set("reply-1", updated as ReturnType<typeof post>);
          return Response.json(updated);
        }
        return new Response("not found", { status: 404 });
      },
      websocket: {
        open(socket) {
          sockets.push(socket);
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

    const baseUrl = `http://127.0.0.1:${activeServer.port}`;
    activeBot = createMattermostbot({
      apiKey: "MATTERMOSTBOT_API_KEY",
      apiUrl: baseUrl,
      baseUrl,
      botToken: "MATTERMOST_BOT_TOKEN",
      state: createMemoryState(),
      teamAllowlist: ["team-allowed"],
      userName: "centaur",
      websocket: { reconnectDelayMs: 10, maxReconnectDelayMs: 50 },
    });
    await activeBot.chat.initialize();
    await waitFor(() => sockets.length === 1);

    const allowedPost = post("rootallowed", "channelallowed", "@centaur hello");
    storedPosts.set(allowedPost.id, allowedPost);
    sockets[0]?.send(
      JSON.stringify({
        event: "posted",
        data: {
          channel_type: "O",
          post: JSON.stringify(allowedPost),
          sender_name: "alice",
        },
      }),
    );

    await waitFor(
      () =>
        sessionExecutes.length === 1 &&
        postedReplies.length === 1 &&
        editedReplies.length >= 1,
    );

    const expectedThreadKey = "mattermost:Y2hhbm5lbGFsbG93ZWQ:cm9vdGFsbG93ZWQ";
    expect(sessionCreates[0]?.threadKey).toBe(expectedThreadKey);
    expect(sessionCreates[0]?.authorization).toBe(
      "Bearer MATTERMOSTBOT_API_KEY",
    );
    expect(sessionCreates[0]?.body.metadata).toMatchObject({
      platform: "mattermost",
      mattermost_conversation_name: "Ops",
      thread_id: expectedThreadKey,
    });
    expect(sessionExecutes[0]?.threadKey).toBe(expectedThreadKey);
    expect(sessionExecutes[0]?.authorization).toBe(
      "Bearer MATTERMOSTBOT_API_KEY",
    );
    expect(postedReplies[0]).toMatchObject({
      channel_id: "channelallowed",
      root_id: "rootallowed",
    });
    expect(editedReplies.at(-1)).toMatchObject({
      channel_id: "channelallowed",
      root_id: "rootallowed",
    });
    expect(String(editedReplies.at(-1)?.message)).toContain(
      "first streamed reply",
    );

    const deniedPost = post("rootdenied", "channeld", "@centaur no");
    sockets[0]?.send(
      JSON.stringify({
        event: "posted",
        data: {
          channel_type: "O",
          post: JSON.stringify(deniedPost),
          sender_name: "alice",
        },
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(sessionCreates).toHaveLength(1);
    expect(sessionExecutes).toHaveLength(1);
  });
});
