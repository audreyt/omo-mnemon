import { afterEach, beforeEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { BeforeAgentStartEvent } from "@earendil-works/pi-coding-agent";
import {
  createAutoRecall,
  mergeByBestScore,
  RECALL_MESSAGE_TYPE,
  recallQueries,
} from "../src/auto-recall.ts";
import { type MnemonCli, MnemonCliError } from "../src/cli.ts";
import omoMnemon, { hostCompatible, type MnemonHost } from "../src/index.ts";
import type { RecallRow } from "../src/recall.ts";
import { isSubstantivePrompt } from "../src/text.ts";
import { type TempStore, tempStore, testBinary } from "./helpers.ts";

type Notice = { readonly message: string; readonly type: string | undefined };
type FakeCtx = { readonly hasUI: boolean; readonly ui: { notify(message: string, type?: string): void } };
// Method syntax makes parameters bivariant, so the recorded host callbacks can be invoked with a
// narrow context: the full ExtensionContext (session manager, model registry, ...) cannot be built
// without casts, and none of these callbacks read more than hasUI / ui.notify.
type RecordedTool = { execute(id: string, p: unknown, s: undefined, u: undefined, c: object): unknown };
type RecordedCommand = { run(args: string, ctx: FakeCtx): Promise<void> };
type RecordedRecall = { run(event: BeforeAgentStartEvent, ctx: FakeCtx): unknown };
type Loaded = {
  readonly tools: Map<string, RecordedTool>;
  readonly commands: Map<string, RecordedCommand>;
  readonly recalls: { readonly handler: RecordedRecall; readonly previewSafe: boolean | undefined }[];
};

const CLEARED = ["OMO_MNEMON_AUTO_RECALL", "SENPI_TASK_RPC_CHILD", "SENPI_CLI_ISOLATED_CHILD"];
const MISSING = "/nonexistent/mnemon";
const FALCON = "Project Falcon migrated order storage from PostgreSQL to SQLite in March";
// Every tested mnemon build rates "Which database does Project Falcon use for order storage now?"
// medium (0.42), below the high-confidence band auto-recall injects; this phrasing rates high.
const FALCON_PROMPT = "Did Project Falcon migrate order storage from PostgreSQL to SQLite?";

let store: TempStore;
let savedEnv: Readonly<Record<string, string | undefined>>;

beforeEach(() => {
  savedEnv = { ...process.env };
  // A developer's own MNEMON_* settings (embedding model, caps) change mnemon's dedup behavior.
  for (const name of Object.keys(process.env)) {
    if (name.startsWith("MNEMON_")) Reflect.deleteProperty(process.env, name);
  }
  store = tempStore();
  process.env["MNEMON_CLI_PATH"] = testBinary();
  process.env["MNEMON_DATA_DIR"] = store.env["MNEMON_DATA_DIR"];
  process.env["HOME"] = store.env["HOME"];
  for (const name of CLEARED) Reflect.deleteProperty(process.env, name);
});

afterEach(() => {
  for (const name of Object.keys(process.env))
    if (!(name in savedEnv)) Reflect.deleteProperty(process.env, name);
  Object.assign(process.env, savedEnv);
  store.cleanup();
});

function load(sessionKind: MnemonHost["sessionKind"] = "interactive"): Loaded {
  const loaded: Loaded = { tools: new Map(), commands: new Map(), recalls: [] };
  omoMnemon({
    sessionKind,
    registerTool: (tool) => loaded.tools.set(tool.name, tool),
    registerCommand: (name, options) => loaded.commands.set(name, { run: options.handler }),
    on: (_event, handler, options) =>
      loaded.recalls.push({ handler: { run: handler }, previewSafe: options?.previewSafe }),
  });
  return loaded;
}

function must<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new Error(`missing ${what}`);
  return value;
}

function field(value: unknown, key: string): unknown {
  return typeof value === "object" && value !== null ? Reflect.get(value, key) : undefined;
}

async function call(loaded: Loaded, name: string, params: Record<string, unknown>): Promise<unknown> {
  const result = await must(loaded.tools.get(name), name).execute("id", params, undefined, undefined, {});
  return field(result, "details");
}

async function remember(loaded: Loaded, content: string, importance = 3): Promise<string> {
  const id = field(await call(loaded, "mnemon_remember", { content, category: "fact", importance }), "id");
  if (typeof id !== "string") throw new Error("remember returned no id");
  return id;
}

async function seeded(content: string, importance = 3): Promise<Loaded> {
  const loaded = load();
  await remember(loaded, content, importance);
  return loaded;
}

const recall = (loaded: Loaded) => must(loaded.recalls[0], "before_agent_start handler").handler;
const command = (loaded: Loaded) => must(loaded.commands.get("mnemon"), "mnemon command");

function fakeUi(hasUI = true): { readonly ctx: FakeCtx; readonly notices: Notice[] } {
  const notices: Notice[] = [];
  return { ctx: { hasUI, ui: { notify: (message, type) => notices.push({ message, type }) } }, notices };
}

function event(prompt: string, extra: Partial<BeforeAgentStartEvent> = {}): BeforeAgentStartEvent {
  const base = { type: "before_agent_start", prompt, trigger: "prompt", systemPrompt: "" } as const;
  return { ...base, systemPromptOptions: { cwd: store.root }, ...extra };
}

async function recallFor(loaded: Loaded, prompt: string, ctx: FakeCtx = fakeUi().ctx): Promise<unknown> {
  return await recall(loaded).run(event(prompt), ctx);
}

const HIDDEN = { customType: RECALL_MESSAGE_TYPE, display: false };
const injection = (text: string) => ({ message: { ...HIDDEN, content: expect.stringContaining(text) } });

function row(id: string, confidence: RecallRow["confidence"], score: number): RecallRow {
  return { id, content: id, category: "fact", importance: 3, confidence, score, superseded: false };
}

// A store that needs latencyMs per recall: it answers when granted that long and times out
// otherwise, exactly as the real adapter does, and records every budget it was granted.
function storeTaking(latencyMs: number): { readonly cli: MnemonCli; readonly budgets: number[] } {
  const budgets: number[] = [];
  const hit = {
    id: "cold-1",
    content: FALCON,
    category: "fact",
    importance: 4,
    confidence: "high",
    score: 0.9,
  };
  const cli: MnemonCli = {
    runText: async () => "",
    runJson: async (_args, options) => {
      const budget = options?.timeoutMs ?? Number.POSITIVE_INFINITY;
      budgets.push(budget);
      if (budget < latencyMs)
        throw new MnemonCliError("timeout", `mnemon recall timed out after ${budget}ms`);
      return { results: [hit] };
    },
    capabilities: async () => ({ edgeTypes: [] }),
  };
  return { cli, budgets };
}

const autoRecall = (cli: MnemonCli): RecordedRecall => ({ run: createAutoRecall(cli) });

test("given a cold store slower than a warm recall, when the first prompt starts, then it injects without a warning", async () => {
  const { ctx, notices } = fakeUi();
  const result = await autoRecall(storeTaking(3_500).cli).run(event(FALCON_PROMPT), ctx);
  expect(result).toMatchObject(injection("SQLite"));
  expect(notices).toEqual([]);
});

test("given a store that outlasts the cold budget, when prompts repeat, then only the first turn waits that long", async () => {
  const { cli, budgets } = storeTaking(60_000);
  const { ctx, notices } = fakeUi();
  const handler = autoRecall(cli);
  expect(await handler.run(event(FALCON_PROMPT), ctx)).toBeUndefined();
  expect(await handler.run(event(FALCON_PROMPT), ctx)).toBeUndefined();
  expect(budgets).toHaveLength(2);
  expect(budgets[1]).toBeLessThan(budgets[0] ?? 0);
  expect(notices).toEqual([{ message: expect.stringContaining("timed out"), type: "warning" }]);
});

test("given an interactive host, when loaded, then six tools, the mnemon command and a preview-safe hook register", () => {
  const loaded = load();
  const names = ["forget", "link", "recall", "related", "remember", "status"].map((verb) => `mnemon_${verb}`);
  expect([...loaded.tools.keys()].sort()).toEqual(names);
  expect([...loaded.commands.keys()]).toEqual(["mnemon"]);
  expect(loaded.recalls.map((entry) => entry.previewSafe)).toEqual([true]);
});

test("given a worker session, when loaded, then tools register but no recall hook does", () => {
  const loaded = load("worker");
  expect(loaded.tools.size).toBe(6);
  expect(loaded.recalls).toHaveLength(0);
});

test("given OMO_MNEMON_AUTO_RECALL=0, when loaded, then no recall hook registers", () => {
  process.env["OMO_MNEMON_AUTO_RECALL"] = "0";
  expect(load().recalls).toHaveLength(0);
});

test("given SENPI_TASK_RPC_CHILD=1, when loaded, then no recall hook registers", () => {
  process.env["SENPI_TASK_RPC_CHILD"] = "1";
  expect(load().recalls).toHaveLength(0);
});

test("given the module, when imported, then hostCompatible is a function", () => {
  expect(typeof hostCompatible).toBe("function");
});

test("given a remembered fact, when recalled by query, then the results contain its id", async () => {
  const loaded = load();
  const id = await remember(loaded, "Project Falcon uses PostgreSQL 16 for order storage");
  const details = await call(loaded, "mnemon_recall", { query: "Falcon order storage database" });
  expect(details).toMatchObject({ results: expect.arrayContaining([expect.objectContaining({ id })]) });
});

test("given secret-looking content, when remembered, then it is refused and nothing is stored", async () => {
  const loaded = load();
  const content = `deploy key: api_key = ${["sk", "test0123456789abcdefghijkl"].join("-")}`;
  await expect(call(loaded, "mnemon_remember", { content, category: "fact" })).rejects.toThrow("refused");
  expect(await call(loaded, "mnemon_status", {})).toMatchObject({ total_insights: 0 });
});

test("given two memories, when the new one supersedes the old, then the edge matches the binary's capabilities", async () => {
  const loaded = load();
  const target_id = await remember(loaded, "Project Falcon release cadence is monthly");
  const source_id = await remember(loaded, "Project Falcon switched to weekly releases in April");
  const help = spawnSync(testBinary(), ["link", "--help"], { env: { ...store.env }, encoding: "utf8" });
  const native = /--type\s+string\b[^\n]*\([^)\n]*\bsupersedes\b/.test(`${help.stdout}${help.stderr}`);
  const details = await call(loaded, "mnemon_link", { source_id, target_id, type: "supersedes" });
  if (native) {
    expect(details).toEqual({ edge_type: "supersedes", source_id, target_id });
  } else {
    expect(details).toMatchObject({ edge_type: "causal", note: expect.stringContaining("supersedes") });
  }
});

test("given identical source and target ids, when linked, then the call rejects", async () => {
  const loaded = load();
  const id = await remember(loaded, "Project Falcon release cadence is monthly");
  const params = { source_id: id, target_id: id, type: "semantic" };
  await expect(call(loaded, "mnemon_link", params)).rejects.toThrow();
});

test("given a store, when status is requested, then details hold exactly three numeric counts", async () => {
  const details = await call(await seeded(FALCON), "mnemon_status", {});
  const count = expect.any(Number);
  expect(details).toEqual({ total_insights: count, edge_count: count, deleted_insights: count });
});

test("given a missing binary, when status is requested, then it rejects with not found", async () => {
  process.env["MNEMON_CLI_PATH"] = MISSING;
  await expect(call(load(), "mnemon_status", {})).rejects.toThrow("not found");
});

test("given a relevant memory, when a prompt starts, then a hidden mnemon-recall message is injected", async () => {
  expect(await recallFor(await seeded(FALCON, 4), FALCON_PROMPT)).toMatchObject(injection("SQLite"));
});

test("given a memory already injected, when the same prompt repeats, then nothing is injected", async () => {
  const loaded = await seeded(FALCON, 4);
  await recallFor(loaded, FALCON_PROMPT);
  expect(await recallFor(loaded, FALCON_PROMPT)).toBeUndefined();
});

test("given a preview event, when handled, then mnemon is never invoked", async () => {
  const log = join(store.root, "calls.log");
  const wrapper = join(store.root, "mnemon-wrapper");
  writeFileSync(wrapper, `#!/bin/sh\necho call >> "$LOG"\nexec '${testBinary()}' "$@"\n`, { mode: 0o755 });
  process.env["MNEMON_CLI_PATH"] = wrapper;
  process.env["LOG"] = log;
  const loaded = load();
  expect(await recall(loaded).run(event(FALCON_PROMPT, { preview: true }), fakeUi().ctx)).toBeUndefined();
  expect(existsSync(log)).toBe(false);
  await recallFor(loaded, FALCON_PROMPT);
  expect(existsSync(log)).toBe(true);
});

test("given a prompt with a formatting instruction, when handled, then the question sentence recalls the fact", async () => {
  const loaded = await seeded("The Zephyr-7 widget calibration constant is 4471", 4);
  const prompt = "What is the calibration constant of the Zephyr-7 widget? Reply with only the number.";
  expect(await recallFor(loaded, prompt)).toMatchObject(injection("4471"));
});

test("given an extension-triggered turn, when handled, then nothing is injected", async () => {
  const result = await recall(load()).run(event(FALCON_PROMPT, { trigger: "extension" }), fakeUi().ctx);
  expect(result).toBeUndefined();
});

test("given an acknowledgement prompt, when handled, then nothing is injected", async () => {
  expect(await recallFor(load(), "ok")).toBeUndefined();
});

test("given a slash-command prompt, when handled, then nothing is injected", async () => {
  expect(await recallFor(load(), "/mnemon status")).toBeUndefined();
});

test("given a store with no database, when handled, then nothing is injected and nobody is notified", async () => {
  const { ctx, notices } = fakeUi();
  expect(await recallFor(load(), FALCON_PROMPT, ctx)).toBeUndefined();
  expect(notices).toEqual([]);
});

test("given a missing binary, when two prompts are handled, then one not-found warning is shown", async () => {
  process.env["MNEMON_CLI_PATH"] = MISSING;
  const loaded = load();
  const { ctx, notices } = fakeUi();
  expect(await recallFor(loaded, FALCON_PROMPT, ctx)).toBeUndefined();
  expect(await recallFor(loaded, FALCON_PROMPT, ctx)).toBeUndefined();
  expect(notices).toEqual([{ message: expect.stringContaining("not found"), type: "warning" }]);
});

test("given a missing binary and no UI, when a prompt is handled, then nobody is notified", async () => {
  process.env["MNEMON_CLI_PATH"] = MISSING;
  const { ctx, notices } = fakeUi(false);
  expect(await recallFor(load(), FALCON_PROMPT, ctx)).toBeUndefined();
  expect(notices).toEqual([]);
});

test("given a multi-sentence prompt, when split, then the whole prompt leads plus two distinct substantive sentences", () => {
  const prompt =
    "Which database does Project Falcon use now? Check the order storage notes first. " +
    "Also mention the migration month please. Reply with only the database name.";
  const queries = recallQueries(prompt);
  expect(queries[0]).toBe(prompt);
  expect(queries).toHaveLength(3);
  expect(new Set(queries).size).toBe(3);
  expect(queries.slice(1).every(isSubstantivePrompt)).toBe(true);
});

test("given a single-sentence prompt, when split, then exactly one query is returned", () => {
  expect(recallQueries(FALCON_PROMPT)).toEqual([FALCON_PROMPT]);
});

test("given duplicate ids, when merged, then the best-ranked copy survives and output is sorted best-first", () => {
  const rows = [row("x", "medium", 0.95), row("z", "low", 0.99), row("x", "high", 0.5)];
  const merged = mergeByBestScore([...rows, row("y", "high", 0.7), row("x", "high", 0.4)]);
  const ranked = merged.map((entry) => `${entry.id}:${entry.confidence}:${entry.score}`);
  expect(ranked).toEqual(["y:high:0.7", "x:high:0.5", "z:low:0.99"]);
});

test("given one memory, when /mnemon status runs, then it reports the singular count", async () => {
  const { ctx, notices } = fakeUi();
  await command(await seeded(FALCON)).run("status", ctx);
  const format = /^mnemon: \d+ (memory|memories), \d+ (link|links)$/;
  expect(notices).toEqual([{ message: expect.stringMatching(format), type: "info" }]);
  expect(notices[0]?.message).toStartWith("mnemon: 1 memory,");
});

test("given a seeded memory, when /mnemon recall runs, then the matching line is shown", async () => {
  const { ctx, notices } = fakeUi();
  await command(await seeded(FALCON)).run("recall Falcon", ctx);
  expect(notices[0]?.message).toContain("Falcon");
});

test("given an unknown verb, when /mnemon runs, then the usage line is shown", async () => {
  const { ctx, notices } = fakeUi();
  await command(load()).run("bogus", ctx);
  expect(notices).toEqual([{ message: expect.stringContaining("usage"), type: "info" }]);
});
