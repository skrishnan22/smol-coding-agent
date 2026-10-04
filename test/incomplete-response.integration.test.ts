import { expect, test } from "bun:test"
import { runTurn, type TurnEvent } from "../src/agent-loop.js"
import { createInitialModelContext } from "../src/model-context.js"
import { createOpenAIClient } from "../src/openai/client.js"

async function runWith(body: unknown) {
  const client = createOpenAIClient({
    apiKey: "test-key",
    log: async () => {},
    fetch: async () =>
      new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } }),
  })

  const events: TurnEvent[] = []
  const toolCalls: string[] = []
  const initial = createInitialModelContext()
  const result = await runTurn({
    prompt: "write a long file",
    context: initial,
    client,
    rootDir: process.cwd(),
    onEvent: (event) => events.push(event),
    executeReadFile: async (raw) => {
      toolCalls.push(raw)
      return { ok: true, output: "{}", summary: "ran" }
    },
  })
  return { events, toolCalls, context: result.context, initialLength: initial.length }
}

const usage = { input_tokens: 10, output_tokens: 32000 }

test("a response cut off by the output limit fails the turn instead of passing as a final answer", async () => {
  const { events, context, initialLength } = await runWith({
    id: "resp_cut",
    status: "incomplete",
    incomplete_details: { reason: "max_output_tokens" },
    output: [{ type: "message", content: [{ type: "output_text", text: "Here is the start of a very long" }] }],
    usage,
  })

  expect(events.map((event) => event.type)).toEqual(["model_started", "usage_recorded", "turn_failed"])
  const failed = events.at(-1)
  expect(failed?.type === "turn_failed" && failed.message).toContain("cut off")
  expect(failed?.type === "turn_failed" && failed.message).toContain("max_output_tokens")
  // The truncated answer is not kept.
  expect(context).toHaveLength(initialLength + 1)
})

test("a half-written function_call in a cut-off response is never run or added to the context", async () => {
  const { events, toolCalls, context, initialLength } = await runWith({
    id: "resp_cut_call",
    status: "incomplete",
    incomplete_details: { reason: "max_output_tokens" },
    output: [{ type: "function_call", call_id: "call_1", name: "read_file", arguments: '{"path":"fix' }],
    usage,
  })

  expect(toolCalls).toEqual([])
  expect(events.some((event) => event.type === "tool_started")).toBe(false)
  expect(events.at(-1)?.type).toBe("turn_failed")
  expect(context).toHaveLength(initialLength + 1)
})

test("an incomplete response with no stated reason still fails, with a clear message", async () => {
  const { events } = await runWith({
    id: "resp_cut",
    status: "incomplete",
    output: [],
    usage,
  })

  const failed = events.at(-1)
  expect(failed?.type === "turn_failed" && failed.message).toContain("unknown reason")
})

test("any other status that is not completed also fails the turn and names the status", async () => {
  const { events } = await runWith({ id: "resp_failed", status: "failed", output: [], usage })

  expect(events.at(-1)).toEqual({
    type: "turn_failed",
    message: "The response did not complete (status: failed).",
  })
})

test("usage is still recorded for a cut-off response, since the tokens were generated and billed", async () => {
  const { events } = await runWith({
    id: "resp_cut",
    status: "incomplete",
    incomplete_details: { reason: "max_output_tokens" },
    output: [],
    usage,
  })

  expect(events).toContainEqual({
    type: "usage_recorded",
    inputTokens: 10,
    outputTokens: 32000,
    estimatedCostUsd: (10 * 0.2 + 32000 * 1.2) / 1_000_000,
  })
})
