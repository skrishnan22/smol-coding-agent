import { expect, test } from "bun:test"
import { runTurn, type TurnEvent } from "../src/agent-loop.js"
import { createInitialModelContext } from "../src/model-context.js"
import { createOpenAIClient } from "../src/openai/client.js"
import type { ToolResult } from "../src/tool-result.js"

const sandboxTest = process.platform === "darwin" ? test : test.skip

type Call = { id: string; name: "read_file" | "bash"; args: Record<string, string> }

function call({ id, name, args }: Call) {
  return { type: "function_call", call_id: id, name, arguments: JSON.stringify(args) }
}

function toolResponse(...calls: Call[]) {
  return { id: "resp_tools", status: "completed", output: calls.map(call), usage: { input_tokens: 10, output_tokens: 5 } }
}

function textResponse(text: string) {
  return {
    id: "resp_text",
    status: "completed",
    output: [{ type: "message", content: [{ type: "output_text", text }] }],
    usage: { input_tokens: 20, output_tokens: 4 },
  }
}

function scriptedClient(responses: unknown[]) {
  const requests: { input: Record<string, unknown>[]; parallel_tool_calls: boolean }[] = []
  const client = createOpenAIClient({
    apiKey: "test-key",
    log: async () => {},
    fetch: async (_url, init) => {
      requests.push(JSON.parse(String(init?.body)))
      return new Response(JSON.stringify(responses[requests.length - 1]), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    },
  })
  return { client, requests }
}

async function run(
  client: ReturnType<typeof scriptedClient>["client"],
  extra: Partial<Parameters<typeof runTurn>[0]> = {},
) {
  const events: TurnEvent[] = []
  const result = await runTurn({
    prompt: "go",
    context: createInitialModelContext(),
    client,
    rootDir: process.cwd(),
    onEvent: (event) => events.push(event),
    ...extra,
  })
  return { events, result }
}

const tags = (events: TurnEvent[]) =>
  events
    .filter((event) => event.type.startsWith("tool_"))
    .map((event) => `${event.type}:${(event as { callId: string }).callId}`)

const outputIds = (input: Record<string, unknown>[]) =>
  input.filter((item) => item.type === "function_call_output").map((item) => item.call_id)

/** Takes `ms` and logs when it ran. */
function slow(ms: number, log: { id: string; start: number; end: number }[]) {
  return async (rawArguments: string): Promise<ToolResult> => {
    const id = JSON.parse(rawArguments).path ?? JSON.parse(rawArguments).command
    const start = performance.now()
    await Bun.sleep(ms)
    log.push({ id, start, end: performance.now() })
    return { ok: true, output: JSON.stringify({ id }), summary: `${id} · ${ms}ms` }
  }
}

test("two real read_file calls run together and both outputs go back in call order", async () => {
  const { client, requests } = scriptedClient([
    toolResponse(
      { id: "call_a", name: "read_file", args: { path: "fixtures/hello.txt" } },
      { id: "call_b", name: "read_file", args: { path: "package.json" } },
    ),
    textResponse("done"),
  ])

  const { events } = await run(client)

  expect(requests[0]?.parallel_tool_calls).toBe(true)
  // Both start before either finishes.
  expect(tags(events).slice(0, 2)).toEqual(["tool_started:call_a", "tool_started:call_b"])
  expect(outputIds(requests[1]!.input)).toEqual(["call_a", "call_b"])

  const outputs = requests[1]!.input.filter((item) => item.type === "function_call_output")
  expect(JSON.parse(String(outputs[0]!.output)).content).toBe("hello from the harness fixture\n")
  expect(JSON.parse(String(outputs[1]!.output)).path).toBe("package.json")
  expect(events.at(-1)).toEqual({ type: "assistant_finished", text: "done" })
})

test("function_calls precede their outputs in the context the model sees next", async () => {
  const { client, requests } = scriptedClient([
    toolResponse(
      { id: "call_a", name: "read_file", args: { path: "fixtures/hello.txt" } },
      { id: "call_b", name: "read_file", args: { path: "package.json" } },
    ),
    textResponse("done"),
  ])
  await run(client)

  const kinds = requests[1]!.input.map((item) => String(item.type === "message" ? item.role : item.type))
  expect(kinds).toEqual(["developer", "user", "function_call", "function_call", "function_call_output", "function_call_output"])
})

test("safe calls overlap in time, and results keep call order even when the second finishes first", async () => {
  const { client, requests } = scriptedClient([
    toolResponse(
      { id: "call_slow", name: "read_file", args: { path: "slow" } },
      { id: "call_fast", name: "read_file", args: { path: "fast" } },
    ),
    textResponse("done"),
  ])
  const log: { id: string; start: number; end: number }[] = []
  const startedAt = performance.now()

  const slowRead = slow(300, log)
  const { events } = await run(client, {
    executeReadFile: (raw) => (JSON.parse(raw).path === "fast" ? slow(30, log)(raw) : slowRead(raw)),
  })

  expect(performance.now() - startedAt).toBeLessThan(450) // together ~300ms, not ~600ms
  const slowRun = log.find((entry) => entry.id === "slow")!
  const fastRun = log.find((entry) => entry.id === "fast")!
  expect(fastRun.start).toBeLessThan(slowRun.end) // overlapped
  expect(tags(events)).toEqual([
    "tool_started:call_slow",
    "tool_started:call_fast",
    "tool_finished:call_fast", // completion order for the UI
    "tool_finished:call_slow",
  ])
  expect(outputIds(requests[1]!.input)).toEqual(["call_slow", "call_fast"]) // call order for the model
})

test("a batch containing bash runs one call at a time, in order", async () => {
  const { client, requests } = scriptedClient([
    toolResponse(
      { id: "call_1", name: "read_file", args: { path: "first" } },
      { id: "call_2", name: "bash", args: { command: "second" } },
      { id: "call_3", name: "read_file", args: { path: "third" } },
    ),
    textResponse("done"),
  ])
  const log: { id: string; start: number; end: number }[] = []

  const { events } = await run(client, {
    executeReadFile: slow(80, log),
    executeBash: slow(80, log),
  })

  expect(tags(events)).toEqual([
    "tool_started:call_1",
    "tool_finished:call_1",
    "tool_started:call_2",
    "tool_finished:call_2",
    "tool_started:call_3",
    "tool_finished:call_3",
  ])
  expect(log.map((entry) => entry.id)).toEqual(["first", "second", "third"])
  for (let i = 1; i < log.length; i += 1) expect(log[i]!.start).toBeGreaterThanOrEqual(log[i - 1]!.end)
  expect(outputIds(requests[1]!.input)).toEqual(["call_1", "call_2", "call_3"])
})

test("two bash calls in one response never overlap", async () => {
  const { client } = scriptedClient([
    toolResponse(
      { id: "call_1", name: "bash", args: { command: "one" } },
      { id: "call_2", name: "bash", args: { command: "two" } },
    ),
    textResponse("done"),
  ])
  const log: { id: string; start: number; end: number }[] = []
  await run(client, { executeBash: slow(80, log) })

  expect(log.map((entry) => entry.id)).toEqual(["one", "two"])
  expect(log[1]!.start).toBeGreaterThanOrEqual(log[0]!.end)
})

test("a failing call does not take its sibling down", async () => {
  const { client, requests } = scriptedClient([
    toolResponse(
      { id: "call_missing", name: "read_file", args: { path: "no-such-file.txt" } },
      { id: "call_ok", name: "read_file", args: { path: "fixtures/hello.txt" } },
    ),
    textResponse("done"),
  ])

  const { events } = await run(client)

  expect(events).toContainEqual({ type: "tool_failed", callId: "call_missing", error: "file not found: no-such-file.txt" })
  expect(events.some((event) => event.type === "tool_finished" && event.callId === "call_ok")).toBe(true)
  expect(outputIds(requests[1]!.input)).toEqual(["call_missing", "call_ok"])
})

test("a tool that throws becomes a failed call and its siblings still report", async () => {
  const { client, requests } = scriptedClient([
    toolResponse(
      { id: "call_boom", name: "read_file", args: { path: "boom" } },
      { id: "call_ok", name: "read_file", args: { path: "fine" } },
    ),
    textResponse("done"),
  ])
  const log: { id: string; start: number; end: number }[] = []

  const { events, result } = await run(client, {
    executeReadFile: async (raw) => {
      if (JSON.parse(raw).path === "boom") throw new Error("disk exploded")
      return slow(20, log)(raw)
    },
  })

  expect(events).toContainEqual({ type: "tool_failed", callId: "call_boom", error: "tool crashed: disk exploded" })
  expect(events.some((event) => event.type === "tool_finished" && event.callId === "call_ok")).toBe(true)
  expect(events.at(-1)).toEqual({ type: "assistant_finished", text: "done" })
  expect(outputIds(requests[1]!.input)).toEqual(["call_boom", "call_ok"])
  expect(result.context.filter((item) => (item as { type?: string }).type === "function_call_output")).toHaveLength(2)
})

test("an unknown tool name fails that call and runs the batch one by one", async () => {
  const { client } = scriptedClient([
    {
      id: "resp_tools",
      status: "completed",
      output: [
        { type: "function_call", call_id: "call_x", name: "teleport", arguments: "{}" },
        call({ id: "call_ok", name: "read_file", args: { path: "fixtures/hello.txt" } }),
      ],
      usage: { input_tokens: 10, output_tokens: 5 },
    },
    textResponse("done"),
  ])

  const { events } = await run(client)

  expect(tags(events)).toEqual([
    "tool_started:call_x",
    "tool_failed:call_x",
    "tool_started:call_ok",
    "tool_finished:call_ok",
  ])
})

sandboxTest("real read_file and real bash in one response both run, in order", async () => {
  const { client, requests } = scriptedClient([
    toolResponse(
      { id: "call_read", name: "read_file", args: { path: "fixtures/hello.txt" } },
      { id: "call_bash", name: "bash", args: { command: "cat fixtures/hello.txt | tr a-z A-Z" } },
    ),
    textResponse("done"),
  ])

  const { events } = await run(client)

  expect(tags(events)).toEqual([
    "tool_started:call_read",
    "tool_finished:call_read",
    "tool_started:call_bash",
    "tool_finished:call_bash",
  ])
  const outputs = requests[1]!.input.filter((item) => item.type === "function_call_output")
  expect(outputIds(requests[1]!.input)).toEqual(["call_read", "call_bash"])
  expect(JSON.parse(String(outputs[1]!.output)).stdout).toBe("HELLO FROM THE HARNESS FIXTURE\n")
})
