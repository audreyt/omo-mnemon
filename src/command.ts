import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { MnemonCli } from "./cli.ts";
import { parseRecallRows } from "./recall.ts";
import { clip, focusQuery } from "./text.ts";

export type CommandHost = Pick<ExtensionAPI, "registerCommand">;

const USAGE = "usage: /mnemon status | /mnemon recall <query>";
const VERBS = ["status", "recall"] as const;

function count(payload: unknown, key: string): number {
  if (typeof payload !== "object" || payload === null) return 0;
  const value: unknown = Reflect.get(payload, key);
  return typeof value === "number" ? value : 0;
}

export function registerMnemonCommand(pi: CommandHost, cli: MnemonCli): void {
  pi.registerCommand("mnemon", {
    description: "mnemon memory: /mnemon status | /mnemon recall <query>",
    argumentHint: "status | recall <query>",
    getArgumentCompletions: (prefix) =>
      VERBS.filter((verb) => verb.startsWith(prefix.trim())).map((verb) => ({ value: verb, label: verb })),
    handler: async (args, ctx) => {
      const [verb = "status", ...rest] = args.trim().split(/\s+/).filter(Boolean);
      try {
        if (verb === "status") {
          const payload = await cli.runJson(["status"]);
          const memories = count(payload, "total_insights");
          const links = count(payload, "edge_count");
          ctx.ui.notify(
            `mnemon: ${memories} ${memories === 1 ? "memory" : "memories"}, ${links} ${links === 1 ? "link" : "links"}`,
            "info",
          );
          return;
        }
        const query = focusQuery(rest.join(" "), 500);
        if (verb !== "recall" || !query) {
          ctx.ui.notify(USAGE, "info");
          return;
        }
        const rows = parseRecallRows(await cli.runJson(["recall", query, "--limit", "5"]));
        const lines = rows.map((row) => `- [${row.id.slice(0, 8)}] ${clip(row.content, 160)}`);
        ctx.ui.notify(lines.length ? lines.join("\n") : "mnemon: no matching memories", "info");
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : "mnemon command failed", "error");
      }
    },
  });
}
