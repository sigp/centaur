// Prometheus metrics for the Mattermost bot, served at `GET /metrics`.
//
// A port of slackbotv2's `metrics.ts`: a process-wide registry (the bot is one
// process per deployment) with counters, gauges and histograms, rendered in
// the Prometheus text exposition format. Every series is prefixed
// `mattermostbot_`; label values are always strings.

type LabelValue = boolean | number | string | undefined;
type Labels = Record<string, LabelValue>;

type MetricType = "counter" | "gauge" | "histogram";

type Sample = {
  labels: Record<string, string>;
  value: number;
};

type HistogramSample = {
  bucketCounts: number[];
  count: number;
  labels: Record<string, string>;
  sum: number;
};

const DEFAULT_HISTOGRAM_BUCKETS = [
  0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 120, 300,
  600, 900, 1800,
];

class Registry {
  private readonly metrics: Metric[] = [];

  register(metric: Metric): void {
    this.metrics.push(metric);
  }

  render(): string {
    const lines: string[] = [];
    for (const metric of this.metrics) {
      lines.push(`# HELP ${metric.name} ${escapeHelp(metric.help)}`);
      lines.push(`# TYPE ${metric.name} ${metric.type}`);
      lines.push(...metric.renderSamples());
    }
    lines.push("");
    return lines.join("\n");
  }

  reset(): void {
    for (const metric of this.metrics) metric.reset();
  }
}

abstract class Metric {
  readonly help: string;
  readonly labelNames: readonly string[];
  readonly name: string;
  readonly type: MetricType;

  protected constructor(input: {
    help: string;
    labelNames?: readonly string[];
    name: string;
    type: MetricType;
  }) {
    this.help = input.help;
    this.labelNames = input.labelNames ?? [];
    this.name = input.name;
    this.type = input.type;
  }

  abstract renderSamples(): string[];
  abstract reset(): void;

  protected labelKey(labels: Labels = {}): {
    key: string;
    normalized: Record<string, string>;
  } {
    const normalized: Record<string, string> = {};
    for (const name of this.labelNames) {
      normalized[name] = String(labels[name] ?? "");
    }
    return { key: JSON.stringify(normalized), normalized };
  }

  protected sampleLine(
    suffix: string,
    labels: Record<string, string>,
    value: number,
  ): string {
    return `${this.name}${suffix}${formatLabels(labels)} ${String(value)}`;
  }
}

class Counter extends Metric {
  private readonly samples = new Map<string, Sample>();

  constructor(input: {
    help: string;
    labelNames?: readonly string[];
    name: string;
  }) {
    super({ ...input, type: "counter" });
  }

  inc(labels: Labels = {}, value = 1): void {
    if (value < 0) throw new Error(`counter ${this.name} cannot be decreased`);
    const { key, normalized } = this.labelKey(labels);
    const sample = this.samples.get(key) ?? { labels: normalized, value: 0 };
    sample.value += value;
    this.samples.set(key, sample);
  }

  renderSamples(): string[] {
    return Array.from(this.samples.values(), (sample) =>
      this.sampleLine("", sample.labels, sample.value),
    );
  }

  reset(): void {
    this.samples.clear();
  }
}

class Gauge extends Metric {
  private readonly samples = new Map<string, Sample>();

  constructor(input: {
    help: string;
    labelNames?: readonly string[];
    name: string;
  }) {
    super({ ...input, type: "gauge" });
  }

  dec(labels: Labels = {}, value = 1): void {
    this.inc(labels, -value);
  }

  inc(labels: Labels = {}, value = 1): void {
    this.set(labels, this.get(labels) + value);
  }

  set(labels: Labels = {}, value: number): void {
    const { key, normalized } = this.labelKey(labels);
    this.samples.set(key, { labels: normalized, value });
  }

  renderSamples(): string[] {
    return Array.from(this.samples.values(), (sample) =>
      this.sampleLine("", sample.labels, sample.value),
    );
  }

  reset(): void {
    this.samples.clear();
  }

  private get(labels: Labels): number {
    const { key } = this.labelKey(labels);
    return this.samples.get(key)?.value ?? 0;
  }
}

class Histogram extends Metric {
  private readonly buckets: readonly number[];
  private readonly samples = new Map<string, HistogramSample>();

  constructor(input: {
    buckets?: readonly number[];
    help: string;
    labelNames?: readonly string[];
    name: string;
  }) {
    super({ ...input, type: "histogram" });
    this.buckets = input.buckets ?? DEFAULT_HISTOGRAM_BUCKETS;
  }

  observe(labels: Labels = {}, value: number): void {
    if (!Number.isFinite(value)) return;
    const { key, normalized } = this.labelKey(labels);
    const sample = this.samples.get(key) ?? {
      bucketCounts: Array.from({ length: this.buckets.length }, () => 0),
      count: 0,
      labels: normalized,
      sum: 0,
    };
    for (const [index, bucket] of this.buckets.entries()) {
      if (value <= bucket) {
        sample.bucketCounts[index] = (sample.bucketCounts[index] ?? 0) + 1;
      }
    }
    sample.count += 1;
    sample.sum += value;
    this.samples.set(key, sample);
  }

  renderSamples(): string[] {
    const lines: string[] = [];
    for (const sample of this.samples.values()) {
      for (const [index, bucket] of this.buckets.entries()) {
        lines.push(
          this.sampleLine(
            "_bucket",
            { ...sample.labels, le: String(bucket) },
            sample.bucketCounts[index] ?? 0,
          ),
        );
      }
      lines.push(
        this.sampleLine("_bucket", { ...sample.labels, le: "+Inf" }, sample.count),
      );
      lines.push(this.sampleLine("_sum", sample.labels, sample.sum));
      lines.push(this.sampleLine("_count", sample.labels, sample.count));
    }
    return lines;
  }

  reset(): void {
    this.samples.clear();
  }
}

const registry = new Registry();

function counter(input: {
  help: string;
  labelNames?: readonly string[];
  name: string;
}): Counter {
  const metric = new Counter(input);
  registry.register(metric);
  return metric;
}

function gauge(input: {
  help: string;
  labelNames?: readonly string[];
  name: string;
}): Gauge {
  const metric = new Gauge(input);
  registry.register(metric);
  return metric;
}

function histogram(input: {
  buckets?: readonly number[];
  help: string;
  labelNames?: readonly string[];
  name: string;
}): Histogram {
  const metric = new Histogram(input);
  registry.register(metric);
  return metric;
}

export const mattermostbotMetrics = {
  activeLiveRenders: gauge({
    help: "Number of live Mattermost render tasks currently running.",
    name: "mattermostbot_active_live_renders",
  }),
  executionsCompleted: counter({
    help: "Executions the session API reported as completed.",
    name: "mattermostbot_executions_completed_total",
  }),
  executionsFailed: counter({
    help: "Executions that failed, by where the failure surfaced: execution_failed and stream_error (session events), execute_request (execute call rejected), handoff (turn could not be handed to the session API), render_exhausted (render retries gave up).",
    labelNames: ["reason"],
    name: "mattermostbot_executions_failed_total",
  }),
  executionsInterrupted: counter({
    help: "Executions the session API reported as cancelled (for example after a stop command).",
    name: "mattermostbot_executions_interrupted_total",
  }),
  executionsStarted: counter({
    help: "Executions accepted by the session API execute call.",
    name: "mattermostbot_executions_started_total",
  }),
  expose(): string {
    this.info.set({}, 1);
    return registry.render();
  },
  forwardRetries: counter({
    help: "In-process retries of the session API handoff after retryable failures.",
    labelNames: ["outcome"],
    name: "mattermostbot_forward_retries_total",
  }),
  info: gauge({
    help: "Static Mattermost bot service info.",
    name: "mattermostbot_info",
  }),
  lastSuccessfulRenderTimestamp: gauge({
    help: "Unix timestamp of the last successful Mattermost render completion.",
    labelNames: ["source"],
    name: "mattermostbot_last_successful_render_timestamp_seconds",
  }),
  messageOverrideFields: counter({
    help: "Inline override fields parsed from messages (harness, model, provider, reasoning, persona).",
    labelNames: ["field"],
    name: "mattermostbot_message_override_fields_total",
  }),
  messageOverrides: counter({
    help: "Message override parses by outcome: none (no override), applied (at least one override), strategy_failed (the configured strategy threw and flag parsing was used).",
    labelNames: ["outcome"],
    name: "mattermostbot_message_overrides_total",
  }),
  messageOverridesDuration: histogram({
    help: "Message override parse duration, in seconds.",
    labelNames: ["outcome"],
    name: "mattermostbot_message_overrides_duration_seconds",
  }),
  proactiveDecisions: counter({
    help: "Unmentioned posts considered for a proactive reply, by decision outcome (respond, decline, error, or skip_<reason>).",
    labelNames: ["outcome"],
    name: "mattermostbot_proactive_decisions_total",
  }),
  reactionKindsDisabled: gauge({
    help: "1 when a reaction kind was disabled for the process after Mattermost refused it.",
    labelNames: ["kind"],
    name: "mattermostbot_reaction_kinds_disabled",
  }),
  reactions: counter({
    help: "Reaction add and remove requests by kind, operation and outcome (success, refused, error).",
    labelNames: ["kind", "operation", "outcome"],
    name: "mattermostbot_reactions_total",
  }),
  renderAttemptDuration: histogram({
    help: "Mattermost render attempt duration, in seconds.",
    labelNames: ["source", "outcome"],
    name: "mattermostbot_render_attempt_duration_seconds",
  }),
  renderAttempts: counter({
    help: "Mattermost render attempts by source (live, recovery) and outcome (complete, retry, error).",
    labelNames: ["source", "outcome"],
    name: "mattermostbot_render_attempts_total",
  }),
  renderObligationsIndexed: counter({
    help: "Render obligations written to the recovery index.",
    name: "mattermostbot_render_obligations_indexed_total",
  }),
  renderRecoveryObligations: gauge({
    help: "Render obligations observed during the latest recovery scan (state: indexed_threads, pending, deferred).",
    labelNames: ["state"],
    name: "mattermostbot_render_recovery_obligations",
  }),
  renderRecoveryScanDuration: histogram({
    help: "Render recovery scan duration, in seconds.",
    labelNames: ["outcome"],
    name: "mattermostbot_render_recovery_scan_duration_seconds",
  }),
  renderRecoveryScans: counter({
    help: "Render recovery scans by outcome (complete, deferred, error).",
    labelNames: ["outcome"],
    name: "mattermostbot_render_recovery_scans_total",
  }),
  renderRecoveryThreadEvents: counter({
    help: "Per-thread render recovery events (complete, deferred, lease_skipped, failed).",
    labelNames: ["event"],
    name: "mattermostbot_render_recovery_thread_events_total",
  }),
  responseFooters: counter({
    help: "Model footers delivered with a reply: inline (appended to the last answer post), separate (own reply), failed.",
    labelNames: ["placement"],
    name: "mattermostbot_response_footers_total",
  }),
  sessionApiOperationDuration: histogram({
    help: "Session API operation duration from the Mattermost bot, in seconds.",
    labelNames: ["operation", "outcome"],
    name: "mattermostbot_session_api_operation_duration_seconds",
  }),
  sessionApiOperations: counter({
    help: "Session API operations initiated by the Mattermost bot, by operation and outcome (success, retryable_error, error).",
    labelNames: ["operation", "outcome"],
    name: "mattermostbot_session_api_operations_total",
  }),
  sessionEventStreamClosures: counter({
    help: "Session API /events stream network connections released, by reason.",
    labelNames: ["reason"],
    name: "mattermostbot_session_event_stream_closures_total",
  }),
  sessionEventStreamsOpen: gauge({
    help: "Session API /events SSE connections the bot currently holds open. Each one occupies a slot in Bun's global fetch pool (BUN_CONFIG_MAX_HTTP_REQUESTS, default 256); at the cap every outbound HTTP request from this process queues forever.",
    name: "mattermostbot_session_event_streams_open",
  }),
  stopCommands: counter({
    help: "Stop commands by outcome: interrupted (an execution was interrupted), nothing_to_interrupt, failed (the stop could not be confirmed).",
    labelNames: ["outcome"],
    name: "mattermostbot_stop_commands_total",
  }),
  websocketConnected: gauge({
    help: "1 when the Mattermost websocket is connected, else 0. Sampled on each scrape.",
    name: "mattermostbot_websocket_connected",
  }),
};

export function resetMattermostbotMetricsForTests(): void {
  registry.reset();
}

export function observeSeconds(startedAtMs: number): number {
  return Math.max(0, (globalThis.performance.now() - startedAtMs) / 1000);
}

function escapeHelp(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("\n", "\\n");
}

function escapeLabelValue(value: string): string {
  return value
    .replaceAll("\\", "\\\\")
    .replaceAll("\n", "\\n")
    .replaceAll('"', '\\"');
}

function formatLabels(labels: Record<string, string>): string {
  const entries = Object.entries(labels);
  if (entries.length === 0) return "";
  return `{${entries
    .map(([key, value]) => `${key}="${escapeLabelValue(value)}"`)
    .join(",")}}`;
}
