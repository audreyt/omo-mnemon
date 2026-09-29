import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { type AutoRecallHandler, createAutoRecall } from "./auto-recall.ts";
import { createMnemonCli } from "./cli.ts";
import { type CommandHost, registerMnemonCommand } from "./command.ts";
import { registerMnemonTools, type ToolHost } from "./tools.ts";

export type MnemonHost = ToolHost &
  CommandHost & {
    readonly sessionKind: ExtensionAPI["sessionKind"];
    on(
      event: "before_agent_start",
      handler: AutoRecallHandler,
      options?: { readonly previewSafe?: boolean },
    ): void;
  };

// Task children and team members get the tools but no silent recall: their prompts are machine-written.
const CHILD_SESSION_ENV = ["SENPI_TASK_RPC_CHILD", "SENPI_CLI_ISOLATED_CHILD"] as const;

function autoRecallEnabled(pi: MnemonHost): boolean {
  if (process.env["OMO_MNEMON_AUTO_RECALL"] === "0") return false;
  if (pi.sessionKind === "worker") return false;
  return !CHILD_SESSION_ENV.some((name) => process.env[name]);
}

export default function omoMnemon(pi: MnemonHost): void {
  const cli = createMnemonCli();
  registerMnemonTools(pi, cli);
  registerMnemonCommand(pi, cli);
  if (autoRecallEnabled(pi)) pi.on("before_agent_start", createAutoRecall(cli), { previewSafe: true });
}

export const hostCompatible: (pi: ExtensionAPI) => void = omoMnemon;
