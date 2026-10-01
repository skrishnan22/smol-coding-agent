# Milestone One: Visible Agent Loop

## Goal

Build the smallest useful AI harness that makes one complete agent loop visible:

```text
user prompt
  -> OpenAI response
  -> local tool call
  -> local tool result
  -> OpenAI continuation
  -> final assistant answer
```

This is a learning artifact, not a production agent. The implementation should favor visible data flow and direct code over generic abstractions.

## Learning questions

Milestone one must make these questions answerable from the code and UI:

1. What exact JSON is sent to a model?
2. How does a model request a local tool?
3. How does the harness correlate a result using `call_id`?
4. What causes the harness to call the model again or stop?
5. Which state belongs to the model context, and which state exists only for presentation?
6. How much did each request and the session cost?

## Scope

The milestone includes:

- TypeScript running on Bun.
- A React-based OpenTUI interface.
- Raw `fetch` calls to the OpenAI Responses API.
- `gpt-5.6-luna` with reasoning disabled.
- One interactive, in-memory conversation.
- One local function tool: `read_file`.
- Non-streaming model responses.
- Compact, expandable tool cards.
- Token and approximate cost reporting.
- Focused automated tests and one live smoke test.

The milestone excludes:

- Persistence or session recovery.
- Compaction or long-term memory.
- MCP.
- Code mode.
- Multiple providers or a generic provider interface.
- Multiple or parallel tools.
- Streaming.
- Retries, cancellation, steering, or queued prompts.
- Permissions, approvals, shell execution, or a sandbox.
- Markdown rendering, themes, mouse controls, and polished terminal UX.

## Repository boundary

`harness-eng` becomes the Git repository for the learning harness. The existing Letta, OpenCode, OpenTUI, and Pi repositories remain ignored, read-only reference checkouts.

As built, the event union lives in `agent-loop.ts` and the OpenAI adapter is split into an `openai/` folder:

```text
harness-eng/
├── src/
│   ├── app.tsx
│   ├── agent-loop.ts        # runTurn and the TurnEvent union
│   ├── model-context.ts
│   ├── read-file.ts
│   ├── openai/
│   │   ├── client.ts
│   │   ├── tools.ts
│   │   └── types.ts
│   └── logging/
│       ├── jsonl.ts
│       └── types.ts
├── test/
├── docs/
│   ├── learning/
│   └── superpowers/specs/
├── package.json
├── tsconfig.json
└── .env.example
```

Each later learning milestone should be a focused Git commit. Earlier mechanics remain inspectable through Git history rather than copied milestone directories.

## Dependencies and runtime

- Bun 1.3 or newer runs the project, tests, and TypeScript directly.
- `@opentui/core` and `@opentui/react` are pinned to version `0.5.11`, matching the inspected reference checkout.
- React is pinned to version `19.2.3`, matching the inspected OpenTUI React package.
- The harness does not use the OpenAI SDK. Bun's built-in `fetch` sends and receives the protocol directly.
- The API key comes only from the `OPENAI_API_KEY` process environment. The harness does not load a local `.env` file.

## Architecture

The system has four narrow responsibilities.

### OpenTUI application

`app.tsx` owns terminal input, focus, transcript rendering, session totals, and the busy state. It calls the agent loop and folds emitted events into renderable transcript items. It does not construct OpenAI requests or execute tools.

### Agent loop

`agent-loop.ts` owns the decision to continue or stop. It accepts a prompt, the current model context, and one event callback:

```ts
runTurn(prompt, context, onEvent)
```

It calls OpenAI, appends returned output items to context, executes requested tools, appends correlated tool results, and repeats until it receives final text or reaches a terminal error.

The callback is the entire event mechanism. Milestone one does not introduce an event emitter, event bus, middleware, or subscription abstraction.

### OpenAI protocol adapter

`openai.ts` owns the raw HTTP boundary. It builds `POST /v1/responses`, checks the HTTP result, parses untrusted JSON, and returns the small response shape required by the loop. It accepts a fetch function so tests can supply a scripted implementation without replacing process globals. Provider-specific fields do not leak into OpenTUI components.

This is deliberately an OpenAI adapter, not a generic provider interface. Provider compatibility becomes a later learning milestone.

### Local tool

`read-file.ts` defines the tool schema, validates its single argument, applies the local path and size boundary, and returns a string result. There is no generic tool registry for a one-tool harness; the loop dispatches the one known tool directly and rejects other names.

## Two kinds of in-memory state

The harness keeps model state separate from presentation state.

### Model context

The model context is an ordered array of Responses API input items. It starts with one developer message describing the harness and its tool, then accumulates:

- User messages.
- Response output items, preserved as returned by OpenAI.
- `function_call_output` items produced by the harness.

Every request uses `store: false` and resends this array. No server-side conversation or `previous_response_id` is used. This makes context growth visible and creates the right basis for a later compaction experiment.

### UI transcript

The UI transcript is a projection for humans. It contains user messages, assistant messages, tool cards, and turn errors. It does not become model input.

Restarting the program clears both structures.

## OpenAI request

Each provider turn sends:

- Model: `gpt-5.6-luna`.
- Reasoning effort: `none`.
- Storage: disabled.
- Parallel tool calls: disabled.
- Maximum output: 800 tokens.
- The entire current model context.
- The strict `read_file` function schema.

The tool schema accepts exactly `{ "path": string }` and rejects additional properties.

The adapter parses the raw `output` array rather than relying on SDK helpers. It preserves returned output items before interpreting them, because those items are part of the next stateless request.

## Agent-loop algorithm

When the user submits a non-empty prompt:

1. Append the user message to model context.
2. Emit the user transcript item through the application before starting the loop.
3. Emit `model_started`.
4. Request a complete, non-streaming OpenAI response.
5. Record usage and classify the returned output before mutating model context.
6. If the response contains more than one `function_call`, emit `turn_failed` without appending the response output, because milestone one cannot produce a complete result for that response.
7. Otherwise, append every returned output item to model context.
8. If the response contains one `function_call`:
   1. Emit `tool_started` with its `call_id`, name, and raw JSON arguments.
   2. Validate and execute `read_file`.
   3. Emit `tool_finished` or `tool_failed`.
   4. Append a `function_call_output` carrying the same `call_id`.
   5. Continue at step 3.
9. If the response contains final output text, emit `assistant_finished` and return the updated context.
10. If the response is failed, incomplete without usable output, malformed, or exceeds eight provider calls, emit `turn_failed` and return control to the UI.

Although parallel tool calls are disabled, the adapter treats more than one function call in a response as an unsupported milestone-one response and ends the turn visibly. It must not silently discard a call.

## Events

`events.ts` defines a discriminated union with these events:

```text
model_started
tool_started       { callId, name, rawArguments }
tool_finished      { callId, output }
tool_failed        { callId, error }
assistant_finished { text }
usage_recorded     { inputTokens, outputTokens, estimatedCost }
turn_failed        { message }
```

The event callback may be synchronous. The loop must emit events in the same order in which work happens.

The OpenTUI reducer inserts a tool card for `tool_started` and locates later updates by `callId`. This makes the protocol identifier visible rather than inventing a second correlation ID.

## OpenTUI behavior

The interface uses a chronological, single-column transcript with one input at the bottom.

- A user message appears immediately after submission.
- While waiting for OpenAI, a small model-activity indicator is visible.
- A running tool card is expanded and shows its raw arguments.
- A successful card collapses to a summary containing tool name, status, path, and result size.
- A failed card stays expanded and displays its error.
- A focused completed card expands or collapses with Enter.
- Final assistant text appears after any tool cards.
- A quiet footer shows accumulated session input tokens, output tokens, and approximate cost.

Keyboard behavior:

- Enter submits when the input is focused.
- Tab and Shift+Tab cycle between the input and tool cards.
- Enter toggles the focused completed tool card.
- Ctrl+C exits.

The input is disabled while a turn is running. A second prompt cannot be queued or used to steer an active response.

## `read_file` boundary

The tool accepts one relative path rooted at the process's startup directory.

It must:

- Reject an empty path.
- Reject absolute paths.
- Resolve the existing target and reject traversal or symlinks that resolve outside the startup directory.
- Require a regular file.
- Reject files larger than 32 KiB before reading them.
- Decode UTF-8 strictly and reject binary or invalid UTF-8 content.
- Return JSON text containing the normalized relative path, byte count, and content.

This boundary limits accidental reads, output size, and token spending. It is not a security sandbox. A file within the startup directory remains readable, including sensitive files placed there. The real sandbox and permission model are separate future milestones.

## Failure behavior

Milestone one does not retry automatically.

- A missing API key fails before OpenTUI starts with a short configuration error.
- An HTTP, network, authentication, rate-limit, or malformed API response emits `turn_failed`, ends the current turn, and re-enables input.
- Invalid tool JSON, invalid arguments, unknown tool names, and file errors emit `tool_failed`. The loop also returns a structured error string to the model using `function_call_output`, allowing the model to explain or recover.
- A response with multiple function calls fails the turn as unsupported.
- Eight provider calls without final text emits a loop-limit failure.

Failed provider responses and partially decoded response bodies are not appended to model context. Tool-call output items are appended only after the corresponding tool outcome is known.

## Usage and cost

The adapter reads token usage from each successful response. The application accumulates input and output tokens across the process lifetime.

The displayed price is explicitly approximate and uses checked configuration values for `gpt-5.6-luna`:

- Input: USD 0.20 per million tokens.
- Output: USD 1.20 per million tokens.

The calculation includes all usage reported by the response. It does not attempt to predict a request's cost before sending it. Pricing constants live next to the fixed model configuration so a future model change cannot silently retain unrelated prices.

## Testing

Automated tests do not call a paid model.

### Tool tests

- Reads a valid UTF-8 file.
- Rejects absolute paths and parent traversal.
- Rejects a symlink that resolves outside the startup directory.
- Rejects a directory, oversized file, and invalid UTF-8 file.

### Loop tests

A scripted `fetch` replacement returns realistic Responses API JSON. Tests prove:

- A final response ends the loop.
- A function call executes `read_file` and causes another provider request.
- The second request contains the original output item and a `function_call_output` with the same `call_id`.
- Tool failures are returned to the model and remain visible as events.
- HTTP and malformed-response failures stop without retries.
- Multiple tool calls fail visibly.
- Eight provider calls trigger the loop limit.
- A second user prompt includes the earlier in-memory context.
- Usage events report the API's token counts and configured estimate.

### OpenTUI tests

OpenTUI's test renderer verifies:

- Prompt submission and busy input behavior.
- Chronological transcript rendering.
- Running, completed, and failed tool-card states.
- Completed cards collapse automatically.
- Focus plus Enter expands a completed card.
- Session usage appears in the footer.

### Live smoke test

One manual run uses the real API against a small committed text fixture. The evidence recorded in `docs/learning/01-visible-agent-loop.md` includes:

- The prompt.
- The tool call and correlated result.
- The final answer.
- Actual input and output token counts.
- Approximate reported cost.

No API key or raw secret is recorded.

## Acceptance criteria

Milestone one is complete when a user can:

1. Export `OPENAI_API_KEY` and run `bun start`.
2. Ask the model to read the committed fixture.
3. Observe a running tool card followed by the collapsed completed card.
4. Focus and expand the card to inspect raw arguments and output.
5. Receive the final assistant answer beneath the tool card.
6. Ask a follow-up that relies on earlier in-memory context.
7. See session token totals and approximate cost.
8. Restart the application and observe an empty session.

All focused automated tests must pass before the live smoke test. The live run is required because passing scripted tests does not prove that the current API accepts the emitted wire format.

## Reference observations

- Pi's agent loop separates loop decisions from lifecycle event consumers and continues when tool results require another assistant turn.
- OpenCode treats tool calls as stateful parts correlated by ID and transitions them through running, completed, and failed states.
- OpenTUI's React example provides the required renderer, input submission, focus, and keyboard primitives.
- OpenAI's function-calling protocol returns JSON-encoded arguments and requires the harness to send a `function_call_output` with the matching `call_id`.

Reference paths and documentation:

- `pi/packages/agent/src/agent-loop.ts`
- `opencode/packages/opencode/src/session/processor.ts`
- `opentui/packages/react/examples/basic.tsx`
- <https://developers.openai.com/api/docs/guides/function-calling>
- <https://developers.openai.com/api/docs/models>
