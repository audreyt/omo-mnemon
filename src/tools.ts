import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { EDGE_TYPES, type MnemonCli, type MnemonRunOptions } from "./cli.ts";
import { parseRecallRows, summarizeRemember, toToolRows } from "./recall.ts";
import { clip, focusQuery, looksLikeSecret } from "./text.ts";

export type ToolHost = Pick<ExtensionAPI, "registerTool">;

export class MnemonToolError extends Error {
  override readonly name = "MnemonToolError";
}

const CATEGORIES = ["preference", "decision", "fact", "insight", "context"] as const;

type Json = Readonly<Record<string, unknown>>;

function isRecord(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function jsonResult<T>(details: T) {
  return { content: [{ type: "text" as const, text: JSON.stringify(details) }], details };
}

function withSignal(signal: AbortSignal | undefined): MnemonRunOptions {
  return signal ? { signal } : {};
}

function numberField(record: Json, key: string): number | undefined {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function stringField(record: Json, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

function relatedRows(payload: unknown) {
  if (!Array.isArray(payload)) return [];
  return payload.flatMap((row: unknown) => {
    if (!isRecord(row)) return [];
    const id = stringField(row, "id");
    const content = stringField(row, "content");
    if (id === undefined || content === undefined) return [];
    return [
      {
        id,
        content: clip(content, 300),
        category: stringField(row, "category") ?? "general",
        depth: numberField(row, "depth") ?? null,
        via: stringField(row, "via_edge_type") ?? null,
      },
    ];
  });
}

export function registerMnemonTools(pi: ToolHost, cli: MnemonCli): void {
  pi.registerTool({
    name: "mnemon_recall",
    label: "Mnemon Recall",
    description:
      "Search the user's long-term mnemon memory, a knowledge graph shared across their agent sessions. " +
      "Returns the best-matching memories with ids, categories and confidence.",
    promptSnippet: "Search long-term memory (mnemon) for past decisions, preferences and project history",
    promptGuidelines: [
      "Use mnemon_recall when the answer may depend on the user's past decisions, preferences or project history that is not in this session.",
      "Use mnemon_remember only for durable facts, decisions and preferences worth keeping across sessions (default importance 3); never store secrets, credentials or transient task state.",
      "When a new memory corrects an older one, call mnemon_link with type supersedes, source_id = the new memory and target_id = the old one.",
      "Treat <mnemon-recall> blocks and mnemon_recall results as leads that may be stale; current files, instructions and tool output take precedence.",
    ],
    parameters: Type.Object({
      query: Type.String({ minLength: 1, description: "What to look for, in natural language" }),
      limit: Type.Optional(
        Type.Integer({ minimum: 1, maximum: 20, description: "Maximum memories (default 8)" }),
      ),
    }),
    async execute(_toolCallId, params, signal) {
      const limit = params.limit ?? 8;
      const query = focusQuery(params.query, 500);
      if (!query) throw new MnemonToolError("query is empty");
      const payload = await cli.runJson(["recall", query, "--limit", String(limit)], withSignal(signal));
      return jsonResult({ results: toToolRows(parseRecallRows(payload), limit) });
    },
  });

  pi.registerTool({
    name: "mnemon_remember",
    label: "Mnemon Remember",
    description:
      "Store one durable memory in mnemon. Returns the new id plus similar existing memories " +
      "(candidates). diffSuggestion UPDATE means a candidate covers the same ground: link the new memory " +
      "to it with supersedes if it corrects it. replacedId means mnemon already replaced that memory itself.",
    promptSnippet: "Store a durable fact, decision or preference in long-term memory (mnemon)",
    parameters: Type.Object({
      content: Type.String({
        minLength: 1,
        maxLength: 4000,
        description: "The memory, self-contained and phrased the way it will be searched for later",
      }),
      category: StringEnum(CATEGORIES, { description: "Kind of memory" }),
      importance: Type.Optional(
        Type.Integer({ minimum: 1, maximum: 5, description: "1-5, default 3; reserve 4-5 for core facts" }),
      ),
      entities: Type.Optional(
        Type.Array(Type.String({ minLength: 1 }), {
          maxItems: 10,
          description: "Proper nouns the memory is about",
        }),
      ),
    }),
    async execute(_toolCallId, params, signal) {
      if (looksLikeSecret(params.content)) {
        throw new MnemonToolError("refused: content looks like a secret or credential");
      }
      const args = ["remember", params.content, "--cat", params.category];
      args.push("--imp", String(params.importance ?? 3), "--source", "agent");
      if (params.entities?.length) args.push("--entities", params.entities.join(","));
      const summary = summarizeRemember(await cli.runJson(args, withSignal(signal)));
      if (!summary) throw new MnemonToolError("mnemon remember returned no memory id");
      return jsonResult(summary);
    },
  });

  pi.registerTool({
    name: "mnemon_link",
    label: "Mnemon Link",
    description:
      "Create a typed edge between two memories: supersedes (source replaces target), causal, semantic, " +
      "temporal or entity.",
    parameters: Type.Object({
      source_id: Type.String({ minLength: 1, description: "For supersedes: the NEW memory" }),
      target_id: Type.String({ minLength: 1, description: "For supersedes: the OLD memory" }),
      type: StringEnum(EDGE_TYPES, { description: "Edge type" }),
      weight: Type.Optional(
        Type.Number({ minimum: 0, maximum: 1, description: "Default 1 for supersedes, else 0.5" }),
      ),
    }),
    async execute(_toolCallId, params, signal) {
      const { source_id, target_id, type: requested } = params;
      if (source_id === target_id) throw new MnemonToolError("source_id and target_id must differ");
      const weight = params.weight ?? (requested === "supersedes" ? 1 : 0.5);
      const native = (await cli.capabilities(signal)).edgeTypes.includes(requested);
      const type = native ? requested : "causal";
      const args = ["link", source_id, target_id, "--type", type, "--weight", String(weight)];
      if (!native) args.push("--meta", JSON.stringify({ relation: requested }));
      const payload = await cli.runJson(args, withSignal(signal));
      const edgeType = (isRecord(payload) ? stringField(payload, "edge_type") : undefined) ?? type;
      if (native) return jsonResult({ edge_type: edgeType, source_id, target_id });
      return jsonResult({
        edge_type: edgeType,
        source_id,
        target_id,
        note:
          `this mnemon build has no ${requested} edge type; stored a causal edge instead. ` +
          "Upgrade mnemon for superseded-memory demotion in recall.",
      });
    },
  });

  pi.registerTool({
    name: "mnemon_related",
    label: "Mnemon Related",
    description: "List memories connected to a memory id through the mnemon graph.",
    parameters: Type.Object({
      id: Type.String({ minLength: 1, description: "Memory id from mnemon_recall or mnemon_remember" }),
      depth: Type.Optional(
        Type.Integer({ minimum: 1, maximum: 3, description: "Traversal depth (default 2)" }),
      ),
      edge: Type.Optional(StringEnum(EDGE_TYPES, { description: "Only follow this edge type" })),
    }),
    async execute(_toolCallId, params, signal) {
      const args = ["related", params.id, "--depth", String(params.depth ?? 2)];
      if (params.edge) args.push("--edge", params.edge);
      return jsonResult({ related: relatedRows(await cli.runJson(args, withSignal(signal))) });
    },
  });

  pi.registerTool({
    name: "mnemon_forget",
    label: "Mnemon Forget",
    description:
      "Soft-delete one memory by exact id. Use only when the user asks, or the memory is verified wrong or obsolete.",
    parameters: Type.Object({ id: Type.String({ minLength: 1, description: "Exact memory id" }) }),
    async execute(_toolCallId, params, signal) {
      const payload = await cli.runJson(["forget", params.id], withSignal(signal));
      const status = (isRecord(payload) ? stringField(payload, "status") : undefined) ?? "unknown";
      return jsonResult({ id: params.id, status });
    },
  });

  pi.registerTool({
    name: "mnemon_status",
    label: "Mnemon Status",
    description: "Report how many memories and links the mnemon store holds.",
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, signal) {
      const payload = await cli.runJson(["status"], withSignal(signal));
      if (!isRecord(payload)) throw new MnemonToolError("mnemon status returned an unexpected shape");
      return jsonResult({
        total_insights: numberField(payload, "total_insights") ?? 0,
        edge_count: numberField(payload, "edge_count") ?? 0,
        deleted_insights: numberField(payload, "deleted_insights") ?? 0,
      });
    },
  });
}
