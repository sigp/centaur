/**
 * Per-channel default persona / harness / model / provider / reasoning. Loaded
 * from MATTERMOSTBOT_CHANNEL_DEFAULTS as JSON keyed by Mattermost channel id.
 * Fields are independent; precedence is per-thread override, then this
 * channel default, then deployment defaults. Harness defaults restart a thread
 * onto that harness, while persona applies only when the session is created.
 */

import { parseMattermostThreadKey } from "./mattermost-allowlist";
import {
  normalizeHarnessOverrides,
  PERSONA_ID_PATTERN,
  type HarnessOverrides,
} from "./overrides";

export type ChannelDefaults = Record<string, HarnessOverrides>;

export function parseChannelDefaults(
  raw: string | undefined,
  onError?: (message: string) => void,
): ChannelDefaults {
  const trimmed = raw?.trim();
  if (!trimmed) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (error) {
    onError?.(
      `invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
    return {};
  }
  if (!isPlainObject(parsed)) {
    onError?.("expected a JSON object keyed by channel id");
    return {};
  }

  const result: ChannelDefaults = {};
  for (const [channelId, rawEntry] of Object.entries(parsed)) {
    const key = channelId.trim();
    if (!key) continue;
    if (!isPlainObject(rawEntry)) {
      onError?.(
        `channel ${key}: expected an object of persona/harness/model/provider/reasoning fields`,
      );
      continue;
    }
    const overrides = normalizeHarnessOverrides(rawEntry, (message) =>
      onError?.(`channel ${key}: ${message}`),
    );
    const persona =
      typeof rawEntry.persona === "string" ? rawEntry.persona.trim() : "";
    if (PERSONA_ID_PATTERN.test(persona)) {
      overrides.personaId = persona;
    } else if (rawEntry.persona !== undefined) {
      onError?.(`channel ${key}: invalid persona id ${JSON.stringify(rawEntry.persona)}`);
    }
    if (
      !overrides.personaId &&
      !overrides.harnessType &&
      !overrides.model &&
      !overrides.provider &&
      !overrides.reasoning
    ) {
      onError?.(
        `channel ${key}: no usable persona/harness/model/provider/reasoning fields`,
      );
      continue;
    }
    result[key] = overrides;
  }
  return result;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function channelIdFromThreadId(threadId: string): string | undefined {
  return parseMattermostThreadKey(threadId).channelId;
}

export function resolveChannelDefault(
  defaults: ChannelDefaults | undefined,
  threadId: string,
): HarnessOverrides | undefined {
  if (!defaults) return undefined;
  const channelId = channelIdFromThreadId(threadId);
  return channelId ? defaults[channelId] : undefined;
}
