# omo-mnemon

[mnemon](https://github.com/mnemon-dev/mnemon) is a local long-term memory store for coding agents. It keeps memories as a knowledge graph on disk, and every agent session on the machine shares it. This extension connects mnemon to omo, and to any senpi/pi-compatible host that loads pi packages. The agent gets tools to recall, remember, link and forget memories. You get a `/mnemon` command. And when you type a real question, a quiet auto-recall step adds a few high-confidence memories to the turn.

## Requirements

You need a `mnemon` binary. Any recent release works. It has been tested with 0.1.14, 0.2.8, 0.2.9 and newer development builds.

The extension looks for the binary in this order:

1. `MNEMON_CLI_PATH`, if set. When it's set, it's the only place checked, and it must point to an executable file.
2. Every directory on `PATH`.
3. `$HOME/.local/bin`, `$HOME/go/bin` and `$HOME/.bun/bin`.
4. `/opt/homebrew/bin` and `/usr/local/bin`.

The fallback directories are there because hosts launched from a GUI often run with a minimal `PATH`.

## Install

From npm:

```sh
omo install npm:omo-mnemon
```

From a git repository:

```sh
omo install <git-url-or-path>
# for example: omo install git:github.com/<owner>/omo-mnemon
```

From a local checkout:

```sh
omo install /path/to/omo-mnemon
```

To try it for one session without installing:

```sh
omo -e /path/to/omo-mnemon
```

If a session is already running, use `/reload` to load the extension.

## What you get

### Tools

| Tool | What it does |
| --- | --- |
| `mnemon_recall` | Searches memory for a natural-language query. Returns up to `limit` memories (default 8, max 20) with id, category, importance, confidence and score. Superseded memories come last and are flagged. |
| `mnemon_remember` | Stores one memory (up to 4000 chars) with a category (`preference`, `decision`, `fact`, `insight`, `context`), importance 1 to 5 (default 3) and up to 10 entities. Returns the new id and up to 5 similar existing memories. |
| `mnemon_link` | Creates a typed edge between two memories: `supersedes`, `causal`, `semantic`, `temporal` or `entity`. Default weight is 1 for `supersedes` and 0.5 for the others. |
| `mnemon_related` | Lists memories connected to an id through the graph, to depth 2 by default (max 3), optionally along one edge type. |
| `mnemon_forget` | Soft-deletes one memory by exact id. |
| `mnemon_status` | Reports the number of memories, links and deleted memories. |

Writes are serialized, so concurrent tool calls can't interleave on the store. Every mnemon call has a timeout (8 s by default) and a 1 MiB output cap. When a call fails, the mnemon process is stopped before the call returns.

### The `/mnemon` command

- `/mnemon` or `/mnemon status` shows the memory and link counts.
- `/mnemon recall <query>` lists up to 5 matches, each clipped to 160 characters.

### Auto-recall

Before the agent starts a turn, the extension may run a quick read-only recall and attach its results. The rules:

- It runs only in interactive sessions. Worker sessions, task children and team members get the tools but no auto-recall, because their prompts are machine-written.
- It runs only on prompts you typed. Slash commands, `!` commands and short acknowledgements ("ok", "thanks", "continue" and similar, in English and Chinese) are skipped. A prompt needs at least 12 non-space characters, or 4 Han characters, to count.
- The query is your prompt with code fences and system/reminder blocks stripped, cut to 300 characters. Its two longest sentences are also queried on their own, in parallel, because instructions such as "reply with only the number" dilute a whole-prompt match. Results are merged, keeping each memory's best match.
- Each query asks mnemon for 10 candidates, and at most 3 memories are injected. It only keeps memories mnemon rates high confidence. For builds that report a score but no confidence, the cutoff is a score of 0.6 or higher. Superseded memories are never injected.
- A memory is injected at most once per session.
- Each memory is clipped to 320 characters and sent inside a hidden `<mnemon-recall>` message. That message tells the model these are leads that may be stale or wrong, and that current files, instructions and tool output take precedence.
- It runs with `--readonly` and a 3 s timeout. A slow or broken store never blocks or fails a turn.
- If no mnemon store exists yet, it's skipped silently. If mnemon is missing or fails, you see one warning for the session, and after that it stays quiet.

## Configuration

| Variable | Effect |
| --- | --- |
| `MNEMON_CLI_PATH` | Absolute path to the `mnemon` binary. Skips the search described above. |
| `OMO_MNEMON_AUTO_RECALL=0` | Turns off auto-recall. The tools and the command still work. |
| `MNEMON_DATA_DIR`, `MNEMON_STORE` | mnemon's own settings. The extension passes its environment to mnemon unchanged, so these work as mnemon documents them. |

## Compatibility

The `supersedes` edge type needs a mnemon build that supports it (0.2.9 or newer). The extension checks this by reading `mnemon link --help` once per session. On older builds, `mnemon_link` with `type: supersedes` stores a `causal` edge, records the requested relation in the edge metadata, and says so in a `note` field of its result. Recall only demotes superseded memories on builds that support the real edge.

## Privacy and safety

- mnemon runs locally as a child process with an argument vector. No shell is involved, so memory content is never interpreted as shell syntax.
- The extension sends nothing over the network itself, has no telemetry and writes no files of its own. All storage belongs to mnemon.
- `mnemon_remember` refuses content that looks like a secret: API keys in common formats (OpenAI-style `sk-`, GitHub, AWS, Slack, Google), private key blocks, JWTs, and `password=`/`token:`-style assignments.
- Tool results never include the store path. Absolute paths in error messages are cut down to `…/<basename>` before they reach the model.
- Auto-recall passes `--readonly`, so it can't modify the store.

Recalled memories do enter the model's context. That's the whole point, but it also means they end up in the session transcript and go to whatever model provider the session uses. Don't store anything in mnemon that you wouldn't put in a prompt.

## Development

```sh
bun install
bun run check   # typecheck, Biome, then the test suite
```

To run the suite against a different mnemon binary:

```sh
MNEMON_TEST_BIN=/path/to/mnemon bun test
```

Tests create throwaway stores and never touch `~/.mnemon`.

## License

By Audrey Tang. To the extent possible under law, the author has waived all copyright and related or neighboring rights to this work under [CC0 1.0 Universal](https://creativecommons.org/publicdomain/zero/1.0/). See `LICENSE`.
