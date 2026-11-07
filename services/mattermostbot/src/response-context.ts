import claudeSettings from "../../../harness/claude/settings.json";
import codexConfig from "../../../harness/codex/config.toml";

const HARNESS_DISPLAY_NAMES: Record<string, string> = {
  amp: "Amp",
  claudecode: "Claude Code",
  codex: "Codex",
  nanocodex: "Nanocodex",
  pi: "Pi",
  omp: "OMP",
};

const REASONING_DISPLAY_NAMES: Record<string, string> = {
  none: "None",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "XHigh",
  max: "Max",
  ultra: "Ultra",
};

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

const CODEX_CONFIG = codexConfig as {
  model?: unknown;
  model_reasoning_effort?: unknown;
  service_tier?: unknown;
};
const HARNESS_DEFAULT_MODELS: Record<string, string | undefined> = {
  claudecode:
    typeof claudeSettings.model === "string" ? claudeSettings.model : undefined,
  codex: typeof CODEX_CONFIG.model === "string" ? CODEX_CONFIG.model : undefined,
  nanocodex:
    typeof CODEX_CONFIG.model === "string" ? CODEX_CONFIG.model : undefined,
};
const HARNESS_DEFAULT_REASONING: Record<string, string | undefined> = {
  codex:
    typeof CODEX_CONFIG.model_reasoning_effort === "string"
      ? CODEX_CONFIG.model_reasoning_effort
      : undefined,
  nanocodex:
    typeof CODEX_CONFIG.model_reasoning_effort === "string"
      ? CODEX_CONFIG.model_reasoning_effort
      : undefined,
};
const HARNESS_DEFAULT_SERVICE_TIERS: Record<string, string | undefined> = {
  codex:
    typeof CODEX_CONFIG.service_tier === "string"
      ? CODEX_CONFIG.service_tier
      : undefined,
};

export function harnessDisplayName(
  harnessType: string | null | undefined,
): string | undefined {
  if (!harnessType) return undefined;
  const key = harnessType.trim().toLowerCase();
  if (!key) return undefined;
  return HARNESS_DISPLAY_NAMES[key] ?? titleCase(key);
}

export function defaultModelForHarness(
  harnessType: string | null | undefined,
  configured?: Record<string, string>,
): string | undefined {
  if (!harnessType) return undefined;
  const key = harnessType.trim().toLowerCase();
  return configured?.[key]?.trim() || HARNESS_DEFAULT_MODELS[key];
}

export function defaultReasoningForHarness(
  harnessType: string | null | undefined,
  configured?: Record<string, string>,
): string | undefined {
  if (!harnessType) return undefined;
  const key = harnessType.trim().toLowerCase();
  return configured?.[key]?.trim().toLowerCase() || HARNESS_DEFAULT_REASONING[key];
}

export function defaultServiceTierForHarness(
  harnessType: string | null | undefined,
): string | undefined {
  if (!harnessType) return undefined;
  return HARNESS_DEFAULT_SERVICE_TIERS[harnessType.trim().toLowerCase()];
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

const CLAUDE_MODEL_ID =
  /^claude-([a-z]+)((?:-\d{1,2})*)((?:-[a-z]+)*)(?:-\d{8})?$/;
const GPT_MODEL_ID =
  /^gpt-(\d+(?:\.\d+)?)((?:-[a-z]+)*)(?:-\d{4}-\d{2}-\d{2})?$/;
const GPT_CODENAMES = new Set(["sol", "luna", "terra", "astra"]);

export function modelDisplayName(model: string): string {
  const id = model.toLowerCase();
  const gpt = GPT_MODEL_ID.exec(id);
  if (gpt) {
    const [, version = "", variant = ""] = gpt;
    const word = variant.slice(1);
    if (GPT_CODENAMES.has(word)) return `${titleCase(word)} ${version}`;
    return ["GPT", version, titleCase(variant)].filter(Boolean).join(" ");
  }
  const claude = CLAUDE_MODEL_ID.exec(id);
  if (!claude) return model.toUpperCase();
  const [, family = "", version = "", variant = ""] = claude;
  return [titleCase(family), version.slice(1).replace(/-/g, "."), titleCase(variant)]
    .filter(Boolean)
    .join(" ");
}

function reasoningDisplayName(
  reasoning: string | null | undefined,
): string | undefined {
  const key = reasoning?.trim().toLowerCase();
  if (!key) return undefined;
  return REASONING_DISPLAY_NAMES[key] ?? titleCase(key);
}

export function personaFallbackNotice(
  unavailablePersonaId: string | undefined,
  personaId: string | null | undefined,
): string | undefined {
  if (!unavailablePersonaId) return undefined;
  return personaId
    ? `Persona "${unavailablePersonaId}" isn't available. Using "${personaId}" instead.`
    : `Persona "${unavailablePersonaId}" isn't available. Continuing without a persona.`;
}

export function buildMattermostResponseFooter(params: {
  harnessType?: string | null;
  metadataEnabled?: boolean;
  model?: string | null;
  notice?: string | null;
  reasoning?: string | null;
  serviceTier?: string | null;
}): string | undefined {
  const includeMetadata = params.metadataEnabled === true;
  const notice = params.notice?.trim();
  if (!includeMetadata && !notice) return undefined;
  const segments: string[] = [];
  if (notice) segments.push(`⚠ ${escapeMattermostMarkdown(notice)}`);
  if (includeMetadata) {
    const model = params.model?.trim();
    if (model) segments.push(escapeMattermostMarkdown(modelDisplayName(model)));
    const harness = harnessDisplayName(params.harnessType);
    if (harness) segments.push(escapeMattermostMarkdown(harness));
    const reasoning = reasoningDisplayName(params.reasoning);
    if (reasoning) segments.push(escapeMattermostMarkdown(reasoning));
    const serviceTier = params.serviceTier?.trim();
    if (serviceTier) {
      segments.push(escapeMattermostMarkdown(titleCase(serviceTier)));
    }
  }
  if (segments.length === 0) return undefined;
  return `_${segments.join(" · ")}_`;
}

function escapeMattermostMarkdown(text: string): string {
  return text.replaceAll("\\", "\\\\").replaceAll("*", "\\*").replaceAll("_", "\\_");
}

function titleCase(value: string): string {
  return value
    .split(/[\s_-]+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}
