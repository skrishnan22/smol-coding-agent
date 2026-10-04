# Learning note: steering and queueing

Date: 2026-10-03

Spec: `docs/superpowers/specs/2026-10-03-milestone-four-steering-and-queueing-design.md`

## What changed

Before, the prompt box was disabled while a turn ran. Now you can type, and the message waits in a queue until the loop reaches a point where it is safe to add it.

```text
turn running ...
  you type + Enter     -> follow-up queue   (waits until the model would stop)
  you type + Ctrl+S    -> steering queue    (goes in before the next model call)
```

## Why "safe point" matters

The model is stateless: every request resends the whole context. A `function_call` must be answered by a `function_call_output` before anything else follows it. If a user message landed between a call and its output, the request would be malformed. So the loop only checks the queues at two places:

```text
model call
  -> response has tool calls?
       run them, append function_call_output(s)
       DRAIN POINT 1: steering    (every call now has its answer)
       -> next model call
  -> no tool calls: the model would stop
       DRAIN POINT 2: steering first, then follow-ups
       -> if anything was injected, another model call
```

Nothing is interrupted. A steering message typed during a 30 second `bash` command waits for it to finish. Aborting is a separate, bigger piece of work.

## Live smoke (run this yourself; it uses the paid API)

Start with `bun run start`. Expected results are in brackets.

1. Ask: `Read fixtures/hello.txt and package.json, then explain both in detail.` While it runs, type `keep it to one sentence each` and press **Enter**.
   [A dimmed `QUEUED · follow-up` row appears. After the answer, it becomes a YOU row and the model replies again.]
2. Ask something that needs a tool, such as `Run sleep 5 with bash, then tell me a joke.` While `bash` runs, type `make it a short one` and press **Ctrl+S**.
   [`QUEUED · steering` appears. When the command ends, it turns into a YOU row before the model's next reply, and the joke should be short.]
3. Queue two follow-ups in a row during one turn.
   [Both rows show as queued. When injected they appear in the order typed, and the model answers them together in one reply.]
4. Check the exact context: `jq -c '.request_body.input | map(if .type=="message" then .role else .type end)' .harness/logs/openai.jsonl | tail -1`
   [For case 2 the end of the list reads `function_call`, `function_call_output`, `user`.]
5. Press Ctrl+S with the prompt box empty, and again while idle.
   [Nothing happens when empty. When idle with text it just starts a turn.]

Note whether Ctrl+S reaches the app in your terminal. If it does not, that is a terminal setting (flow control); the key lives in one line in `HarnessView` and is easy to change.

## Results

_Not run yet._

## Open questions

- Is Ctrl+S comfortable, or would you rather steer with another key?
- With drain-all, three queued messages get one combined reply. Pi's one-at-a-time would give three. Which feels better?
- Next: aborting an in-flight call or command, and editing or removing a queued message.
