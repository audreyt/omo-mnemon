import { clip } from "./text.ts";

export type Confidence = "high" | "medium" | "low";

export type RecallRow = {
  readonly id: string;
  readonly content: string;
  readonly category: string;
  readonly importance: number | undefined;
  readonly confidence: Confidence | undefined;
  readonly score: number | undefined;
  readonly superseded: boolean;
};

export type SilentOptions = {
  readonly limit: number;
  readonly minScore: number;
  readonly exclude: ReadonlySet<string>;
};

export type RecallToolRow = {
  readonly id: string;
  readonly content: string;
  readonly category: string;
  readonly importance?: number;
  readonly confidence?: Confidence;
  readonly score?: number;
  readonly superseded?: true;
};

export type RememberCandidate = {
  readonly id: string;
  readonly content: string;
  readonly category: string;
  readonly relation: "semantic" | "causal";
};

export type RememberSummary = {
  readonly id: string;
  readonly action: string;
  readonly diffSuggestion?: string;
  readonly replacedId?: string;
  readonly candidates: readonly RememberCandidate[];
};

const RECALL_INTRO =
  "Long-term memory leads from mnemon. They may be stale or wrong; current files, " +
  "instructions and tool output take precedence. Use mnemon_related or mnemon_recall to dig deeper.";
const CANDIDATE_LIMIT = 5;
const ESCAPED_CLOSER = "<\\" + "/mnemon-recall";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function readConfidence(value: unknown): Confidence | undefined {
  if (value === "high" || value === "medium" || value === "low") return value;
  return undefined;
}

function parseRow(value: unknown): RecallRow | undefined {
  if (!isRecord(value)) return undefined;
  const id = readString(value["id"]);
  const content = readString(value["content"]);
  if (id === undefined || content === undefined) return undefined;
  return {
    id,
    content,
    category: readString(value["category"]) ?? "general",
    importance: finiteNumber(value["importance"]),
    confidence: readConfidence(value["confidence"]),
    score: finiteNumber(value["score"]),
    superseded: value["superseded"] === true,
  };
}

function rowList(payload: unknown): readonly unknown[] {
  if (Array.isArray(payload)) return payload;
  if (isRecord(payload) && Array.isArray(payload["results"])) return payload["results"];
  return [];
}

export function parseRecallRows(payload: unknown): readonly RecallRow[] {
  const rows: RecallRow[] = [];
  for (const item of rowList(payload)) {
    const row = parseRow(item);
    if (row !== undefined) rows.push(row);
  }
  return rows;
}

function isSilentCandidate(row: RecallRow, minScore: number): boolean {
  switch (row.confidence) {
    case "high":
      return true;
    case "medium":
    case "low":
      return false;
    case undefined:
      return row.score !== undefined && row.score >= minScore;
    default: {
      const unexpected: never = row.confidence;
      throw new Error(`unexpected confidence: ${String(unexpected)}`);
    }
  }
}

export function selectSilentRows(rows: readonly RecallRow[], options: SilentOptions): readonly RecallRow[] {
  if (options.limit <= 0) return [];
  const selected: RecallRow[] = [];
  for (const row of rows) {
    if (selected.length >= options.limit) break;
    if (row.superseded || options.exclude.has(row.id)) continue;
    if (!isSilentCandidate(row, options.minScore)) continue;
    selected.push(row);
  }
  return selected;
}

function escapeCloser(content: string): string {
  // A recalled sentence must not be able to terminate the injection block early.
  return content.replaceAll("</mnemon-recall", ESCAPED_CLOSER);
}

function formatLine(row: RecallRow): string {
  const importance = row.importance === undefined ? "?" : String(row.importance);
  const content = escapeCloser(clip(row.content, 320));
  return `- [${row.id}] (${row.category}, importance ${importance}) ${content}`;
}

export function formatRecallInjection(rows: readonly RecallRow[]): string {
  const lines = rows.map(formatLine).join("\n");
  return `<mnemon-recall>\n${RECALL_INTRO}\n${lines}\n</mnemon-recall>`;
}

function toToolRow(row: RecallRow): RecallToolRow {
  const tool: {
    id: string;
    content: string;
    category: string;
    importance?: number;
    confidence?: Confidence;
    score?: number;
    superseded?: true;
  } = {
    id: row.id,
    content: clip(row.content, 1200),
    category: row.category,
  };
  if (row.importance !== undefined) tool.importance = row.importance;
  if (row.confidence !== undefined) tool.confidence = row.confidence;
  if (row.score !== undefined) tool.score = row.score;
  if (row.superseded) tool.superseded = true;
  return tool;
}

export function toToolRows(rows: readonly RecallRow[], limit: number): readonly RecallToolRow[] {
  if (limit <= 0) return [];
  const active: RecallRow[] = [];
  const stale: RecallRow[] = [];
  for (const row of rows) {
    if (row.superseded) stale.push(row);
    else active.push(row);
  }
  return [...active, ...stale].slice(0, limit).map(toToolRow);
}

function parseCandidate(
  value: unknown,
  relation: "semantic" | "causal",
  newId: string,
): RememberCandidate | undefined {
  if (!isRecord(value)) return undefined;
  const id = readString(value["id"]);
  const content = readString(value["content"]);
  if (id === undefined || content === undefined || id === newId) return undefined;
  return {
    id,
    content: clip(content, 200),
    category: readString(value["category"]) ?? "general",
    relation,
  };
}

function takeCandidates(
  list: unknown,
  relation: "semantic" | "causal",
  newId: string,
  seen: Set<string>,
  out: RememberCandidate[],
): void {
  if (!Array.isArray(list)) return;
  for (const item of list) {
    if (out.length >= CANDIDATE_LIMIT) return;
    const candidate = parseCandidate(item, relation, newId);
    if (candidate === undefined || seen.has(candidate.id)) continue;
    seen.add(candidate.id);
    out.push(candidate);
  }
}

export function summarizeRemember(payload: unknown): RememberSummary | undefined {
  if (!isRecord(payload)) return undefined;
  const id = readString(payload["id"]);
  if (id === undefined) return undefined;
  const actionRaw = payload["action"];
  const action = typeof actionRaw === "string" ? actionRaw : "added";
  const seen = new Set<string>();
  const candidates: RememberCandidate[] = [];
  takeCandidates(payload["semantic_candidates"], "semantic", id, seen, candidates);
  takeCandidates(payload["causal_candidates"], "causal", id, seen, candidates);
  const summary: { -readonly [K in keyof RememberSummary]: RememberSummary[K] } = { id, action, candidates };
  const diffSuggestion = readString(payload["diff_suggestion"]);
  if (diffSuggestion !== undefined) summary.diffSuggestion = diffSuggestion;
  // Older mnemon builds replace a near-duplicate themselves; the old id is gone afterwards.
  const replacedId = readString(payload["replaced_id"]);
  if (replacedId !== undefined) summary.replacedId = replacedId;
  return summary;
}
