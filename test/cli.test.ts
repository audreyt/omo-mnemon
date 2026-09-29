import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import {
  createMnemonCli,
  MnemonCliError,
  parseEdgeTypes,
  redactPaths,
  resolveMnemonCommand,
} from "../src/cli.ts";
import type { TempStore } from "./helpers.ts";
import { tempStore, testBinary } from "./helpers.ts";

const BASE_TYPES = ["temporal", "semantic", "causal", "entity"] as const;
const PID_SLEEP = `[ "$1" = warm ] && exit 0
echo $$ > "$PIDFILE"
exec sleep 30`;
const BUSY_ONCE = `if [ ! -e "$MARK" ]; then
  : > "$MARK"
  echo 'Error: recall: database is locked (5) (SQLITE_BUSY)' >&2
  exit 1
fi
echo recalled`;
const OVERLAP = "printf 'start\\n' >> \"$LOG\"\nsleep 0.2\nprintf 'end\\n' >> \"$LOG\"";
const BARRIER = `printf 'start\\n' >> "$LOG"
while [ "$(grep -c start "$LOG")" -lt 2 ]; do sleep 0.05; done
echo done`;

const stores: TempStore[] = [];
const dirs: string[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) store.cleanup();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function useStore(): TempStore {
  const store = tempStore();
  stores.push(store);
  return store;
}

function useDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "omo-mnemon-cli-"));
  dirs.push(dir);
  return dir;
}

function placeMnemon(dir: string, mode: number, body = "exit 0"): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "mnemon");
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, mode);
  return path;
}

function writeScript(body: string): { readonly path: string; readonly dir: string } {
  const dir = useDir();
  return { dir, path: placeMnemon(dir, 0o755, body) };
}

function commandEnv(root: string, pathValue: string, explicit?: string): Record<string, string | undefined> {
  mkdirSync(join(root, "home"));
  const env: Record<string, string | undefined> = { HOME: join(root, "home"), PATH: pathValue };
  if (explicit !== undefined) env["MNEMON_CLI_PATH"] = explicit;
  return env;
}

function cliOn(store: TempStore, extra: Readonly<Record<string, string>>) {
  const env: Record<string, string | undefined> = { ...store.env, ...extra };
  return createMnemonCli({ env });
}

function readField(value: unknown, key: string): unknown {
  if (typeof value !== "object" || value === null) throw new Error(`missing ${key}`);
  const found = Object.entries(value).find(([entryKey]) => entryKey === key);
  if (found === undefined) throw new Error(`missing ${key}`);
  return found[1];
}

async function rejected(pending: Promise<unknown>): Promise<MnemonCliError> {
  try {
    await pending;
  } catch (error) {
    if (error instanceof MnemonCliError) return error;
    throw error;
  }
  throw new Error("expected MnemonCliError");
}

function isEsrch(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ESRCH";
}

function assertDead(pid: number): void {
  try {
    process.kill(pid, 0);
  } catch (error) {
    if (isEsrch(error)) return;
    throw error;
  }
  throw new Error(`pid ${pid} still alive`);
}

function recordedPid(path: string): number {
  const text = readFileSync(path, "utf8").trim();
  if (!/^[1-9]\d*$/.test(text)) throw new Error("pid file was not a process id");
  return Number(text);
}

test("status on a fresh store reports zero insights", async () => {
  // Given a cli pointed at a fresh temp store
  const cli = cliOn(useStore(), { MNEMON_CLI_PATH: testBinary() });
  // When status runs
  const status = await cli.runJson(["status"]);
  // Then plain status created an empty store
  expect(readField(status, "total_insights")).toBe(0);
});

test("remember then recall returns the stored content", async () => {
  // Given a fresh store
  const cli = cliOn(useStore(), { MNEMON_CLI_PATH: testBinary() });
  const content = "Project Falcon uses PostgreSQL 16";
  // When the fact is remembered and recalled
  await cli.runJson(["remember", content, "--cat", "fact", "--imp", "3", "--source", "agent"]);
  const recalled = await cli.runJson(["recall", content]);
  // Then the synthetic content comes back
  const results = readField(recalled, "results");
  if (!Array.isArray(results)) throw new Error("expected results");
  expect(results.map((item) => readField(item, "content"))).toContain(content);
});

test("readonly recall on a missing database rejects no_store without the store path", async () => {
  // Given a store whose database does not exist yet
  const store = useStore();
  const cli = cliOn(store, { MNEMON_CLI_PATH: testBinary() });
  // When a readonly recall runs
  const error = await rejected(cli.runText(["recall", "anything"], { readonly: true }));
  // Then the failure is no_store and the absolute store path is redacted
  expect(error.kind).toBe("no_store");
  expect(error.message.endsWith("…/mnemon.db")).toBe(true);
  expect(error.message.includes(store.root)).toBe(false);
});

test("recall with no query rejects exit and hides usage text", async () => {
  // Given a fresh store
  const cli = cliOn(useStore(), { MNEMON_CLI_PATH: testBinary() });
  // When recall is invoked with no query
  const error = await rejected(cli.runText(["recall"]));
  // Then the failure is a nonzero exit whose detail requires a query and omits usage
  expect(error.kind).toBe("exit");
  expect(error.exitCode).toBeGreaterThan(0);
  expect(error.message).toContain("requires");
  expect(error.message).not.toContain("Usage:");
});

test("capabilities lists base edge types and supersedes only when help lists it", async () => {
  // Given the binary's own link help, classified without parseEdgeTypes
  const store = useStore();
  const binary = testBinary();
  const help = spawnSync(binary, ["link", "--help"], { encoding: "utf8", env: store.env });
  expect(help.status).toBe(0);
  const helpText = `${help.stdout ?? ""}\n${help.stderr ?? ""}`;
  const listsSupersedes = /--type\s+string\b[^\n]*\([^)\n]*\bsupersedes\b/.test(helpText);
  // When capabilities are read
  const caps = await cliOn(store, { MNEMON_CLI_PATH: binary }).capabilities();
  // Then the four base types are present and supersedes matches the help listing
  for (const edgeType of BASE_TYPES) expect(caps.edgeTypes).toContain(edgeType);
  expect(caps.edgeTypes.includes("supersedes")).toBe(listsSupersedes);
});

test("capabilities returns the same object on the second call", async () => {
  // Given a cli that can read help
  const cli = cliOn(useStore(), { MNEMON_CLI_PATH: testBinary() });
  // When capabilities are requested twice
  const first = await cli.capabilities();
  const second = await cli.capabilities();
  // Then the cached object is reused
  expect(second).toBe(first);
});

test("parseEdgeTypes reads all five types from current help", () => {
  // Given a current --type help line
  const help =
    '      --type string    edge type (causal|entity|semantic|supersedes|temporal) (default "semantic")';
  // When the line is parsed
  // Then every known edge type is returned
  expect(parseEdgeTypes(help)).toEqual([...BASE_TYPES, "supersedes"]);
});

test("parseEdgeTypes omits supersedes for the older type list", () => {
  // Given an older --type help line whose list is (temporal|semantic|causal|entity)
  const help = '      --type string    edge type (temporal|semantic|causal|entity) (default "semantic")';
  // When the line is parsed
  // Then the four base types are returned and supersedes is absent
  expect(parseEdgeTypes(help)).toEqual([...BASE_TYPES]);
});

test("parseEdgeTypes falls back to the four base types without a --type line", () => {
  // Given help text that never declares --type
  // When the text is parsed
  // Then the four base types are returned
  expect(parseEdgeTypes("Usage:\n  mnemon link [flags]\n")).toEqual([...BASE_TYPES]);
});

test("parseEdgeTypes ignores unknown names in the type list", () => {
  // Given a --type list that mixes known types with an unknown name
  const help = '      --type string    edge type (temporal|not-an-edge|causal) (default "semantic")';
  // When the line is parsed
  // Then only known names remain
  expect(parseEdgeTypes(help)).toEqual(["temporal", "causal"]);
});

test("redactPaths replaces an absolute database path with its basename", () => {
  // Given an error that embeds a home database path
  const redacted = redactPaths(
    "open database: database not found: /home/someone/.mnemon/data/default/mnemon.db",
  );
  // When paths are redacted
  // Then only the basename remains and the home prefix is gone
  expect(redacted.endsWith("…/mnemon.db")).toBe(true);
  expect(redacted.includes("/home")).toBe(false);
});

test("redactPaths leaves text without paths unchanged", () => {
  // Given text that contains no absolute path
  const plain = "requires at least 1 arg(s), only received 0";
  // When paths are redacted
  // Then the text is unchanged
  expect(redactPaths(plain)).toBe(plain);
});

test("an explicit MNEMON_CLI_PATH wins over a PATH mnemon", () => {
  // Given an explicit executable and a different executable on PATH
  const root = useDir();
  const explicit = placeMnemon(join(root, "explicit"), 0o755);
  placeMnemon(join(root, "on-path"), 0o755);
  // When the command is resolved
  // Then the explicit path is chosen
  expect(resolveMnemonCommand(commandEnv(root, join(root, "on-path"), explicit))).toBe(explicit);
});

test("a missing explicit path does not fall back to PATH", () => {
  // Given a missing explicit path and an executable mnemon on PATH
  const root = useDir();
  placeMnemon(join(root, "on-path"), 0o755);
  // When the command is resolved
  // Then nothing is resolved
  expect(
    resolveMnemonCommand(commandEnv(root, join(root, "on-path"), join(root, "missing", "mnemon"))),
  ).toBeUndefined();
});

test("PATH lookup returns an executable named mnemon", () => {
  // Given a temp directory on PATH that holds an executable mnemon
  const root = useDir();
  const executable = placeMnemon(join(root, "bin"), 0o755);
  // When the command is resolved without an explicit path
  // Then that executable is returned
  expect(resolveMnemonCommand(commandEnv(root, join(root, "bin")))).toBe(executable);
});

test("a non-executable mnemon on PATH is skipped for a later executable", () => {
  // Given a non-executable mnemon ahead of an executable one
  const root = useDir();
  placeMnemon(join(root, "first"), 0o644);
  const later = placeMnemon(join(root, "later"), 0o755);
  const pathValue = [join(root, "first"), join(root, "later")].join(delimiter);
  // When the command is resolved
  // Then the later executable wins
  expect(resolveMnemonCommand(commandEnv(root, pathValue))).toBe(later);
});

test("a missing MNEMON_CLI_PATH rejects not_found without spawning", async () => {
  // Given a missing binary and a PATH decoy that would record a spawn
  const root = useDir();
  const marker = join(root, "spawned");
  placeMnemon(join(root, "bin"), 0o755, `echo spawned > "${marker}"`);
  const cli = cliOn(useStore(), { PATH: join(root, "bin"), MNEMON_CLI_PATH: "/nonexistent/mnemon" });
  // When a command is requested
  const error = await rejected(cli.runText(["status"]));
  // Then the adapter rejects not_found and the decoy never ran
  expect(error.kind).toBe("not_found");
  expect(existsSync(marker)).toBe(false);
});

test("a timed out child is reaped before the call rejects", async () => {
  // Given a script that records its pid and sleeps
  const script = writeScript(PID_SLEEP);
  const pidFile = join(script.dir, "pid");
  const cli = cliOn(useStore(), { MNEMON_CLI_PATH: script.path, PIDFILE: pidFile });
  // A new script's first exec can outlast the timeout (macOS assesses fresh executables), and a
  // child killed before it records its pid proves nothing, so the first exec happens untimed.
  await cli.runText(["warm"]);
  // When the run exceeds its timeout
  const error = await rejected(cli.runText(["sleep"], { timeoutMs: 1_000 }));
  // Then the rejection is timeout and the recorded pid is gone
  expect(error.kind).toBe("timeout");
  assertDead(recordedPid(pidFile));
});

test("aborting immediately rejects aborted and leaves no live child", async () => {
  // Given a script that records its pid and sleeps
  const script = writeScript(PID_SLEEP);
  const pidFile = join(script.dir, "pid");
  const cli = cliOn(useStore(), { MNEMON_CLI_PATH: script.path, PIDFILE: pidFile });
  const controller = new AbortController();
  // When the run is aborted synchronously after it starts
  const pending = cli.runText(["sleep"], { signal: controller.signal });
  controller.abort();
  const error = await rejected(pending);
  // Then the rejection is aborted and any recorded pid is dead
  expect(error.kind).toBe("aborted");
  if (existsSync(pidFile)) assertDead(recordedPid(pidFile));
});

test("a pre-aborted signal rejects aborted without running the command", async () => {
  // Given an already aborted signal and a script that would write a marker
  const script = writeScript(`echo ran > "$MARKER"
exec sleep 30`);
  const marker = join(script.dir, "marker");
  const cli = cliOn(useStore(), { MNEMON_CLI_PATH: script.path, MARKER: marker });
  const controller = new AbortController();
  controller.abort();
  // When the run is started with that signal
  const error = await rejected(cli.runText(["sleep"], { signal: controller.signal }));
  // Then the command never ran
  expect(error.kind).toBe("aborted");
  expect(existsSync(marker)).toBe(false);
});

test("concurrent non-readonly runs are serialized", async () => {
  // Given a script that logs start, pauses, then logs end
  const script = writeScript(OVERLAP);
  const log = join(script.dir, "log");
  const cli = cliOn(useStore(), { MNEMON_CLI_PATH: script.path, LOG: log });
  // When two non-readonly runs are started together
  await Promise.all([cli.runText(["a"]), cli.runText(["b"])]);
  // Then each run finishes before the next starts
  expect(readFileSync(log, "utf8").trim().split("\n")).toEqual(["start", "end", "start", "end"]);
});

test("concurrent readonly runs are not serialized", async () => {
  // Given a script that only finishes once a second run has started (a barrier)
  const script = writeScript(BARRIER);
  const log = join(script.dir, "log");
  const cli = cliOn(useStore(), { MNEMON_CLI_PATH: script.path, LOG: log });
  // When two readonly runs are started together
  const options = { readonly: true, timeoutMs: 2_000 } as const;
  const runs = [cli.runText(["a"], options), cli.runText(["b"], options)];
  // Then both complete, which serialized runs could not do before their timeout
  expect(await Promise.all(runs)).toEqual(["done", "done"]);
});

test("a readonly run that hits a busy store is retried until it succeeds", async () => {
  // Given a script that fails with SQLITE_BUSY on its first run only
  const script = writeScript(BUSY_ONCE);
  const cli = cliOn(useStore(), { MNEMON_CLI_PATH: script.path, MARK: join(script.dir, "busy") });
  // When a readonly run starts while the store is busy
  const output = await cli.runText(["recall", "x"], { readonly: true, timeoutMs: 5_000 });
  // Then the retry's output is returned instead of the busy failure
  expect(output).toBe("recalled");
});

test("non-json stdout rejects invalid_json", async () => {
  // Given a script that prints plain text and exits successfully
  const script = writeScript("printf '%s\\n' 'not json'");
  const cli = cliOn(useStore(), { MNEMON_CLI_PATH: script.path });
  // When the output is parsed as JSON
  const error = await rejected(cli.runJson(["status"]));
  // Then the rejection is invalid_json
  expect(error.kind).toBe("invalid_json");
});
