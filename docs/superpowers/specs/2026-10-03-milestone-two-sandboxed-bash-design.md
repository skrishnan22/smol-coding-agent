# Milestone Two: Sandboxed Bash

## Goal

Give the model a general `bash` tool and make an OS-level sandbox, not per-tool path checks, the security boundary. Keep `read_file` alongside it for now so the two approaches can be compared in the same loop.

This is a learning milestone. It aims to make the sandbox mechanism understandable, not production-ready.

## Learning questions

- What does an OS-level sandbox (macOS Seatbelt) actually enforce, and what does it leave open?
- What does a generic `bash` tool lose compared to dedicated read/write tools?
- Which tool does the model choose when it has both?

Questions deferred to later milestones:

- **Why do harnesses such as Pi and OpenCode keep dedicated read/edit tools?** See "Reference observations" for what the checkouts show. A follow-up milestone can add back a dedicated `edit` tool and compare it with `sed`/heredocs.
- **Parallel tool calls.** The loop still rejects more than one function call per response (`parallel_tool_calls: false`). Reads are safe to batch; arbitrary shell commands usually are not. Separate tools give the harness a way to know which calls can run concurrently. This is the natural reason to revisit parallelism.
- **Removing `read_file`.** Once the comparison has been observed, removal is a small separate commit.

## Scope

In scope:

- A `bash` tool run under macOS Seatbelt via `sandbox-exec`.
- A generated Seatbelt profile (writes limited to the project and temp dir, no network, a deny list for credential paths).
- Fresh `bash -c` per tool call, with timeout, output caps and a scrubbed environment.
- A tool-agnostic `ToolResult` type so the loop no longer depends on `read_file` details.
- Both `read_file` and `bash` advertised to the model.
- A startup check that fails clearly when the platform cannot sandbox.

Out of scope:

- Permission prompts or approval UX.
- Any non-macOS sandbox, Docker or VM isolation.
- Persistent shell sessions.
- Process-group killing, CPU or memory limits.
- Parallel tool calls.
- Removing `read_file`.

## Background: how Seatbelt works

Seatbelt is a mandatory access control layer in the macOS kernel. Before the kernel performs certain operations for a process (open a file, connect a socket, exec a program) it consults the policy attached to that process.

- A **profile** is a list of rules written in SBPL, a Scheme-like language: `(allow|deny <operation> <filter>)`. Operations look like `file-read*`, `file-write*`, `network*`. Filters are `(subpath X)` (X and everything under it), `(literal X)` (exactly X) and `(regex ...)`.
- `sandbox-exec -p <profile> <cmd>` applies the profile to itself and then execs `<cmd>`. The policy is part of the process's kernel state, is inherited by all children, and can be tightened but not loosened.
- Evaluation is per operation at call time. When several rules match, **the last one wins**. If none match, the profile default applies.
- A denial surfaces as `EPERM`, which programs print as `Operation not permitted`. The command does not crash; it fails at that one operation.
- Paths are checked after resolution, so symlinks and `../` do not help the process.
- It does not inspect command text, hide the existence of undenied files, or limit CPU and memory.

This is described from general knowledge of Seatbelt. Apple does not document SBPL officially, and `sandbox-exec` is deprecated but still functional. The probe results below are the primary evidence.

## Sandbox policy

`src/sandbox.ts` exports `buildProfile` (a pure string builder) and `runSandboxed` (spawns the process).

The profile starts from `(allow default)` and subtracts. A deny-by-default profile for bash is fiddly because every system library and binary must be enumerated.

```scheme
(version 1)
(allow default)
(deny file-write*)
(allow file-write* (subpath ROOT) (subpath TMP) (literal "/dev/null"))
(deny network*)
(deny file-read* (subpath "<home>/.ssh") (subpath "<home>/.aws") (regex #"/\.env(\..*)?$"))
(allow file-read* (literal "<root>/.env.example"))
```

- `ROOT` is the `realpath` of the startup directory. macOS `/tmp` and `/var` are symlinks, so unresolved paths would not match.
- `TMP` is the resolved temp directory.
- The write allow-list is `ROOT`, `TMP` and `/dev/null`. `/dev/tty` is deliberately **not** allowed: programs such as editors open the controlling terminal directly, and denying writes makes them fail fast instead of taking over the TUI.
- Rule order matters: deny writes first, then the carve-out; deny `.env*` reads first, then the `.env.example` allow.
- Paths are escaped (quotes and backslashes) when interpolated into the profile.

Probe on this machine (2026-10-03) confirmed: normal reads work, writes inside the project work, writes outside fail with `Operation not permitted`, reads of `~/.ssh` fail, `curl` cannot resolve hosts, and `cd /usr && ls` works. The first draft of the `.env` regex also blocked `.env.example`, hence the explicit allow rule.

Known limits (documented, not fixed):

- The deny list covers only the paths listed. Other secrets, such as `~/.config/gh`, remain readable.
- The project directory is writable, which includes `.git` and `.env`.
- The sandbox is macOS-only.
- `read_file` runs in the harness process and is **not** wrapped by the sandbox. A project `.env` is therefore readable through `read_file` but denied through `cat .env` in bash. This inconsistency is intentional to leave in place; it demonstrates why one real boundary beats per-tool checks.

## `bash` tool

### Definition

```ts
export const BASH_TOOL = {
  type: "function",
  name: "bash",
  description:
    "Run one shell command with /bin/bash -c inside a sandbox. " +
    "Each call is a fresh shell: cd and env vars do not persist, so chain with && when needed. " +
    "The working directory is the project root. " +
    "Files can be read broadly (except credential paths) but written only under the project and temp dir. " +
    "There is no network access. Commands time out after 30s and output is truncated at 16 KiB.",
  parameters: {
    type: "object",
    properties: { command: { type: "string", description: "The shell command to run." } },
    required: ["command"],
    additionalProperties: false,
  },
  strict: true,
} satisfies OpenAITool
```

There is no `timeout` argument. With `strict: true` every property must be listed in `required`, so an optional one would need a nullable type. A fixed limit keeps the schema the same shape as `read_file`.

The description carries more weight than it did for `read_file`: the schema no longer tells the model what is possible, so the description teaches it the sandbox rules.

### Execution (`src/bash.ts`)

`runBash(rawArguments, { rootDir })` mirrors `readFile`:

1. `JSON.parse`, then validate with `z.object({ command: z.string().min(1) }).strict()`. Failures return `{"error": "..."}`.
2. Spawn `sandbox-exec -p <profile> /bin/bash -c <command>` with `cwd: rootDir` and `stdin: "ignore"`.
3. Read stdout and stderr incrementally. Keep the first 16 KiB of each; set `truncated: true` if anything was dropped. Head truncation is simple; its downside (build errors at the end of long output are lost) is a known behavior to observe.
4. A 30 s timer kills the process (SIGKILL) and sets `timed_out: true`. Grandchildren (`sleep 100 &`) may survive and hold pipes open, so reading stops when the kill fires and does not wait for pipe closure. No process-group killer is built.
5. Return JSON: `{ "exit_code": 0, "stdout": "...", "stderr": "", "truncated": false, "timed_out": false }`.

### Scrubbed environment

The child receives only `PATH`, `HOME`, `LANG`, `TERM` and `TMPDIR`. A spawned child inherits the parent's environment by default, which includes `OPENAI_API_KEY`. The sandbox permits reading the process's own environment, so `echo $OPENAI_API_KEY` would put the key into the model context and the JSONL log even though the network is blocked. The environment is a separate channel from files and network, so it is closed explicitly.

### `stdin: "ignore"`

fd 0 is connected to `/dev/null`, so any read from stdin returns EOF immediately. A bare `cat`, `read x` or `python` therefore exits instead of blocking until the timeout. It also prevents a child from reading keystrokes meant for the TUI. Reading files, pipes and heredocs inside the command are unaffected, because those use different file descriptors. It does not stop programs that open `/dev/tty` directly, which is why `/dev/tty` writes are denied by the profile and the timeout stays as a backstop.

### Result mapping

| Situation | Event | Output |
|---|---|---|
| Invalid JSON or schema | `tool_failed` | `{"error": "..."}` |
| `sandbox-exec` fails to spawn | `tool_failed` | `{"error": "..."}` |
| Command ran, any exit code (including a sandbox denial) | `tool_finished` | result JSON |
| Timeout | `tool_finished` | result JSON with `timed_out: true` |

`tool_failed` means the harness could not run the command. A non-zero exit is not a harness failure (`grep` returns 1 for "no matches"), so the TUI shows a normal card with `exit 1` in the summary, e.g. `done bash · exit 1 · 9ms`, and not a red one.

## Changes to existing code

- **`src/agent-loop.ts`:** replace `ReadFileResult` in the loop with a shared type.
  ```ts
  type ToolResult =
    | { ok: true; output: string; summary: string }
    | { ok: false; output: string; error: string }
  ```
  The tool builds its own summary, and the loop forwards it. `executeTool` dispatches on `call.name` to `read_file` or `bash`; unknown names still return the `unknown tool` error. The injectable `executeReadFile` stays, and `executeBash` is added. The `TurnEvent` union does not change. The 8-call cap and the one-call-per-response rule are unchanged.
- **`src/read-file.ts`:** thin adaptation to `ToolResult` (`summary: "<path> · <N>B"`). No behavior change.
- **`src/openai/client.ts`:** `tools: [READ_FILE_TOOL, BASH_TOOL]`. The log event is unchanged apart from `request_body` showing both tools.
- **`src/model-context.ts`:** rewrite `DEVELOPER_GUIDANCE` to describe both tools and each call being stateless. It does not say which tool to prefer, so the model's choice is observable.
- **`src/app.tsx`:** the card already renders `item.summary`, so little changes. The card still shows raw arguments JSON, and the expanded card's fixed height clips long output (the model still receives all of it and the JSONL log keeps the full text). Both are left for later.
- **Startup check in `app.tsx`:** before creating the client, require `process.platform === "darwin"` and an existing `/usr/bin/sandbox-exec`; otherwise print a configuration error and exit 1, in the style of the missing-API-key check.

## Reference observations

From the `opencode` and `pi` checkouts in the repo root (read on 2026-10-03):

- **OpenCode** has dedicated tools (`read`, `edit`, `write`, `apply_patch`, `shell`, `grep`, `glob`) and a rule-based permission system in `packages/opencode/src/permission/`. A rule is `{ permission, pattern, action }` with action `allow | deny | ask`, evaluated with **last match wins** (`findLast`, the same ordering idea as Seatbelt). If no rule matches, the default is `ask`. Each tool calls `ctx.ask({ permission, patterns, always })` before acting; `edit` asks for `"edit"`, `read` for `"read"`. A user reply is `once`, `always` (appends allow rules for the `always` patterns) or `reject` (optionally with feedback that becomes a `CorrectedError`). Tools can be hidden from the model entirely if a `*` deny rule applies. This design depends on tools being separate: the permission name and path patterns come from structured arguments.
- **OpenCode's shell tool** cannot rely on structured arguments. It parses the command with a tree-sitter parser to extract the directories and command patterns it touches, asks for `external_directory` if any path is outside the project, and asks for `shell` with command-prefix patterns. `permission/arity.ts` maps a command to its "human-understandable prefix" (`npm run dev`, `git checkout`) so an `always` approval covers a command family. This is the parsing complexity that a dedicated tool avoids and that an OS sandbox sidesteps.
- **Pi** states in its README that it has **no permission popups**: "Run in a container, or build your own confirmation flow with extensions." The isolation boundary is delegated to the environment, which is closer to this milestone's approach than OpenCode's.
- **Sandboxing in both references.** OpenCode has **no** sandbox: its `SECURITY.md` says the permission system "is not designed to provide security isolation" and recommends Docker or a VM for isolation. Pi's core has none either, but ships an example extension (`packages/coding-agent/examples/extensions/sandbox/index.ts`) that wraps `bash` with `@anthropic-ai/sandbox-runtime`, which uses `sandbox-exec` (Seatbelt) on macOS and `bubblewrap` on Linux. Its example config denies reads of `~/.ssh` and `~/.aws`, the same deny list chosen here. So this milestone's approach matches Pi's optional extension, and neither reference ships a sandbox by default.

Takeaway: dedicated tools make permissioning tractable (structured arguments, parseable patterns, per-tool UX). A generic `bash` tool pushes the problem either into shell parsing (OpenCode) or into an external boundary (Pi, and this milestone's Seatbelt).

## Testing

No unit tests are added for this milestone; this is a learning repo (see project memory). Existing tests are kept and updated only as needed to compile against the new `ToolResult` type. Integration tests exercise the real thing.

### Sandbox integration tests

These run real `sandbox-exec` and are skipped when the platform is not `darwin`. Each test uses a temp project directory and a temp `HOME`, so none touch the real `~/.ssh`.

- A write inside the project succeeds.
- A write outside is denied.
- Reading a fake `.ssh/key` and `.env` is denied; `.env.example` is allowed.
- A symlink inside the project that points at a denied path is still denied.
- Network access fails, using a local `Bun.serve` port to show localhost is blocked too.
- Timeout: `sleep 10` with the limit lowered through an injected option returns `timed_out: true`.
- Truncation: `yes | head -c 100000` yields `truncated: true` and exactly 16 KiB.
- Env scrubbing: a canary variable set in the test process does not appear in `env` output.
- A bare `cat` returns promptly (stdin is EOF).
- A non-zero exit returns a normal result with `exit_code: 1`, not a harness error.

### Loop integration test

One test runs `runTurn` against a client with an injected `fetch` that scripts a `bash` function call followed by a final message, using the real `runBash`. It asserts the event order, that `function_call_output` is appended to context and that the summary reads `exit 0 · …`.

### Live smoke test

The user runs this against the real API. Steps go into `docs/learning/02-sandboxed-bash.md`:

1. Ask it to list and read `fixtures/hello.txt`. Note which tool it picks.
2. Ask it to write a file in the project.
3. Ask it to read `~/.ssh` and `.env` (expect a denial through bash; note that `read_file .env` still succeeds).
4. Ask it to `curl` a URL (expect failure).
5. Ask it to print its environment (expect no API key).

## Acceptance criteria

- The model can call `bash` and `read_file` in the same session.
- Writes outside the project, reads of listed credential paths and network access are denied inside `bash`, and each denial reaches the model as a normal result.
- The child environment does not contain `OPENAI_API_KEY`.
- Non-macOS or missing `sandbox-exec` fails at startup with a clear error.
- Sandbox integration tests pass on macOS.
- `docs/learning/02-sandboxed-bash.md` records the mechanics, the limits and the smoke results.
