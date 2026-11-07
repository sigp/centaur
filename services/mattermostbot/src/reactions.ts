import type { Message as ChatMessage, Thread } from "chat";
import type { MattermostAdapter } from "chat-adapter-mattermost";
import type { MattermostbotOptions } from "./types";
import { elapsedMs, errorMessage, noopLogger, nowMs } from "./utils";
import { mattermostbotMetrics } from "./metrics";

/** `ack` marks a mention that starts a turn; `steering` marks a mentioned follow-up into one. */
export type ReactionKind = "ack" | "steering";

export type ReactionAck = {
  added: Promise<boolean>;
  kind: ReactionKind;
  messageId: string;
  name: string;
  threadId: string;
};

export type ReactionController = {
  /** Adds the reaction in the background; undefined when the kind is off or disabled. */
  begin(
    thread: Thread,
    message: ChatMessage,
    kind: ReactionKind,
  ): ReactionAck | undefined;
  /** Removes one reaction once its add has settled. */
  complete(ack: ReactionAck): Promise<void>;
  /** Removes every reaction held for a thread's running turn. */
  completeThread(threadId: string): Promise<void>;
  /**
   * Removes the reactions a turn recovered after a restart may have left on its
   * message. The process that added them is gone, so nothing is held for it.
   */
  completeRecovered(threadId: string, messageId: string): Promise<void>;
  /** Ties a reaction to the thread's running turn; `completeThread` removes it. */
  hold(ack: ReactionAck): void;
};

type KindState = { disabled: boolean; enabled: boolean; name: string };

type ReactionAdapter = Pick<MattermostAdapter, "addReaction" | "removeReaction">;

const KINDS: readonly ReactionKind[] = ["ack", "steering"];

export function createReactionController(
  options: MattermostbotOptions,
  adapter: ReactionAdapter,
): ReactionController {
  const logger = options.logger ?? noopLogger;
  const kinds: Record<ReactionKind, KindState> = {
    ack: {
      disabled: false,
      enabled: options.ackReactionEnabled ?? true,
      name: normalizeReactionName(options.ackReactionName, "eyes"),
    },
    steering: {
      disabled: false,
      enabled: options.steeringReactionEnabled === true,
      name: normalizeReactionName(
        options.steeringReactionName,
        "hourglass_flowing_sand",
      ),
    },
  };
  // Deliberately process-local: reactions are best-effort UI state. A restart
  // may leave an old reaction behind instead of coupling render recovery to
  // reaction bookkeeping (recovered turns clear their own message's reactions).
  const pending = new Map<string, Map<string, ReactionAck>>();

  const update = async (
    operation: "add" | "remove",
    kind: ReactionKind,
    threadId: string,
    messageId: string,
    name: string,
  ): Promise<boolean> => {
    const state = kinds[kind];
    // Once an add succeeded, its paired cleanup still runs after a concurrent
    // refusal has disabled future adds.
    if (state.disabled && operation === "add") return false;
    const startedAtMs = nowMs();
    try {
      if (operation === "add") {
        await adapter.addReaction(threadId, messageId, name);
      } else {
        await adapter.removeReaction(threadId, messageId, name);
      }
      mattermostbotMetrics.reactions.inc({
        kind,
        operation,
        outcome: "success",
      });
      return true;
    } catch (error) {
      // Removing a reaction that is already gone is the state we want.
      if (operation === "remove" && isNotFound(error)) {
        mattermostbotMetrics.reactions.inc({
          kind,
          operation,
          outcome: "success",
        });
        return true;
      }
      if (isRefused(error)) {
        mattermostbotMetrics.reactions.inc({
          kind,
          operation,
          outcome: "refused",
        });
        if (!state.disabled) {
          state.disabled = true;
          mattermostbotMetrics.reactionKindsDisabled.set({ kind }, 1);
          logger.warn("mattermostbot_reaction_auto_disabled", {
            error: errorMessage(error),
            kind,
            message_id: messageId,
            operation,
            thread_id: threadId,
          });
        }
        return false;
      }
      // Reactions are UI polish: a failure must never fail persistence,
      // steering, rendering, or event handling.
      logger.warn("mattermostbot_reaction_failed", {
        error: errorMessage(error),
        kind,
        message_id: messageId,
        operation,
        phase_ms: elapsedMs(startedAtMs),
        thread_id: threadId,
      });
      mattermostbotMetrics.reactions.inc({
        kind,
        operation,
        outcome: "error",
      });
      return false;
    }
  };

  const completeAck = async (ack: ReactionAck): Promise<void> => {
    if (!(await ack.added)) return;
    await update("remove", ack.kind, ack.threadId, ack.messageId, ack.name);
  };

  return {
    begin(thread, message, kind) {
      const state = kinds[kind];
      if (!state.enabled || state.disabled) return undefined;
      return {
        added: update("add", kind, thread.id, message.id, state.name),
        kind,
        messageId: message.id,
        name: state.name,
        threadId: thread.id,
      };
    },
    complete(ack) {
      const reactions = pending.get(ack.threadId);
      reactions?.delete(ackKey(ack));
      if (reactions?.size === 0) pending.delete(ack.threadId);
      return completeAck(ack);
    },
    async completeThread(threadId) {
      const reactions = Array.from(pending.get(threadId)?.values() ?? []);
      pending.delete(threadId);
      await Promise.all(reactions.map(completeAck));
    },
    async completeRecovered(threadId, messageId) {
      await this.completeThread(threadId);
      await Promise.all(
        KINDS.map((kind) => {
          const state = kinds[kind];
          if (!state.enabled || state.disabled) return undefined;
          return update("remove", kind, threadId, messageId, state.name);
        }),
      );
    },
    hold(ack) {
      const reactions =
        pending.get(ack.threadId) ?? new Map<string, ReactionAck>();
      reactions.set(ackKey(ack), ack);
      pending.set(ack.threadId, reactions);
    },
  };
}

function ackKey(ack: ReactionAck): string {
  return `${ack.messageId}:${ack.name}`;
}

function normalizeReactionName(
  value: string | undefined,
  fallback: string,
): string {
  return value?.trim().replace(/^:+|:+$/g, "") || fallback;
}

/** Mattermost answers a reaction it will not accept with 401/403. */
function isRefused(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === "PermissionError" || error.name === "AuthenticationError")
  );
}

function isNotFound(error: unknown): boolean {
  return error instanceof Error && error.name === "ResourceNotFoundError";
}
