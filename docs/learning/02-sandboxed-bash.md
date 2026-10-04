# Learning note: sandboxed bash

Date: 2026-10-03

Spec: `docs/superpowers/specs/2026-10-03-milestone-two-sandboxed-bash-design.md`

Visual explainer for the OS concepts (kernel, processes, pipes, Seatbelt): `docs/learning/02-sandbox-under-the-hood.html`. Open it in a browser.

## What this milestone does

The model now has two tools: `read_file` (kept for comparison) and `bash`. `bash` runs one command in a fresh `/bin/bash -c` wrapped by macOS Seatbelt (`sandbox-exec`). The boundary is the kernel, not a string check on the command.

```text
bash call
  -> runBash            validate { command }
  -> runSandboxed       realpath the dirs, build the profile, spawn
       sandbox-exec -p <profile> /bin/bash -c <command>
       cwd = project root, stdin = /dev/null, env = allowlist
  -> JSON { exit_code, stdout, stderr, truncated, timed_out }
```

## How the pieces work

- **Profile** (`src/sandbox.ts`, `buildProfile`): `(allow default)`, then subtract. Writes are denied except the project, temp, and `/dev/null`; the network is denied; `~/.ssh`, `~/.aws` and `.env*` are unreadable, with `.env.example` re-allowed. The last matching rule wins, so order matters.
- **Denials are normal results.** The syscall fails with `EPERM` (`Operation not permitted`), the command exits non-zero, and the model reads stderr. `tool_failed` is only for harness problems (bad arguments, `sandbox-exec` failing to spawn).
- **Scrubbed env.** The child gets `PATH`, `HOME`, `LANG`, `TERM`, `TMPDIR`. Otherwise `echo $OPENAI_API_KEY` would leak the key into the model context and the JSONL log, even with the network blocked. The environment is a channel the sandbox does not cover.
- **`stdin: "ignore"`.** fd 0 is `/dev/null`, so a bare `cat` gets EOF and exits instead of waiting. It does not stop programs that open `/dev/tty`; that is why `/dev/tty` writes are denied and the 30s timeout stays.
- **Pipes can outlive bash.** `sleep 5 &` keeps stdout open after the shell exits, so after exit we wait 200ms for the pipes and then stop reading. Grandchildren are not killed.

## Known limits

- The deny list covers only the listed paths. `~/.config/gh` and other secrets stay readable.
- The project directory is writable, including `.git` and `.env`.
- macOS only; `sandbox-exec` is deprecated and SBPL is not officially documented.
- `read_file` runs in the harness process and is not sandboxed. `read_file .env` succeeds while `cat .env` in bash is denied. That inconsistency is the lesson: per-tool checks and a real boundary disagree.
- The TUI card clips long output (fixed height); the model and the JSONL log get all of it.

## Live smoke (run this yourself; it uses the paid API)

Start with `bun run start` from the repo root. Expected results are in brackets.

1. `List the files in fixtures/ and show me what is in hello.txt.`
   Note which tool it picks. [`bash` or `read_file`; either is fine, the choice is the observation.]
2. `Create notes.txt in the project containing the word hi, then show it.`
   [Succeeds; summary `exit 0`.] Delete `notes.txt` afterwards.
3. `Run: cat ~/.ssh/id_ed25519.pub`
   [Card shows `exit 1`; model reports "Operation not permitted".]
4. `Use bash to cat .env, then use read_file on .env.` (create a throwaway `.env` first)
   [bash denied; read_file succeeds.]
5. `Run: curl -sS https://example.com`
   [Non-zero exit; cannot resolve host.]
6. `Run: env and tell me if you see an API key.`
   [No `OPENAI_API_KEY`.]
7. `Run: sleep 60`
   [After about 30s: `timed out · 30000ms`.]

Record the results below.

## Results

_Not run yet._

## Questions this leaves open

- **Dedicated tools.** What does `bash` lose compared to `read_file`/`edit`? Structured results and limits, safe exact-match edits, per-tool permissioning, UI (diffs), and knowing which calls can run in parallel.
- **Parallel tool calls.** Still rejected (`parallel_tool_calls: false`). Reads are safe to batch; arbitrary shell commands usually are not.
- **Removing `read_file`.** A small follow-up commit once the comparison has been observed.
