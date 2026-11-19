import { describe, expect, it } from "bun:test";
import {
  createMattermostbot,
  mattermostHealthState,
} from "../src/index";
import { sessionMetadata, toCodexInputLines } from "../src/session-api";
import type {
  MattermostbotApiMessage,
  MattermostAdapterWithHealth,
} from "../src/types";

const message: MattermostbotApiMessage = {
  attachments: [],
  author: {
    fullName: "Alice",
    isBot: false,
    isMe: false,
    userId: "user-1",
    userName: "alice",
  },
  id: "post-1",
  isMention: true,
  raw: {},
  text: "hello",
  threadId: "mattermost:Y2hhbm5lbC0x:cm9vdC0x",
  timestamp: "2026-01-01T00:00:00.000Z",
};

describe("Mattermost runtime contracts", () => {
  it("writes Mattermost platform and conversation metadata", () => {
    expect(
      sessionMetadata(message, {
        mattermost_conversation_name: "Ops",
        action: "execute",
      }),
    ).toEqual({
      source: "mattermostbot",
      platform: "mattermost",
      message_id: "post-1",
      thread_id: message.threadId,
      is_mention: true,
      timestamp: message.timestamp,
      user_id: "user-1",
      user_name: "alice",
      mattermost_conversation_name: "Ops",
      action: "execute",
    });
  });

  it("reports websocket health state", () => {
    let connected = false;
    const adapter = {
      isWebSocketConnected: () => connected,
    } as MattermostAdapterWithHealth;
    expect(mattermostHealthState(adapter)).toBe("disconnected");
    connected = true;
    expect(mattermostHealthState(adapter)).toBe("connected");
  });

  it("serves 503 until the adapter websocket is open", async () => {
    const bot = createMattermostbot({
      apiUrl: "http://api.test",
      baseUrl: "http://mattermost.test",
      botToken: "token",
      state: {
        connect: async () => undefined,
        disconnect: async () => undefined,
      } as never,
    });
    const adapter = bot.adapter as unknown as {
      websocket?: { readyState: number };
    };
    Object.defineProperty(adapter, "websocket", {
      configurable: true,
      value: { readyState: 0 },
    });
    expect((await bot.app.fetch(new Request("http://bot.test/health"))).status).toBe(503);
    Object.defineProperty(adapter, "websocket", {
      configurable: true,
      value: { readyState: 1 },
    });
    expect((await bot.app.fetch(new Request("http://bot.test/health"))).status).toBe(200);
  });

  it("renders earlier human thread messages before a threaded mention", () => {
    const earlierMessage: MattermostbotApiMessage = {
      ...message,
      author: {
        fullName: "Bob",
        isBot: false,
        isMe: false,
        userId: "user-2",
        userName: "bob",
      },
      id: "post-earlier",
      isMention: false,
      raw: { id: "post-earlier", root_id: "root-1" },
      text: "The deploy failed with ENOSPC.",
      timestamp: "2026-01-01T00:01:00.000Z",
    };
    const currentMessage: MattermostbotApiMessage = {
      ...message,
      id: "post-reply",
      raw: { id: "post-reply", root_id: "root-1" },
      text: "@centaur can you try again?",
      timestamp: "2026-01-01T00:02:00.000Z",
    };

    const lines = toCodexInputLines(
      currentMessage,
      currentMessage.threadId,
      undefined,
      undefined,
      undefined,
      [earlierMessage, currentMessage],
    );

    expect(lines.join("\n")).toContain("The deploy failed with ENOSPC.");
    expect(lines.join("\n")).toContain("@centaur can you try again?");
  });

  it("leaves a first message in a new thread without context", () => {
    const lines = toCodexInputLines(message, message.threadId);
    const input = JSON.parse(lines[0]!) as {
      message: { content: Array<{ type: string; text?: string }> };
    };

    expect(lines).toHaveLength(1);
    expect(input.message.content).toEqual([{ type: "text", text: "hello" }]);
  });
});
