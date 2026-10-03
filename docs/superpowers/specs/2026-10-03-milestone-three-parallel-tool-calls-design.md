# Milestone Three: Parallel Tool Calls

## Goal

Let the model request several tool calls in one response, and run them together when that is safe. Learn what parallel tool calls change in the loop (ordering, correlation, failure) and why safety has to be a property of the tool.

## Learning questions

- What does a response with several `function_call`s look like, and what must go back?
- Why can reads run together but `bash` cannot, and where do the references put that decision?
- Which order do results take: completion order or call order?

## Behavior

1. The request sets `parallel_tool_calls: true`. The model may return several `function_call` items in one response.
2. The loop appends the whole `output[]` to the context first, then runs the calls, then appends one `function_call_output` per call, **in call order**.
3. **Scheduling policy (whole batch, as in Pi):** if there is more than one call and every call is to a parallel-safe tool, all run concurrently. Otherwise the whole batch runs one by one, in order. A single `bash` call in the batch makes it sequential.
4. Parallel safety is a flag on the tool in the loop: `read_file` is safe, `bash` is not. `bash` can touch anything and nothing tells the harness which files, so it cannot be proven safe. An unknown tool name counts as unsafe.
5. Each call is independent. A failing call, or a tool that throws, becomes a `tool_failed` result and its siblings still complete. A thrown error is caught per call (`tool crashed: <message>`) so it cannot reject the whole `Promise.all`.
6. The 8-call-per-turn cap counts provider calls and is unchanged. The old "more than one function call fails the turn" rule is removed.

## Events and UI

`TurnEvent` is unchanged.

- Parallel batch: every `tool_started` is emitted up front (all cards show as running), then `tool_finished` / `tool_failed` arrive in **completion order**.
- Sequential batch: each `tool_started` is emitted just before that call runs, so a queued call does not look like it is running.
- The transcript already matches updates by `callId`, so several running cards need no UI change.
- Ordering has two audiences: the UI sees completion order (it is live), the model sees call order (the context stays deterministic).

The developer guidance now tells the model to request independent `read_file` calls in one response and says `bash` calls run one at a time. The `read_file` tool schema is unchanged.

## Reference observations

Read from the `pi` and `opencode` checkouts on 2026-10-03.

- **Pi** (`packages/agent/src/agent-loop.ts`, `packages/coding-agent/src/core/tools/`): the default mode is `"parallel"`. Calls are prepared (validated, permission-checked) one after another, then the allowed ones execute concurrently with `Promise.all`, and results are emitted in call order. A tool can set `executionMode: "sequential"`, and one such tool in the batch makes the **whole batch** sequential. Only example extensions set it; as far as a grep of `src` shows, the built-in tools do not. File safety lives in `write` and `edit`, which wrap their work in `withFileMutationQueue(path, fn)`, a queue keyed by the file's `realpath`: same-file operations run in order, different files run in parallel.
- **OpenCode** (`packages/opencode/src/tool/`): `edit.ts` holds a per-file `Semaphore(1)` keyed by resolved path. `read.txt` tells the model to "call this tool in parallel when you know there are multiple files you want to read." How its loop schedules the calls was not traced.

Takeaway: both references make concurrent file writes safe inside the tool, with a lock per file. That works only because a dedicated write tool knows which file it touches. A generic `bash` gives the harness no file to lock, so the only safe choice is to run it alone. This is a concrete reason dedicated read/write tools exist.

## Out of scope

- A per-file mutation queue. It belongs with a dedicated `edit` or `write` tool, which does not exist yet.
- Segment-by-segment scheduling (safe calls around a `bash` running together). Whole-batch is simpler and matches Pi; refine only if mixed batches turn out to matter.
- A cap on concurrent calls, cancellation, and a per-call timeout for `read_file`.
- Steering and queueing user input while a turn runs.

## Testing

No unit tests (see project memory). `test/parallel-tools.integration.test.ts` runs the real client and loop against a scripted `fetch`, using real tools where timing does not matter and slow injected tools where it does:

- Two real `read_file` calls both run, `parallel_tool_calls` is `true` in the request, and both outputs return in call order after the `function_call` items.
- Two safe calls overlap in time; the second finishes first, yet outputs keep call order and the UI sees completion order.
- A batch with `bash` runs strictly one at a time, in order; two `bash` calls never overlap.
- One failing call, one thrown error, and one unknown tool name each leave the rest of the batch intact.
- A real `read_file` plus a real `bash` in one response (macOS).

Two existing tests that encoded the old rule (the loop test and the TUI test for "several calls fail the turn") were replaced: the loop one by the file above, the TUI one by an end-to-end test that shows a card per call and continues.

## Acceptance criteria

- A response with several `function_call`s no longer fails the turn.
- Safe calls run concurrently, a batch with `bash` runs sequentially, and outputs always go back in call order.
- One call's failure never loses another call's result.
- Typecheck and the full test suite pass.
