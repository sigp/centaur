import { describe, expect, it } from "bun:test";
import type { Logger, Message } from "chat";
import {
  clearMattermostChannelCacheForTests,
  encodeMattermostThreadKey,
  isAllowedMattermostMessage,
  parseMattermostThreadKey,
  resolveMattermostTeamAllowlist,
  splitMattermostEnvList,
} from "../src/mattermost-allowlist";
import type { MattermostbotOptions } from "../src/types";

const logger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => logger,
};

function message(input: {
  id?: string;
  threadId?: string;
  author?: Partial<Message["author"]>;
  raw?: unknown;
} = {}): Message {
  return {
    id: input.id ?? "post-1",
    threadId:
      input.threadId ?? encodeMattermostThreadKey("channel1", "root1"),
    text: "@centaur hello",
    isMention: true,
    raw: input.raw ?? {},
    author: {
      fullName: "Alice",
      userId: "user-1",
      userName: "alice",
      isBot: false,
      isMe: false,
      ...input.author,
    },
    metadata: { dateSent: new Date(), edited: false },
    attachments: [],
    formatted: { type: "root", children: [] },
  } as unknown as Message;
}

function options(
  fetchFn: MattermostbotOptions["fetch"],
  extra: Partial<MattermostbotOptions> = {},
): MattermostbotOptions {
  return {
    apiUrl: "http://api.test",
    baseUrl: "http://mattermost.test",
    botToken: "mattermost-token",
    fetch: fetchFn,
    state: {} as never,
    teamAllowlist: ["team-allowed"],
    ...extra,
  };
}

function channelFetch(
  type = "O",
  teamId = "team-allowed",
  calls: { count: number } = { count: 0 },
): MattermostbotOptions["fetch"] {
  return async () => {
    calls.count += 1;
    return Response.json({
      id: "channel-1",
      name: "ops",
      display_name: "Ops",
      team_id: teamId,
      type,
    });
  };
}

describe("Mattermost allowlist", () => {
  it("is inert and does not fetch channels when the team allowlist is unset", async () => {
    delete process.env.MATTERMOSTBOT_TEAM_ALLOWLIST;
    const calls = { count: 0 };
    const allowed = await isAllowedMattermostMessage(
      message(),
      options(channelFetch("O", "team-allowed", calls), {
        teamAllowlist: undefined,
      }),
      logger,
    );
    expect(allowed).toBe(false);
    expect(calls.count).toBe(0);
  });

  it("allows a normal post in an allowlisted team and denies another team", async () => {
    clearMattermostChannelCacheForTests();
    const allowed = await isAllowedMattermostMessage(
      message(),
      options(channelFetch()),
      logger,
    );
    expect(allowed).toBe(true);

    clearMattermostChannelCacheForTests();
    const denied = await isAllowedMattermostMessage(
      message(),
      options(channelFetch("O", "team-other")),
      logger,
    );
    expect(denied).toBe(false);
  });

  it("denies direct-message and group-message channels by default", async () => {
    clearMattermostChannelCacheForTests();
    expect(
      await isAllowedMattermostMessage(
        message(),
        options(channelFetch("D")),
        logger,
      ),
    ).toBe(false);
    clearMattermostChannelCacheForTests();
    expect(
      await isAllowedMattermostMessage(
        message(),
        options(channelFetch("D"), { directMessages: true }),
        logger,
      ),
    ).toBe(true);
    clearMattermostChannelCacheForTests();
    expect(
      await isAllowedMattermostMessage(
        message(),
        options(channelFetch("G"), { directMessages: true }),
        logger,
      ),
    ).toBe(false);
  });

  it("accepts an allowlisted team name as well as its id", async () => {
    clearMattermostChannelCacheForTests();
    expect(
      await isAllowedMattermostMessage(
        message(),
        options(channelFetch("O", "team-allowed"), {
          teamAllowlist: ["ops"],
        }),
        logger,
      ),
    ).toBe(true);
  });

  it("denies the bot's own post and non-allowlisted bot posts", async () => {
    clearMattermostChannelCacheForTests();
    expect(
      await isAllowedMattermostMessage(
        message({ author: { isMe: true } }),
        options(channelFetch()),
        logger,
      ),
    ).toBe(false);

    clearMattermostChannelCacheForTests();
    expect(
      await isAllowedMattermostMessage(
        message({ author: { isBot: true, userId: "bot-other" } }),
        options(channelFetch()),
        logger,
      ),
    ).toBe(false);
  });

  it("allows a bot post only when its author is trigger-allowlisted", async () => {
    clearMattermostChannelCacheForTests();
    const allowed = await isAllowedMattermostMessage(
      message({ author: { isBot: true, userId: "bot-other" } }),
      options(channelFetch(), { triggerBotAllowlist: ["bot-other"] }),
      logger,
    );
    expect(allowed).toBe(true);
  });

  it("parses and emits the adapter thread-key format without padding", () => {
    const key = encodeMattermostThreadKey("abc123", "root456");
    expect(key).toBe("mattermost:YWJjMTIz:cm9vdDQ1Ng");
    expect(parseMattermostThreadKey(key)).toEqual({
      channelId: "abc123",
      rootPostId: "root456",
    });
    expect(parseMattermostThreadKey("mattermost:not-base64!:root")).toEqual({});
    expect(parseMattermostThreadKey("slack:abc")).toEqual({});
  });

  it("splits allowlists on commas and whitespace", () => {
    expect(splitMattermostEnvList(" team-a,team-b\nteam-c  ")).toEqual([
      "team-a",
      "team-b",
      "team-c",
    ]);
    expect(
      resolveMattermostTeamAllowlist({
        apiUrl: "http://api.test",
        baseUrl: "http://mm.test",
        botToken: "token",
        teamAllowlist: ["team-x", " team-y "],
      }),
    ).toEqual(["team-x", "team-y"]);
  });
});
