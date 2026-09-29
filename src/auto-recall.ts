import type {
  BeforeAgentStartEvent,
  BeforeAgentStartEventResult,
  ExtensionHandler,
} from "@earendil-works/pi-coding-agent";
import { type MnemonCli, MnemonCliError } from "./cli.ts";
import { formatRecallInjection, parseRecallRows, type RecallRow, selectSilentRows } from "./recall.ts";
import { focusQuery, isSubstantivePrompt } from "./text.ts";

export const RECALL_MESSAGE_TYPE = "mnemon-recall";

const QUERY_CHARS = 300;
const CANDIDATES = 10;
const INJECTED_ROWS = 3;
const MIN_SCORE = 0.6;
const TIMEOUT_MS = 5_000;
// A cold store first loads its embedding model and pages in every stored vector: about 3s on a
// 6k-memory store, too close to TIMEOUT_MS. The session's first recall, and the first after Ollama's
// default five-minute keep_alive lapses, therefore gets a cold budget instead.
const COLD_TIMEOUT_MS = 10_000;
const IDLE_MS = 5 * 60_000;

const EXTRA_SENTENCES = 2;

export type AutoRecallHandler = ExtensionHandler<BeforeAgentStartEvent, BeforeAgentStartEventResult>;

// Formatting instructions ("Reply with only the number.") dilute a whole-prompt query below
// mnemon's high-confidence band, so the longest sentences are also recalled on their own.
export function recallQueries(prompt: string): readonly string[] {
  const whole = focusQuery(prompt, QUERY_CHARS);
  const sentences = whole
    .split(/(?<=[.?!;。？！；])\s*/u)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence !== whole && isSubstantivePrompt(sentence))
    .sort((a, b) => b.length - a.length)
    .slice(0, EXTRA_SENTENCES);
  return [whole, ...new Set(sentences)];
}

function rank(row: RecallRow): number {
  const band = row.confidence === "high" ? 2 : row.confidence === "medium" ? 1 : 0;
  return band * 10 + (row.score ?? 0);
}

export function mergeByBestScore(rows: readonly RecallRow[]): readonly RecallRow[] {
  const best = new Map<string, RecallRow>();
  for (const row of rows) {
    const current = best.get(row.id);
    if (current === undefined || rank(row) > rank(current)) best.set(row.id, row);
  }
  return [...best.values()].sort((a, b) => rank(b) - rank(a));
}

export function createAutoRecall(cli: MnemonCli): AutoRecallHandler {
  // One handler per extension instance, and the host builds a fresh instance per session.
  const injected = new Set<string>();
  let warned = false;
  let lastSuccess: number | undefined;
  // After a cold budget runs out, turns use the warm budget until a recall succeeds, so a hung
  // store stalls at most one turn by COLD_TIMEOUT_MS.
  let coldTimedOut = false;

  return async (event, ctx) => {
    if (event.preview === true || event.trigger !== "prompt" || !isSubstantivePrompt(event.prompt)) {
      return undefined;
    }
    const cold = lastSuccess === undefined || Date.now() - lastSuccess > IDLE_MS;
    const timeoutMs = cold && !coldTimedOut ? COLD_TIMEOUT_MS : TIMEOUT_MS;
    try {
      const payloads = await Promise.all(
        recallQueries(event.prompt).map((query) =>
          cli.runJson(["recall", query, "--limit", String(CANDIDATES)], { readonly: true, timeoutMs }),
        ),
      );
      lastSuccess = Date.now();
      coldTimedOut = false;
      const rows = selectSilentRows(mergeByBestScore(payloads.flatMap(parseRecallRows)), {
        limit: INJECTED_ROWS,
        minScore: MIN_SCORE,
        exclude: injected,
      });
      if (rows.length === 0) return undefined;
      for (const row of rows) injected.add(row.id);
      return {
        message: { customType: RECALL_MESSAGE_TYPE, content: formatRecallInjection(rows), display: false },
      };
    } catch (error) {
      // Recall is an optimization: a turn must never fail or stall because memory is unavailable.
      if (error instanceof MnemonCliError && error.kind === "no_store") return undefined;
      if (error instanceof MnemonCliError && error.kind === "timeout" && timeoutMs === COLD_TIMEOUT_MS) {
        coldTimedOut = true;
      }
      if (!warned) {
        warned = true;
        const reason = error instanceof Error ? error.message : "unknown error";
        if (ctx.hasUI) ctx.ui.notify(`mnemon auto-recall unavailable: ${reason}`, "warning");
      }
      return undefined;
    }
  };
}
