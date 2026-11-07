const STANDARD_CODEX_REASONING_EFFORTS = new Set([
  "none",
  "low",
  "medium",
  "high",
  "xhigh",
]);
const PRO_CODEX_REASONING_EFFORTS = new Set(["medium", "high", "xhigh"]);
const CODEX_MODEL_REASONING_EFFORTS = new Set(["low", "medium", "high", "xhigh"]);
const GPT_5_6_REASONING_EFFORTS = new Set([
  ...STANDARD_CODEX_REASONING_EFFORTS,
  "max",
]);
const GPT_6_ULTRA_REASONING_EFFORTS = new Set([
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
]);
const CLAUDE_CODE_REASONING_EFFORTS = new Set([
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);
const PI_REASONING_EFFORTS = new Set([
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);
const NO_REASONING_EFFORTS: ReadonlySet<string> = new Set();
const CLAUDE_NO_XHIGH_REASONING_EFFORTS = new Set([
  "low",
  "medium",
  "high",
  "max",
]);
const CLAUDE_REASONING_EFFORTS_BY_MODEL: Record<string, ReadonlySet<string>> = {
  "claude-haiku-4-5": NO_REASONING_EFFORTS,
  "claude-opus-4": NO_REASONING_EFFORTS,
  "claude-opus-4-0": NO_REASONING_EFFORTS,
  "claude-opus-4-1": NO_REASONING_EFFORTS,
  "claude-opus-4-5": new Set(["low", "medium", "high"]),
  "claude-opus-4-6": CLAUDE_NO_XHIGH_REASONING_EFFORTS,
  "claude-sonnet-4": NO_REASONING_EFFORTS,
  "claude-sonnet-4-0": NO_REASONING_EFFORTS,
  "claude-sonnet-4-5": NO_REASONING_EFFORTS,
  "claude-sonnet-4-6": CLAUDE_NO_XHIGH_REASONING_EFFORTS,
};
const CODEX_REASONING_EFFORTS_BY_MODEL: Record<string, ReadonlySet<string>> = {
  "gpt-5.2": STANDARD_CODEX_REASONING_EFFORTS,
  "gpt-5.2-codex": CODEX_MODEL_REASONING_EFFORTS,
  "gpt-5.4": STANDARD_CODEX_REASONING_EFFORTS,
  "gpt-5.4-mini": STANDARD_CODEX_REASONING_EFFORTS,
  "gpt-5.4-nano": STANDARD_CODEX_REASONING_EFFORTS,
  "gpt-5.4-pro": PRO_CODEX_REASONING_EFFORTS,
  "gpt-5.5": STANDARD_CODEX_REASONING_EFFORTS,
  "gpt-5.5-pro": PRO_CODEX_REASONING_EFFORTS,
  "gpt-5.6-luna": GPT_5_6_REASONING_EFFORTS,
  "gpt-5.6-sol": GPT_5_6_REASONING_EFFORTS,
  "gpt-5.6-terra": GPT_5_6_REASONING_EFFORTS,
  "gpt-6-astra": GPT_6_ULTRA_REASONING_EFFORTS,
  "gpt-6-sol": GPT_5_6_REASONING_EFFORTS,
  "gpt-6.1-sol": GPT_6_ULTRA_REASONING_EFFORTS,
  "gpt-6.1-terra": GPT_6_ULTRA_REASONING_EFFORTS,
  "gpt-6-luna": GPT_5_6_REASONING_EFFORTS,
};

// These are the values baked into the harness images. Explicit deployment
// environment values supplied in `configured` override them.
const BAKED_DEFAULT_MODELS: Record<string, string | undefined> = {
  claudecode: "claude-opus-5-5",
  codex: "gpt-5.6-sol",
  nanocodex: "gpt-5.6-sol",
};
const BAKED_DEFAULT_REASONING: Record<string, string | undefined> = {
  codex: "medium",
  nanocodex: "medium",
};

export function defaultModelForHarness(
  harnessType: string | null | undefined,
  configured?: Record<string, string>,
): string | undefined {
  if (!harnessType) return undefined;
  const key = harnessType.trim().toLowerCase();
  return configured?.[key]?.trim() || BAKED_DEFAULT_MODELS[key];
}

export function defaultReasoningForHarness(
  harnessType: string | null | undefined,
  configured?: Record<string, string>,
): string | undefined {
  if (!harnessType) return undefined;
  const key = harnessType.trim().toLowerCase();
  return configured?.[key]?.trim().toLowerCase() || BAKED_DEFAULT_REASONING[key];
}

export function effectiveReasoningForHarness(
  harnessType: string | null | undefined,
  requested?: string | null,
  configured?: Record<string, string>,
): string | undefined {
  const key = harnessType?.trim().toLowerCase();
  if (key === "claudecode" || key === "pi" || key === "omp") {
    return requested?.trim().toLowerCase() || undefined;
  }
  if (key !== "codex" && key !== "nanocodex") return undefined;
  const reasoning =
    requested?.trim().toLowerCase() || defaultReasoningForHarness(key, configured);
  return key === "nanocodex" && reasoning === "minimal" ? "low" : reasoning;
}

export function reasoningForModel(
  harnessType: string | null | undefined,
  model: string | null | undefined,
  reasoning: string | null | undefined,
): string | undefined {
  const harness = harnessType?.trim().toLowerCase();
  const selectedModel = model?.trim().toLowerCase();
  const effort = reasoning?.trim().toLowerCase();
  if (harness === "claudecode") {
    const supported =
      Object.entries(CLAUDE_REASONING_EFFORTS_BY_MODEL).find(
        ([modelId]) =>
          selectedModel === modelId || selectedModel?.startsWith(`${modelId}-20`),
      )?.[1] ?? CLAUDE_CODE_REASONING_EFFORTS;
    return effort && supported.has(effort) ? effort : undefined;
  }
  if (harness === "pi" || harness === "omp") {
    return effort && PI_REASONING_EFFORTS.has(effort) ? effort : undefined;
  }
  if (!selectedModel || !effort) return undefined;
  if (harness !== "codex" && harness !== "nanocodex") return undefined;
  const effectiveEffort =
    harness === "nanocodex" && effort === "minimal" ? "low" : effort;
  if (selectedModel === "gpt-5.6") {
    return GPT_5_6_REASONING_EFFORTS.has(effectiveEffort) ? effort : undefined;
  }
  const supported = Object.entries(CODEX_REASONING_EFFORTS_BY_MODEL).find(
    ([modelId]) =>
      selectedModel === modelId || selectedModel.startsWith(`${modelId}-20`),
  )?.[1];
  return supported?.has(effectiveEffort) ? effort : undefined;
}
