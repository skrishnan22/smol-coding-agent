import { expect, test } from "bun:test"
import { runTurn, type TurnEvent } from "../src/agent-loop.js"
import { createInitialModelContext } from "../src/model-context.js"
import { createOpenAIClient } from "../src/openai/client.js"

type Item = Record<string, unknown>

const readCall = (id: string, path: string) => ({
  type: "function_call",
  call_id: id,
  name: "read_file",
  arguments: JSON.stringify({ path }),
})

const toolResponse = (...calls: Item[]) => ({
  id: "resp_tools",
  status: "completed",
  output: calls,
  usage: { input_tokens: 10, output_tokens: 5 },
})

const textResponse = (text: string) => ({
  id: "resp_text",
  status: "completed",
  output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text }] }],
  usage: { input_tokens: 20, output_tokens: 4 },
})

/** Real client over a scripted network. `typing(n)` runs while request n is in flight. */
function setup(responses: unknown[], typing: (request: number) => void = () => {}) {
  const requests: { input: Item[] }[] = []
  const client = createOpenAIClient({
    apiKey: "test-key",
    log: async () => {},
    fetch: async (_url, init) => {
      requests.push(JSON.parse(String(init?.body)))
      typing(requests.length)
      return new Response(JSON.stringify(responses[requests.length - 1]), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    },
  })

  const queues = { steering: [] as string[], follow_up: [] as string[] }
  const events: TurnEvent[] = []
  const run = (maxProviderCalls?: number) =>
    runTurn({
      prompt: "go",
      context: createInitialModelContext(),
      client,
      rootDir: process.cwd(),
      onEvent: (event) => events.push(event),
      takeSteering: () => queues.steering.splice(0),
      takeFollowUp: () => queues.follow_up.splice(0),
      ...(maxProviderCalls === undefined ? {} : { maxProviderCalls }),
    })

  return { requests, queues, events, run }
}

/** Roles for messages, types for everything else. */
const shape = (input: Item[]) => input.map((item) => (item.type === "message" ? `${item.role}` : `${item.type}`))
const userTexts = (input: Item[]) => input.filter((item) => item.role === "user").map((item) => item.content)
const types = (events: TurnEvent[]) => events.map((event) => event.type)

test("steering typed during a model call is injected after the tool outputs, before the next call", async () => {
  const t = setup(
    [toolResponse(readCall("call_a", "fixtures/hello.txt"), readCall("call_b", "package.json")), textResponse("ok")],
    (n) => {
      if (n === 1) t.queues.steering.push("actually, only the second file")
    },
  )

  await t.run()

  // Every call has its output before the user message.
  expect(shape(t.requests[1]!.input)).toEqual([
    "developer",
    "user",
    "function_call",
    "function_call",
    "function_call_output",
    "function_call_output",
    "user",
  ])
  expect(userTexts(t.requests[1]!.input)).toEqual(["go", "actually, only the second file"])
  expect(types(t.events)).toEqual([
    "model_started",
    "usage_recorded",
    "tool_started",
    "tool_started",
    "tool_finished",
    "tool_finished",
    "message_injected",
    "model_started",
    "usage_recorded",
    "assistant_finished",
  ])
  expect(t.events).toContainEqual({ type: "message_injected", kind: "steering", text: "actually, only the second file" })
})

test("a follow-up waits until the model would stop, then starts another round", async () => {
  const t = setup([toolResponse(readCall("call_a", "fixtures/hello.txt")), textResponse("first answer"), textResponse("second answer")], (n) => {
    if (n === 1) t.queues.follow_up.push("then summarize")
  })

  const { context } = await t.run()

  // Not injected after the tool round...
  expect(userTexts(t.requests[1]!.input)).toEqual(["go"])
  // ...but is in the third request, right after the answer.
  expect(shape(t.requests[2]!.input).slice(-2)).toEqual(["assistant", "user"])
  expect(userTexts(t.requests[2]!.input)).toEqual(["go", "then summarize"])

  const finished = t.events.filter((event) => event.type === "assistant_finished")
  expect(finished).toEqual([
    { type: "assistant_finished", text: "first answer" },
    { type: "assistant_finished", text: "second answer" },
  ])
  const order = types(t.events)
  expect(order.indexOf("message_injected")).toBeGreaterThan(order.indexOf("assistant_finished"))
  expect(context.at(-1)).toMatchObject({ role: "assistant" })
})

test("drain-all: three queued follow-ups become three user messages in one request, in typed order", async () => {
  const t = setup([textResponse("one"), textResponse("two")], (n) => {
    if (n === 1) t.queues.follow_up.push("A", "B", "C")
  })

  await t.run()

  expect(t.requests).toHaveLength(2) // one call for the whole batch
  expect(shape(t.requests[1]!.input).slice(-4)).toEqual(["assistant", "user", "user", "user"])
  expect(userTexts(t.requests[1]!.input)).toEqual(["go", "A", "B", "C"])
})

test("at the stop point, steering is injected first and the follow-up waits for the next stop", async () => {
  const t = setup([textResponse("one"), textResponse("two"), textResponse("three")], (n) => {
    if (n === 1) {
      t.queues.follow_up.push("later")
      t.queues.steering.push("now")
    }
  })

  await t.run()

  expect(userTexts(t.requests[1]!.input)).toEqual(["go", "now"])
  expect(userTexts(t.requests[2]!.input)).toEqual(["go", "now", "later"])
})

test("a follow-up starts new work, so it gets a fresh provider-call budget", async () => {
  // Budget of 2 is used up by the tool round; without the reset the follow-up could not run.
  const t = setup([toolResponse(readCall("call_a", "fixtures/hello.txt")), textResponse("one"), textResponse("two")], (n) => {
    if (n === 1) t.queues.follow_up.push("more")
  })

  await t.run(2)

  expect(t.requests).toHaveLength(3)
  expect(t.events.some((event) => event.type === "turn_failed")).toBe(false)
  expect(t.events.at(-1)).toEqual({ type: "assistant_finished", text: "two" })
})

test("nothing queued behaves exactly as before", async () => {
  const t = setup([toolResponse(readCall("call_a", "fixtures/hello.txt")), textResponse("done")])

  await t.run()

  expect(types(t.events)).toEqual([
    "model_started",
    "usage_recorded",
    "tool_started",
    "tool_finished",
    "model_started",
    "usage_recorded",
    "assistant_finished",
  ])
})
