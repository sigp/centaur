const STOP_COMMAND_PATTERN = new RegExp(
  [
    String.raw`^`,
    String.raw`(?:(?:please|pls)\s+)?`,
    String.raw`(?:(?:can|could|would|will)\s+you\s+)?`,
    String.raw`(?:stop+|kill(?:ed|ing|s)?|end(?:ed|ing|s)?|cancell?(?:ed|ing|s)?)`,
    String.raw`(?:\s+(?:it|this|that|now|please|pls|the\s+(?:run|execution|request|job|thread|turn)))*`,
    String.raw`[.!?]*$`,
  ].join(""),
  "i",
);

/** Detect a mentioned Mattermost stop command after mention normalization. */
export function isMattermostStopCommand(message: { text: string }): boolean {
  const text = message.text.trim();
  if (!text) return false;
  const withoutMentions = text
    .replace(/<@[A-Za-z0-9._-]+>/g, " ")
    .replace(/(^|\s)@[A-Za-z0-9._-]+/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
  return STOP_COMMAND_PATTERN.test(withoutMentions);
}
