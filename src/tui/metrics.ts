import type { Config } from "../config.js";
import { getProviderProfile, providerEndpoint } from "../providers.js";
import type { ShellPermission } from "../tools/shell.js";
import type { WorkspacePermission } from "../tools/write.js";
import type { TuiTelemetrySnapshot, TuiUsage } from "./telemetry.js";
import type { TuiSection } from "./view.js";

export type TuiConfig = {
  config: Omit<Config, "apiKey">;
  workspace: string | undefined;
  permission: WorkspacePermission;
  shellPermission: ShellPermission;
  skills: number;
};

const count = (value: number | null): string => value === null ? "N/A" : value.toLocaleString("en-US");
const coverage = (usage: TuiUsage): string => `${usage.reportedRequests}/${usage.attemptedRequests} reported`;
const tokens = (usage: TuiUsage): string => usage.totals === null ? "N/A"
  : `${count(usage.totals.promptTokens)} in / ${count(usage.totals.completionTokens)} out`;
const cache = (usage: TuiUsage): string => usage.cache.hitRate === null ? "N/A"
  : `${(usage.cache.hitRate * 100).toFixed(1)}%`;

export function metricSections(snapshot: TuiTelemetrySnapshot, settings: TuiConfig): TuiSection[] {
  const { session, turn, parentRequest } = snapshot;
  return [
    { title: "TOKEN USAGE", rows: [
      { label: "Session", value: `${count(session.tokenUsage.total.totals?.totalTokens ?? null)} [${session.tokenUsage.total.reportedRequests}/${session.tokenUsage.total.attemptedRequests}]`, tone: "accent" },
      { label: "In / out", value: tokens(session.tokenUsage.total) },
      { label: "Coverage", value: coverage(session.tokenUsage.total), tone: "muted" },
      { label: "This turn", value: tokens(turn.tokenUsage.total) },
      { label: "Turn coverage", value: coverage(turn.tokenUsage.total), tone: "muted" },
    ], note: "Provider counters [reported/attempted]; includes child requests." },
    { title: "PROMPT CACHE / KV", rows: [
      { label: "Session hit", value: `${cache(session.tokenUsage.total)} [${session.tokenUsage.total.cache.reportedRequests}/${session.tokenUsage.total.attemptedRequests}]`, tone: "good" },
      { label: "Cached / input", value: `${count(session.tokenUsage.total.cache.cachedPromptTokens)} / ${count(session.tokenUsage.total.cache.promptTokens)}` },
      { label: "Coverage", value: `${session.tokenUsage.total.cache.reportedRequests}/${session.tokenUsage.total.attemptedRequests} requests`, tone: "muted" },
      { label: "Turn hit", value: cache(turn.tokenUsage.total) },
    ], note: "Reported prompt cache only; hardware KV is unavailable." },
    { title: "CONTEXT / REQUEST", rows: [
      { label: "Parent input", value: `${count(snapshot.parentPromptTokens)} tokens` },
      { label: "JSON body", value: parentRequest ? `${count(parentRequest.bytes)} B` : "N/A" },
      { label: "Byte budget", value: `${count(settings.config.maxRequestBytes)} B` },
      { label: "Model limit", value: "N/A (not reported)", tone: "muted" },
      { label: "Omitted reads", value: count(turn.contextReduction.omittedReadResults) },
      { label: "JSON bytes saved", value: `${count(turn.contextReduction.bytesSaved)} B` },
      { label: "Budget check", value: parentRequest === null ? "N/A" : parentRequest.accepted ? "Accepted" : "Rejected", tone: parentRequest?.accepted === false ? "warning" : "muted" },
    ], meter: { label: parentRequest?.accepted === false ? "Request rejected" : "Local byte budget",
      ratio: parentRequest ? parentRequest.bytes / parentRequest.limitBytes : null },
    note: "Latest parent request, not saved history or token capacity." },
    { title: "CONVERSATION", rows: [
      { label: "Saved turns", value: count(snapshot.conversation.completedTurns) },
      { label: "Turn", value: `${turn.number} / ${turn.status}` },
      { label: "Requests P/C", value: `${turn.modelRequests.parent} / ${turn.modelRequests.children}` },
      { label: "Tools OK/error", value: `${turn.toolResults.ok} / ${turn.toolResults.errors}` },
      { label: "Writes / cmds", value: `${turn.writes} / ${turn.commands}` },
      { label: "Children active", value: count(snapshot.activeChildIds.length) },
    ] },
  ];
}

/** Full, unabridged configuration is always available through /status on small terminals. */
export function statusText(snapshot: TuiTelemetrySnapshot, settings: TuiConfig): string {
  const { config } = settings;
  const generation = getProviderProfile(config.provider).generation;
  return [
    "CONFIGURATION", `Provider: ${config.provider}`, `Region: ${config.region}`, `Model: ${config.model}`,
    `Endpoint: ${providerEndpoint(config.provider, config.region)}`,
    `Working directory: ${settings.workspace ?? "Disabled (no --workspace)"}`,
    `Process directory: ${process.cwd()}`,
    `Write permission: ${settings.workspace === undefined ? "disabled" : settings.permission}`,
    `Shell permission: ${settings.shellPermission}`, `Discovered skills: ${settings.skills}`,
    `Parent request limit per turn: ${config.maxIterations}`,
    `Delegation: at most 2 children, ${Math.min(3, config.maxIterations)} requests each`,
    `Request timeout: ${config.requestTimeoutMs} ms`, `Request byte limit: ${config.maxRequestBytes}`,
    `Output token limit: ${"max_tokens" in generation ? generation.max_tokens : generation.max_completion_tokens}`,
    "Thinking: disabled; streaming: disabled", "API key: configured (hidden)",
    "", ...metricSections(snapshot, settings).flatMap((section) => [section.title,
      ...section.rows.map((row) => `${row.label}: ${row.value}`), ...(section.note ? [section.note] : []), ""]),
    `Parent session tokens: ${tokens(snapshot.session.tokenUsage.parent)} (${coverage(snapshot.session.tokenUsage.parent)})`,
    `Child session tokens: ${tokens(snapshot.session.tokenUsage.children)} (${coverage(snapshot.session.tokenUsage.children)})`,
    "Usage is process-local and survives /reset. Missing counters are unknown, not zero.",
  ].join("\n");
}
