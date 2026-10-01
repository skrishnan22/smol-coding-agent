# Learning note: visible agent loop

Date: 2026-09-14

## Prompt

```text
Use read_file to read fixtures/hello.txt and reply with only the file contents.
```

## Observed loop

1. Model requested `read_file` with `{"path":"fixtures/hello.txt"}`.
2. Harness executed the local tool and returned `function_call_output` with the same `call_id`.
3. Model continued and answered with the file contents.

Event chain:

```text
model_started
  -> usage_recorded
  -> tool_started
  -> tool_finished
  -> model_started
  -> usage_recorded
  -> assistant_finished
```

## Result

- Tool summary: `fixtures/hello.txt · 31B`
- Final assistant text: `hello from the harness fixture`
- Session usage for this turn: **489 input / 30 output tokens**
- Approximate cost: **$0.000134**

No API key or raw secret is recorded here. Raw provider JSON remains in `.harness/logs/openai.jsonl` (gitignored).

## Takeaway

The model does not run tools. It emits a `function_call`; the harness runs the tool in-process, correlates the result by `call_id`, and only stops when a later response has no tool call (`assistant_finished`).

## Follow-up and restart smoke

Date: 2026-10-01

This run closes the two acceptance criteria the first smoke did not exercise: a follow-up that depends on earlier in-memory context, and a restart that starts empty.

### Session 1: follow-up relies on resent context

| Call | Input items sent | Model output | Input / output tokens |
| --- | --- | --- | --- |
| 1 | developer, user | `function_call read_file {"path":"fixtures/hello.txt"}` | 216 / 21 |
| 2 | + `function_call`, `function_call_output` (same `call_id`) | `hello from the harness fixture` | 269 / 9 |
| 3 | + assistant message, follow-up user message | `fixture` | 301 / 5 |

Follow-up prompt:

```text
Without calling any tools, what was the last word of the file you just read?
```

The third request resent the first turn's `function_call`, `function_call_output`, and assistant message verbatim with `store: false`, and the live API accepted them (HTTP 200). The model answered from context without another tool call.

Session total: **786 input / 35 output tokens, approx. $0.000199**.

### Session 2: restart starts empty

After restarting `bun start`, the transcript and footer were empty and the first request carried only the developer and user messages.

```text
Without calling any tools: which file did I ask you to read earlier in this conversation? If none, say 'no earlier request'.
```

Answer: `no earlier request` (228 input / 7 output tokens, approx. $0.000054).

### Takeaway

Stateless multi-turn works against the real API: the harness owns the whole conversation and resends it each call, so input tokens grow every turn (216 → 269 → 301 here). That growth is what a later compaction milestone will have to manage.
