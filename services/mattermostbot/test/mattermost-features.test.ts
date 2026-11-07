import { describe, expect, it } from "bun:test";
import { createFlagMessageOverridesStrategy, createOpenAiMessageOverridesStrategy } from "../src/message-overrides-strategy";
import {
  extractMessageOverrides,
  extractPersonaOverride,
} from "../src/overrides";
import { isMattermostStopCommand } from "../src/stop-command";
import { parseChannelDefaults, resolveChannelDefault } from "../src/channel-defaults";
import {
  interruptSessionExecution,
  serializeAttachment,
} from "../src/session-api";
import type { MattermostbotApiAttachment } from "../src/types";

describe("Mattermost chat controls", () => {
  it("strips inline flags and keeps persona separate", async () => {
    const parsed = extractMessageOverrides(
      "@centaur --claude --model opus --provider bedrock -rsn high inspect this",
    );
    expect(parsed).toEqual({
      cleanedText: "@centaur inspect this",
      harnessType: "claudecode",
      model: "claude-opus-5-5",
      provider: "amazon-bedrock",
      reasoning: "high",
    });
    expect(extractPersonaOverride("--persona reviewer inspect this")).toEqual({
      cleanedText: "inspect this",
      personaId: "reviewer",
    });

    const strategy = createFlagMessageOverridesStrategy();
    await expect(
      strategy({ text: "--codex --model gpt-5.6-luna inspect this" }),
    ).resolves.toEqual({
      cleanedText: "inspect this",
      overrides: { harnessType: "codex", model: "gpt-5.6-luna" },
    });
  });

  it("matches only mentioned stop commands", () => {
    expect(isMattermostStopCommand({ text: "@centaur stop" })).toBe(true);
    expect(isMattermostStopCommand({ text: "please @centaur cancel now" })).toBe(true);
    expect(isMattermostStopCommand({ text: "@centaur stopping by" })).toBe(false);
    expect(isMattermostStopCommand({ text: "cancel the invite" })).toBe(false);
  });

  it("resolves channel defaults by Mattermost channel id", () => {
    const defaults = parseChannelDefaults(
      JSON.stringify({
        ops: { harness: "claude", model: "opus", reasoning: "high" },
      }),
    );
    expect(resolveChannelDefault(defaults, "mattermost:b3Bz:cm9vdA")).toEqual({
      harnessType: "claudecode",
      model: "claude-opus-5-5",
      provider: undefined,
      reasoning: "high",
    });
  });

  it("falls back on an OpenAI-compatible strategy failure and timeout", async () => {
    const failed = createOpenAiMessageOverridesStrategy({
      apiKey: "key",
      fetch: (async () => new Response("failed", { status: 503 })) as unknown as typeof fetch,
      model: "gpt-6-luna",
    });
    await expect(failed({ text: "use claude for this" })).resolves.toEqual({
      overrides: {},
    });

    const timedOut = createOpenAiMessageOverridesStrategy({
      apiKey: "key",
      fetch: (async (_input, init) =>
        await new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        })) as typeof fetch,
      model: "gpt-6-luna",
      timeoutMs: 5,
    });
    await expect(timedOut({ text: "use codex for this" })).resolves.toEqual({
      overrides: {},
    });
  });

  it("keeps Mattermost attachment authorization on the configured origin", async () => {
    const requests: Array<{ url: string; authorization: string | null; redirect: RequestRedirect }> = [];
    const fetchAttachment = async (input: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      requests.push({
        url: String(input),
        authorization: headers.get("authorization"),
        redirect: init?.redirect ?? "follow",
      });
      if (requests.length === 1) {
        return new Response(null, {
          headers: { location: "http://foreign.test/file" },
          status: 302,
        });
      }
      return new Response("attachment");
    };
    const attachment = {
      type: "file",
      url: "http://mattermost.test/api/v4/files/file-id",
      name: "report.txt",
    } as MattermostbotApiAttachment;
    const serialized = await serializeAttachment(attachment, fetchAttachment, {
      baseUrl: "http://mattermost.test",
      botToken: "secret",
    });
    expect(serialized.dataBase64).toBe(
      Buffer.from("attachment").toString("base64"),
    );
    expect(requests).toEqual([
      {
        url: "http://mattermost.test/api/v4/files/file-id",
        authorization: "Bearer secret",
        redirect: "manual",
      },
      {
        url: "http://foreign.test/file",
        authorization: null,
        redirect: "manual",
      },
    ]);
  });

  it("posts the api-rs interrupt request with its reason", async () => {
    let request: Request | undefined;
    const response = await interruptSessionExecution(
      {
        apiKey: "api-key",
        apiUrl: "http://api.test",
        baseUrl: "http://mattermost.test",
        botToken: "mattermost-token",
        fetch: async (input, init) => {
          request = new Request(input, init);
          return Response.json({
            execution_id: "exec-1",
            interrupted: true,
            ok: true,
            thread_key: "mattermost:Y2hhbm5lbA:cm9vdA",
          });
        },
      },
      "mattermost:Y2hhbm5lbA:cm9vdA",
      "Interrupted from Mattermost by user-1",
    );
    expect(response).toEqual({
      execution_id: "exec-1",
      interrupted: true,
      ok: true,
      thread_key: "mattermost:Y2hhbm5lbA:cm9vdA",
    });
    expect(request?.url).toBe(
      "http://api.test/api/session/mattermost%3AY2hhbm5lbA%3Acm9vdA/interrupt",
    );
    expect(request?.headers.get("authorization")).toBe("Bearer api-key");
    expect(await request?.json()).toEqual({
      reason: "Interrupted from Mattermost by user-1",
    });
  });
});
