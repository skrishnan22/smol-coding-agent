# Milestone Four: Steering and Queueing

## Goal

Let the user keep typing while a turn runs. Messages typed mid-turn wait in a queue and enter the model context at a safe point, so the user can redirect the agent or line up the next task without waiting for the turn to end.

## Learning questions

- When is it safe to add a user message to a stateless request, given that every `function_call` must be answered by its `function_call_output`?
- What is the difference between "change course now" (steering) and "do this when you're done" (follow-up), and where does each one hook into the loop?
- What does the UI owe the user while a message is waiting?

## Behavior

Two queues, as in Pi:

| Queue | Key | Injected when |
|---|---|---|
| **follow_up** | Enter | The model would otherwise stop: the response has no tool calls. Starts another round of work. |
| **steering** | Ctrl+S | The next drain point: after the current response's tool outputs are appended, before the next model call. If the model has stopped, steering is injected there too. |

Enter queues a follow-up because it is the safe default: it never disturbs work in progress. Steering is the deliberate action and has its own key. When no turn is running, both keys simply start a turn.

**Drain points (in `runTurn`):**

1. After the tool outputs are appended and before `continue`. Every `function_call` already has its output, so a user message cannot split a call from its answer.
2. After `assistant_finished`, when the model would stop. Steering is checked first, then follow-ups, so steering typed during the last model call still applies and a follow-up waits for the following stop.

**Drain-all.** At a drain point every queued message of that kind becomes its own user message, in the order typed, and the model is called once. (Pi's default is one-at-a-time: one message per drain point, one model call each. Drain-all is simpler and is used here.)

**Provider-call budget.** The 8-call cap per run applies, but a follow-up starts new work, so injecting one resets the counter. Steering does not reset it.

**No interruption.** A steering message waits for the current model call or tool batch to finish. Cancelling an in-flight request or killing a running sandbox command needs an `AbortSignal` through the client and the sandbox and is out of scope.

**A turn that fails with messages still queued.** The loop returns early and never reaches a drain point. The UI does not drop what the user typed: the oldest queued message (steering first, then follow-up) becomes the next prompt, and the rest stay queued for that turn. If the provider keeps failing, each failure consumes one queued message, so it ends when the queue is empty.

## Loop interface

```ts
type QueuedKind = "steering" | "follow_up"

type RunTurnOptions = {
  // ...
  takeSteering?: () => string[]   // returns the queued steering messages and empties the queue
  takeFollowUp?: () => string[]
}

// new TurnEvent
{ type: "message_injected"; kind: QueuedKind; text: string }
```

The loop stays free of UI state: the TUI owns the queues and hands the loop two functions, the same way `fetch` and the tool executors are injected. Both default to returning nothing, so a turn with nothing queued behaves exactly as before.

## UI

- The prompt box stays focused while a turn runs. Its title reads `Running · Enter queues follow-up · Ctrl+S steers` and the placeholder `Type to queue or steer`.
- A queued message shows below the transcript as `QUEUED · follow-up` or `QUEUED · steering`, dimmed.
- On `message_injected` the queued row disappears and a normal YOU row is appended at that point in the transcript, which is where the model saw it.
- Tab and Enter on tool cards stay disabled while busy.
- Ctrl+S was chosen as the steering key because terminals cannot tell Ctrl+Enter from Enter without the kitty keyboard protocol, and Alt+Enter depends on a terminal setting on macOS. In raw mode Ctrl+S is not flow control. The key is one line in `HarnessView`.

## Reference observations

Read from the `pi` checkout on 2026-10-03 (`packages/agent/src/types.ts`, `agent.ts`, `agent-loop.ts`). The `opencode` checkout was not examined for this.

- Pi's loop config has `getSteeringMessages` and `getFollowUpMessages` callbacks that "must not throw" and return `[]` when empty. Steering is polled after the current assistant turn finishes executing its tool calls, before the next model call, and "tool calls from the current assistant message are not skipped." Follow-ups are polled only when there are no more tool calls and no steering.
- `Agent` holds two `PendingMessageQueue`s, each with a mode: `"all"` or `"one-at-a-time"` (the default for both).
- This milestone copies the two-queue split and the drain points, and differs in using drain-all.

## Out of scope

- Aborting an in-flight model call or a running command.
- Editing or removing a queued message before it is injected.
- One-at-a-time draining.
- Persisting queues across restarts.

## Testing

No unit tests (see project memory). Integration tests only.

`test/steering.integration.test.ts` runs the real client and loop against a scripted `fetch`. A hook inside the fetch pushes to the queues while a request is in flight, which is when a user would be typing.

- Steering lands after every `function_call_output` and before the next call, with the exact request shape asserted.
- A follow-up is not in the request after a tool round, then appears right after the assistant's answer.
- Three queued follow-ups become three user messages in typed order in a single request.
- At the stop point steering goes first and the follow-up waits for the next stop.
- A follow-up gets a fresh provider-call budget.
- With nothing queued the event sequence is unchanged.

`test/steering-ui.integration.test.tsx` drives the real `App` through the test renderer with a hand-resolved client:

- Enter while busy shows `QUEUED · follow-up`, sends nothing yet, then the follow-up is injected once the model finishes.
- Ctrl+S shows `QUEUED · steering`; after a real `read_file` run the next request ends `function_call, function_call_output, user`.
- When idle, both keys start a turn.
- A queued message survives a failed turn and becomes the next prompt.

Existing UI tests only needed the new placeholder text.

## Acceptance criteria

- The prompt box accepts input while a turn runs.
- Follow-ups and steering enter the context at their drain points, never between a `function_call` and its output.
- A queued message is visible until injected and is never silently dropped.
- With nothing queued, behavior and the event sequence are unchanged.
- Typecheck and the full suite pass.
