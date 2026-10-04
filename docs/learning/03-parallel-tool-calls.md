# Learning note: parallel tool calls

Date: 2026-10-03

Spec: `docs/superpowers/specs/2026-10-03-milestone-three-parallel-tool-calls-design.md`

## What changed

Before, a response with more than one `function_call` failed the turn. Now the loop runs them all.

```text
response.output = [ function_call A, function_call B ]

context += output                     the provider sees its own calls first
run A and B                           together if both tools are parallel-safe, else one by one
context += function_call_output A     always in call order,
context += function_call_output B     not completion order
```

`call_id` is still the only link between a call and its output.

## The rule

| Batch | Runs |
|---|---|
| 2+ calls, all `read_file` | together |
| any `bash` in the batch | the whole batch, one by one, in order |
| unknown tool name | one by one; that call fails |

`read_file` only reads, so it is safe. `bash` can do anything and the harness cannot tell which files a command touches, so it never runs alongside other calls. Pi and OpenCode put this safety inside the tool (a per-file queue or lock in `write` and `edit`), which works because a dedicated write tool knows its file. See the spec.

## Live smoke (run this yourself; it uses the paid API)

Start with `bun run start`. Expected results are in brackets.

1. `Read fixtures/hello.txt and package.json and tell me what each says.`
   [Two `read_file` cards appear running at the same time, then both finish.]
2. `Read fixtures/hello.txt and package.json, then run ls with bash.`
   [Depends on what the model batches. If it puts all three in one response, the cards run one at a time, in order.]
3. `Run these two commands and compare: ls src and ls test`
   [Two `bash` calls may come in one response. They run one after another, never together.]
4. After a run, check the log: `jq -c '.request_body.parallel_tool_calls' .harness/logs/openai.jsonl | sort -u` [`true`].
5. Look at the raw exchange for a batched turn: `jq -c '.request_body.input[-6:] | map(.type)' .harness/logs/openai.jsonl | tail -1`
   [`function_call`s first, then the `function_call_output`s.]

Note which tool the model reaches for when it needs several files. Whether it batches `read_file` calls, or issues `cat a && cat b` in one `bash`, is the whole point of the comparison.

## Results

_Not run yet._

## Open questions

- Does the model actually batch reads unprompted, or only when the guidance asks it to?
- Whole-batch scheduling makes a single `bash` hold up reads that could have run. Does that show up in practice?
- Next: a dedicated `edit` tool with a per-file mutation queue, and steering input during a turn.
