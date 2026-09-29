# PROJECT KNOWLEDGE BASE

**Generated:** 2026-09-28
**Commit:** 418f4bf
**Branch:** main

## OVERVIEW
A pi/senpi extension package (`pi.extensions: ./src/index.ts`) that connects omo to the local `mnemon` memory CLI. It provides 6 `mnemon_*` tools, a `/mnemon` command, and silent high-confidence auto-recall on `before_agent_start`. TypeScript runs directly from source (no build step). Uses Bun for tests and Biome for lint.

## STRUCTURE
```
omo-mnemon/
├── src/
│   ├── index.ts        # extension entry; the only default export; gates auto-recall
│   ├── cli.ts          # spawn wrapper: binary resolution, timeouts, write queue, SQLITE_BUSY retry
│   ├── tools.ts        # registerTool x6 (recall/remember/link/related/forget/status)
│   ├── auto-recall.ts  # before_agent_start handler, multi-query merge, cold/warm budgets
│   ├── recall.ts       # parse mnemon JSON -> RecallRow, silent selection, <mnemon-recall> formatting
│   ├── text.ts         # prompt cleaning, acknowledgement filter, secret regexes, clip
│   └── command.ts      # /mnemon status | recall
└── test/               # bun test; runs a REAL mnemon binary against temp stores
```

## WHERE TO LOOK
| Task | Location | Notes |
|------|----------|-------|
| Add/change a tool | `src/tools.ts` | TypeBox schemas; `promptGuidelines` live only on `mnemon_recall` |
| Auto-recall thresholds | `src/auto-recall.ts` constants | QUERY_CHARS 300, CANDIDATES 10, INJECTED_ROWS 3, MIN_SCORE 0.6, 3s warm / 10s cold |
| Which rows get injected | `recall.ts` `selectSilentRows` | confidence `high` only; score>=minScore only when confidence absent |
| Skip rules for prompts | `text.ts` `isSubstantivePrompt`, `ACKNOWLEDGEMENTS` | >=12 non-space chars or >=4 Han chars |
| Secret refusal | `text.ts` `SECRET_PATTERNS` | checked in `mnemon_remember` only |
| Process lifetime, errors | `cli.ts` `execute`, `MnemonCliError.kind` | kinds: not_found, no_store, timeout, aborted, exit, output_limit, invalid_json |
| Old-mnemon compat | `cli.ts` `parseEdgeTypes` + `tools.ts` `mnemon_link` | no `supersedes` -> stores `causal` with `--meta {relation}` and a `note` |
| Disable auto-recall for children | `index.ts` | `sessionKind === "worker"`, `SENPI_TASK_RPC_CHILD`, `SENPI_CLI_ISOLATED_CHILD`, `OMO_MNEMON_AUTO_RECALL=0` |

## CODE MAP
| Symbol | Type | Location | Refs | Role |
|--------|------|----------|------|------|
| `clip` | fn | text.ts | 24 | whitespace-collapse + surrogate-safe clip with `…` |
| `MnemonCliError` | class | cli.ts | 22 | typed failure; callers branch on `.kind` |
| `focusQuery` | fn | text.ts | 20 | strip fences/system blocks, clip to word |
| `runJson` | method | cli.ts | 17 | main call path for every tool |
| `parseRecallRows` | fn | recall.ts | 14 | tolerant parse of array or `{results}` payloads |
| `parseEdgeTypes` | fn | cli.ts | 12 | reads `mnemon link --help` once per session |
| `summarizeRemember` | fn | recall.ts | 11 | candidates (max 5), diffSuggestion, replacedId |
| `createAutoRecall` | fn | auto-recall.ts | 5 | per-session state: injected ids, warned, lastSuccess |
| `testBinary` / `tempStore` | fn | test/helpers.ts | 12 / 5 | binary under test and an isolated HOME + MNEMON_DATA_DIR |

## CONVENTIONS
- The tsconfig is very strict: `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`, and `noPropertyAccessFromIndexSignature`. Read env/records with `x["key"]`, and add optional fields conditionally (see `toToolRow`, `withSignal`) rather than assigning `undefined`.
- Imports use explicit `.ts` extensions (`allowImportingTsExtensions`, `verbatimModuleSyntax`), and type-only imports use `import type` / inline `type` (Biome `useImportType`).
- Biome allows no default exports except in `src/index.ts`. Also banned: `any` and non-null assertions (`!`). Line width is 110.
- Host types are narrowed with `Pick<ExtensionAPI, ...>` (`ToolHost`, `CommandHost`, `MnemonHost`) so tests can pass minimal fakes.
- Parse mnemon output defensively with `isRecord`, `readString`, and `finiteNumber`. Never trust its JSON shape, because the tests cover 0.1.14 through dev builds.
- Tool results go through `jsonResult(details)`: `content` is the JSON text, and `details` is the object.
- Switches over unions are exhaustive, with a `never` default (`isSilentCandidate`).
- Tests use `// Given / // When / // Then` comments.

## ANTI-PATTERNS (THIS PROJECT)
- Never spawn with `shell: true` or build a command string. Memory content goes in as argv.
- Never let an absolute path reach the model. Error text passes through `redactPaths`, and tool results never include the store path.
- Never let auto-recall throw or block a turn. `no_store` returns silently, and any other failure warns once per session.
- Auto-recall must pass `readonly: true`. Only readonly runs retry on SQLITE_BUSY, and writes go through the serialized `writeQueue`.
- Recalled content must not close the injection block early. Keep `escapeCloser` on everything placed inside `<mnemon-recall>`.
- Never inject superseded rows. Never inject the same id twice in a session.
- Don't reuse a global `RegExp` across calls, because `lastIndex` leaks between calls. `removeSystemBlocks` builds fresh ones.
- Tests must never touch `~/.mnemon`. Always use `tempStore()`.

## UNIQUE STYLES
- Comments explain *why* (constraints and incidents), not *what*. Keep that pattern.
- Timeouts are deadline-based. Retries share the original deadline, so the budget never extends.
- The cold budget applies to the first recall and after 5 minutes idle (Ollama keep_alive). After a cold timeout, turns fall back to the warm budget until a recall succeeds.

## COMMANDS
```bash
bun install
bun run check                         # tsc --noEmit && biome check . && bun test
bun test test/recall.test.ts          # single file
MNEMON_TEST_BIN=/path/to/mnemon bun test   # run suite against another mnemon build
omo -e /path/to/omo-mnemon            # load for one session without installing; /reload in a live one
```

## NOTES
- By default, tests use the platform binary from the `@mnemon-dev/mnemon` devDependency (`node_modules/@mnemon-dev/mnemon-<platform>-<arch>/bin/mnemon`). If it is missing, `bun install` failed.
- `test/cli.test.ts` uses `#!/bin/sh` fake mnemon scripts (via `writeScript`) to test kill, timeout, overlap, and output-cap behavior. Those tests are POSIX-only.
- The binary lookup order is `MNEMON_CLI_PATH` (exclusive when set), then `PATH`, then `~/.local/bin`, `~/go/bin`, `~/.bun/bin`, then `/opt/homebrew/bin`, `/usr/local/bin`. The resolved path is cached per CLI instance.
- The `peerDependencies` on pi packages are optional. The devDeps alias them to `@code-yeongyu/senpi*`.
- The license is CC0-1.0. The README is the user-facing spec, so keep it in sync when you change limits or defaults.
