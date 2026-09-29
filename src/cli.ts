import { spawn } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import { basename, delimiter, join } from "node:path";

export type EdgeType = "temporal" | "semantic" | "causal" | "entity" | "supersedes";
export const EDGE_TYPES: readonly EdgeType[] = ["temporal", "semantic", "causal", "entity", "supersedes"];
const BASE_EDGE_TYPES: readonly EdgeType[] = ["temporal", "semantic", "causal", "entity"];

export type MnemonErrorKind =
  | "not_found"
  | "no_store"
  | "timeout"
  | "aborted"
  | "exit"
  | "output_limit"
  | "invalid_json";

export class MnemonCliError extends Error {
  override readonly name = "MnemonCliError";
  readonly kind: MnemonErrorKind;
  readonly exitCode: number | undefined;

  constructor(kind: MnemonErrorKind, message: string, exitCode?: number) {
    super(message);
    this.kind = kind;
    this.exitCode = exitCode;
  }
}

export type Env = Readonly<Record<string, string | undefined>>;
export type MnemonRunOptions = {
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  readonly readonly?: boolean;
};
export type MnemonCapabilities = { readonly edgeTypes: readonly EdgeType[] };
export type MnemonCli = {
  runText(args: readonly string[], options?: MnemonRunOptions): Promise<string>;
  runJson(args: readonly string[], options?: MnemonRunOptions): Promise<unknown>;
  capabilities(signal?: AbortSignal): Promise<MnemonCapabilities>;
};

const DEFAULT_TIMEOUT_MS = 8_000;
const MAX_OUTPUT_BYTES = 1024 * 1024;
const KILL_GRACE_MS = 1_000;
const BUSY_RETRY_MS = 100;
const EXECUTABLE = process.platform === "win32" ? "mnemon.exe" : "mnemon";
const NOT_FOUND_MESSAGE = "mnemon not found; install it or set MNEMON_CLI_PATH";

function isExecutableFile(path: string): boolean {
  try {
    if (!statSync(path).isFile()) return false;
    accessSync(path, constants.X_OK);
    return true;
  } catch (error) {
    if (error instanceof Error) return false;
    throw error;
  }
}

export function resolveMnemonCommand(env: Env): string | undefined {
  const explicit = env["MNEMON_CLI_PATH"]?.trim();
  if (explicit) return isExecutableFile(explicit) ? explicit : undefined;
  const home = env["HOME"];
  // GUI-launched hosts often run with a minimal PATH, so also try the usual install locations.
  const fallbacks = home
    ? [join(home, ".local", "bin"), join(home, "go", "bin"), join(home, ".bun", "bin")]
    : [];
  const dirs = [...(env["PATH"] ?? "").split(delimiter), ...fallbacks, "/opt/homebrew/bin", "/usr/local/bin"];
  for (const dir of dirs) {
    if (!dir) continue;
    const candidate = join(dir, EXECUTABLE);
    if (isExecutableFile(candidate)) return candidate;
  }
  return undefined;
}

export function parseEdgeTypes(helpText: string): readonly EdgeType[] {
  const listed = /--type\s+string\b[^\n(]*\(([^)\n]*)\)/.exec(helpText)?.[1];
  if (listed === undefined) return BASE_EDGE_TYPES;
  const names = new Set(listed.split("|").map((name) => name.trim()));
  return EDGE_TYPES.filter((type) => names.has(type));
}

function firstErrorLine(text: string): string | undefined {
  const line = text.split("\n").find((candidate) => candidate.trimStart().startsWith("Error:"));
  return line?.trim().replace(/^Error:\s*/, "");
}

// Error text reaches the model and session transcripts; keep local directory layouts out of it.
export function redactPaths(text: string): string {
  return text.replace(
    /(^|[\s'"(=])(\/[^\s'"()]+)/g,
    (_match, lead: string, path: string) => `${lead}…/${basename(path)}`,
  );
}

type Invocation = {
  readonly command: string;
  readonly argv: readonly string[];
  readonly env: Env;
  readonly label: string;
  readonly signal: AbortSignal | undefined;
  readonly deadline: number;
};

type ProcessOutput = { readonly stdout: string; readonly stderr: string; readonly exitCode: number | null };

function timeoutError(invocation: Invocation, timeoutMs: number): MnemonCliError {
  return new MnemonCliError("timeout", `mnemon ${invocation.label} timed out after ${timeoutMs}ms`);
}

function execute(invocation: Invocation, timeoutMs: number): Promise<ProcessOutput> {
  const { signal, label } = invocation;
  if (signal?.aborted) return Promise.reject(new MnemonCliError("aborted", `mnemon ${label} aborted`));
  const remaining = invocation.deadline - Date.now();
  if (remaining <= 0) return Promise.reject(timeoutError(invocation, timeoutMs));

  return new Promise<ProcessOutput>((resolve, reject) => {
    const child = spawn(invocation.command, [...invocation.argv], {
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...invocation.env },
      windowsHide: true,
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let bytes = 0;
    let failure: MnemonCliError | undefined;
    let settled = false;

    const finish = (outcome: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      outcome();
    };
    // Failures stop the child first and settle on "close", so no mnemon process outlives the call.
    const fail = (error: MnemonCliError) => {
      if (failure) return;
      failure = error;
      clearTimeout(timer);
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.kill("SIGTERM");
      setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      }, KILL_GRACE_MS).unref();
    };
    const onAbort = () => fail(new MnemonCliError("aborted", `mnemon ${label} aborted`));
    const timer = setTimeout(() => fail(timeoutError(invocation, timeoutMs)), remaining);
    const collect = (sink: Buffer[]) => (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > MAX_OUTPUT_BYTES) {
        fail(new MnemonCliError("output_limit", `mnemon ${label} output exceeded ${MAX_OUTPUT_BYTES} bytes`));
        return;
      }
      sink.push(chunk);
    };

    child.stdout.on("data", collect(stdout));
    child.stderr.on("data", collect(stderr));
    child.on("error", () => finish(() => reject(new MnemonCliError("not_found", NOT_FOUND_MESSAGE))));
    child.on("close", (exitCode) =>
      finish(() => {
        if (failure) {
          reject(failure);
          return;
        }
        resolve({
          stdout: Buffer.concat(stdout).toString("utf8"),
          stderr: Buffer.concat(stderr).toString("utf8"),
          exitCode,
        });
      }),
    );
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export function createMnemonCli(options?: { readonly env?: Env }): MnemonCli {
  const env = options?.env ?? process.env;
  let command: string | undefined;
  let capabilities: MnemonCapabilities | undefined;
  let writeQueue: Promise<unknown> = Promise.resolve();

  // Writes are serialized so concurrent tool calls never interleave on the store; reads run freely.
  const serialize = <T>(work: () => Promise<T>): Promise<T> => {
    const run = writeQueue.then(work, work);
    writeQueue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };

  const runText = async (args: readonly string[], runOptions: MnemonRunOptions = {}): Promise<string> => {
    const timeoutMs = runOptions.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const deadline = Date.now() + timeoutMs;
    command ??= resolveMnemonCommand(env);
    const resolved = command;
    if (resolved === undefined) throw new MnemonCliError("not_found", NOT_FOUND_MESSAGE);
    const invocation: Invocation = {
      command: resolved,
      argv: runOptions.readonly ? ["--readonly", ...args] : args,
      env,
      label: args[0] ?? "command",
      signal: runOptions.signal,
      deadline,
    };
    let output = runOptions.readonly
      ? await execute(invocation, timeoutMs)
      : await serialize(() => execute(invocation, timeoutMs));
    // The store uses a rollback journal, so while another process writes, a reader fails at once
    // with SQLITE_BUSY instead of waiting; readonly runs retry until their deadline.
    while (
      runOptions.readonly &&
      output.exitCode !== 0 &&
      /SQLITE_BUSY|database is locked/i.test(`${output.stderr}\n${output.stdout}`) &&
      deadline - Date.now() > BUSY_RETRY_MS
    ) {
      await new Promise((resolve) => setTimeout(resolve, BUSY_RETRY_MS));
      output = await execute(invocation, timeoutMs);
    }
    if (output.exitCode !== 0) {
      const detail = redactPaths(
        firstErrorLine(output.stderr) ?? firstErrorLine(output.stdout) ?? "no output",
      );
      const code = output.exitCode ?? undefined;
      const kind = /database not found/i.test(detail) ? "no_store" : "exit";
      throw new MnemonCliError(
        kind,
        `mnemon ${invocation.label} failed (exit ${code ?? "signal"}): ${detail}`,
        code,
      );
    }
    return output.stdout.trim();
  };

  const runJson = async (args: readonly string[], runOptions?: MnemonRunOptions): Promise<unknown> => {
    const text = await runText(args, runOptions);
    try {
      return JSON.parse(text);
    } catch (error) {
      if (error instanceof SyntaxError) {
        throw new MnemonCliError("invalid_json", `mnemon ${args[0] ?? "command"} returned invalid JSON`);
      }
      throw error;
    }
  };

  const readCapabilities = async (signal?: AbortSignal): Promise<MnemonCapabilities> => {
    if (capabilities) return capabilities;
    const help = await runText(["link", "--help"], signal ? { signal, readonly: true } : { readonly: true });
    capabilities = { edgeTypes: parseEdgeTypes(help) };
    return capabilities;
  };

  return { runText, runJson, capabilities: readCapabilities };
}
