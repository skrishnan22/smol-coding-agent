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
