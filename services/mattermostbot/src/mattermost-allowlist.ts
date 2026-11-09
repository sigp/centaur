import type { Logger, Message } from "chat";
import type { MattermostPost } from "chat-adapter-mattermost";
import type { MattermostbotOptions } from "./types";

export type MattermostChannelRecord = {
  id: string;
  name?: string;
  display_name?: string;
  type?: string;
  team_id?: string;
};

export type MattermostTeamRecord = {
  id: string;
  name?: string;
  display_name?: string;
};

export type ParsedMattermostThreadKey = {
  channelId?: string;
  rootPostId?: string;
};

const CHANNEL_CACHE_TTL_MS = 5 * 60 * 1000;
const CHANNEL_MISS_TTL_MS = 15 * 1000;
type ChannelCacheEntry = {
  channel?: MattermostChannelRecord;
  expiresAt: number;
};
const channelCache = new Map<string, ChannelCacheEntry>();
type TeamCacheEntry = {
  team?: MattermostTeamRecord;
  expiresAt: number;
};
const teamCache = new Map<string, TeamCacheEntry>();

/** Decode the adapter's verbatim `mattermost:<b64url>[:<b64url>]` key. */
export function parseMattermostThreadKey(
  threadKey: string,
): ParsedMattermostThreadKey {
  const parts = threadKey.split(":");
  if (parts.length < 2 || parts.length > 3 || parts[0] !== "mattermost") {
    return {};
  }
  const channelId = decodeId(parts[1]);
  const rootPostId = parts[2] ? decodeId(parts[2]) : undefined;
  if (!channelId || (parts[2] && !rootPostId)) return {};
  return { channelId, rootPostId };
}

/** Encode an id exactly as chat-adapter-mattermost does. */
export function encodeMattermostThreadKey(
  channelId: string,
  rootPostId?: string,
): string {
  const channel = Buffer.from(channelId).toString("base64url");
  return rootPostId
    ? `mattermost:${channel}:${Buffer.from(rootPostId).toString("base64url")}`
    : `mattermost:${channel}`;
}

export function resolveMattermostTeamAllowlist(
  options: MattermostbotOptions,
): string[] {
  return options.teamAllowlist
    ? [...options.teamAllowlist].map((value) => value.trim()).filter(Boolean)
    : splitEnvList(process.env.MATTERMOSTBOT_TEAM_ALLOWLIST);
}

export function resolveMattermostTriggerBotAllowlist(
  options: MattermostbotOptions,
): string[] {
  return options.triggerBotAllowlist
    ? [...options.triggerBotAllowlist].map((value) => value.trim()).filter(Boolean)
    : splitEnvList(process.env.MATTERMOSTBOT_TRIGGER_BOT_ALLOWLIST);
}

export function isMattermostAllowlistEmpty(options: MattermostbotOptions): boolean {
  return resolveMattermostTeamAllowlist(options).length === 0;
}

export function isMattermostTeamAllowed(
  teamId: string | undefined,
  options: MattermostbotOptions,
): boolean {
  return Boolean(
    teamId && resolveMattermostTeamAllowlist(options).includes(teamId),
  );
}

export function isMattermostDirectMessagesEnabled(
  options: MattermostbotOptions,
): boolean {
  return (
    options.directMessages ??
    ["1", "true", "yes", "on"].includes(
      process.env.MATTERMOSTBOT_DIRECT_MESSAGES?.trim().toLowerCase() ?? "",
    )
  );
}

export async function isMattermostTeamRecordAllowed(
  channel: Pick<MattermostChannelRecord, "team_id">,
  options: MattermostbotOptions,
): Promise<boolean> {
  const teamId = channel.team_id;
  if (!teamId) return false;
  const allowlist = resolveMattermostTeamAllowlist(options);
  if (allowlist.includes(teamId)) return true;
  const team = await fetchMattermostTeam(options, teamId).catch(
    () => undefined,
  );
  // Team names are unique URL slugs; display names are not, and any team admin
  // can set one, so they never match.
  return Boolean(team?.name && allowlist.includes(team.name));
}

/**
 * Fail-closed message authorization. Channel data is read from REST rather
 * than trusting the adapter's websocket cache, which intentionally stores only
 * a small channel stub for posted events.
 */
export async function isAllowedMattermostMessage(
  message: Message,
  options: MattermostbotOptions,
  logger: Logger,
): Promise<boolean> {
  if (message.author.isMe === true) return false;

  const allowlist = resolveMattermostTeamAllowlist(options);
  if (allowlist.length === 0) {
    logger.warn("mattermostbot_team_allowlist_empty_inert", {
      message_id: message.id,
      thread_id: message.threadId,
    });
    return false;
  }

  const parsed = parseMattermostThreadKey(message.threadId);
  if (!parsed.channelId) {
    logger.warn("mattermostbot_message_ignored_invalid_thread", {
      message_id: message.id,
      thread_id: message.threadId,
    });
    return false;
  }

  let channel: MattermostChannelRecord;
  try {
    channel = await fetchMattermostChannel(options, parsed.channelId);
  } catch (error) {
    logger.warn("mattermostbot_message_ignored_channel_lookup_failed", {
      error: error instanceof Error ? error.message : String(error),
      message_id: message.id,
      thread_id: message.threadId,
    });
    return false;
  }

  const directMessages = isMattermostDirectMessagesEnabled(options);
  if (
    channel.type === "G" ||
    (channel.type === "D" && !directMessages)
  ) {
    logger.warn("mattermostbot_message_ignored_direct_or_group", {
      channel_type: channel.type,
      message_id: message.id,
      thread_id: message.threadId,
    });
    return false;
  }
  if (
    channel.type !== "D" &&
    !(await isMattermostTeamRecordAllowed(channel, options))
  ) {
    logger.warn("mattermostbot_message_ignored_team_not_allowlisted", {
      message_id: message.id,
      team_id: channel.team_id,
      thread_id: message.threadId,
    });
    return false;
  }

  if (isMattermostBotMessage(message)) {
    const triggerAllowlist = resolveMattermostTriggerBotAllowlist(options);
    if (!triggerAllowlist.includes(message.author.userId)) {
      logger.warn("mattermostbot_message_ignored_bot_not_allowlisted", {
        message_id: message.id,
        thread_id: message.threadId,
        user_id: message.author.userId,
      });
      return false;
    }
  }

  return true;
}

export function isMattermostBotMessage(
  message: Pick<Message, "author" | "raw">,
): boolean {
  if (message.author.isBot === true) return true;
  const raw = message.raw;
  if (!raw || typeof raw !== "object") return false;
  const props = (raw as MattermostPost).props;
  if (!props || typeof props !== "object") return false;
  return props.from_bot === true || props.from_webhook === true;
}

export async function resolveMattermostConversationName(
  options: MattermostbotOptions,
  threadKey: string,
): Promise<string | undefined> {
  const channelId = parseMattermostThreadKey(threadKey).channelId;
  if (!channelId) return undefined;
  const channel = await fetchMattermostChannel(options, channelId).catch(
    () => undefined,
  );
  return channel?.display_name?.trim() || channel?.name?.trim() || undefined;
}

export async function fetchMattermostChannel(
  options: MattermostbotOptions,
  channelId: string,
): Promise<MattermostChannelRecord> {
  const base = options.baseUrl.replace(/\/$/, "");
  const cacheKey = `${base}\0${channelId}`;
  const cached = channelCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    if (!cached.channel) throw new Error("Mattermost channel lookup unavailable");
    return cached.channel;
  }

  const fetchFn = options.fetch ?? fetch;
  let response: Response;
  try {
    response = await fetchFn(`${base}/api/v4/channels/${encodeURIComponent(channelId)}`, {
      headers: { authorization: `Bearer ${options.botToken}` },
    });
  } catch (error) {
    channelCache.set(cacheKey, { expiresAt: Date.now() + CHANNEL_MISS_TTL_MS });
    throw error;
  }
  if (!response.ok) {
    channelCache.set(cacheKey, { expiresAt: Date.now() + CHANNEL_MISS_TTL_MS });
    throw new Error(`Mattermost channel lookup failed: ${response.status}`);
  }
  const channel = (await response.json()) as MattermostChannelRecord;
  channelCache.set(cacheKey, {
    channel,
    expiresAt: Date.now() + CHANNEL_CACHE_TTL_MS,
  });
  return channel;
}

export async function fetchMattermostTeam(
  options: MattermostbotOptions,
  teamId: string,
): Promise<MattermostTeamRecord> {
  const base = options.baseUrl.replace(/\/$/, "");
  const cacheKey = `${base}\0${teamId}`;
  const cached = teamCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    if (!cached.team) throw new Error("Mattermost team lookup unavailable");
    return cached.team;
  }

  const fetchFn = options.fetch ?? fetch;
  let response: Response;
  try {
    response = await fetchFn(
      `${base}/api/v4/teams/${encodeURIComponent(teamId)}`,
      { headers: { authorization: `Bearer ${options.botToken}` } },
    );
  } catch (error) {
    teamCache.set(cacheKey, { expiresAt: Date.now() + CHANNEL_MISS_TTL_MS });
    throw error;
  }
  if (!response.ok) {
    teamCache.set(cacheKey, { expiresAt: Date.now() + CHANNEL_MISS_TTL_MS });
    throw new Error(`Mattermost team lookup failed: ${response.status}`);
  }
  const team = (await response.json()) as MattermostTeamRecord;
  teamCache.set(cacheKey, {
    team,
    expiresAt: Date.now() + CHANNEL_CACHE_TTL_MS,
  });
  return team;
}

export function clearMattermostChannelCacheForTests(): void {
  channelCache.clear();
  teamCache.clear();
}


export function splitMattermostEnvList(value: string | undefined): string[] {
  return splitEnvList(value);
}

function splitEnvList(value: string | undefined): string[] {
  return (value ?? "")
    .split(/[\s,]+/)
    .map((part) => part.trim())
    .filter(Boolean);
}

function decodeId(segment: string | undefined): string | undefined {
  if (!segment || !/^[A-Za-z0-9_-]+$/.test(segment)) return undefined;
  try {
    const decoded = Buffer.from(segment, "base64url").toString();
    const encoded = Buffer.from(decoded).toString("base64url");
    if (encoded !== segment || !/^[a-z0-9]+$/.test(decoded)) return undefined;
    return decoded;
  } catch {
    return undefined;
  }
}
