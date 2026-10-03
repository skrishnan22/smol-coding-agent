import { expect, test } from "bun:test"
import { runTurn, type TurnEvent } from "../src/agent-loop.js"
import { createInitialModelContext } from "../src/model-context.js"
import { createOpenAIClient } from "../src/openai/client.js"

const sandboxTest = process.platform === "darwin" ? test : test.skip

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } })
}

sandboxTest("a bash call runs for real and its result goes back to the model", async () => {
  const requests: { input: unknown[]; tools: { name: string }[] }[] = []
  const scripted = [
    {
      id: "resp_1",
      status: "completed",
      output: [
        {
          type: "function_call",
          call_id: "call_1",
          name: "bash",
          arguments: JSON.stringify({ command: "cat fixtures/hello.txt" }),
        },
      ],
      usage: { input_tokens: 10, output_tokens: 5 },
    },
    {
      id: "resp_2",
      status: "completed",
      output: [{ type: "message", content: [{ type: "output_text", text: "It says hello." }] }],
      usage: { input_tokens: 20, output_tokens: 4 },
    },
  ]

  const client = createOpenAIClient({
    apiKey: "test-key",
    log: async () => {},
    fetch: async (_url, init) => {
      requests.push(JSON.parse(String(init?.body)))
      return json(scripted[requests.length - 1])
    },
  })

  const events: TurnEvent[] = []
  const result = await runTurn({
    prompt: "What is in the fixture?",
    context: createInitialModelContext(),
    client,
    rootDir: process.cwd(),
    onEvent: (event) => events.push(event),
  })

  expect(requests[0]?.tools.map((tool) => tool.name)).toEqual(["read_file", "bash"])
  expect(events.map((event) => event.type)).toEqual([
    "model_started",
    "usage_recorded",
    "tool_started",
    "tool_finished",
    "model_started",
    "usage_recorded",
    "assistant_finished",
  ])

  const finished = events.find((event) => event.type === "tool_finished")
  expect(finished?.type === "tool_finished" && finished.summary).toMatch(/^exit 0 · \d+ms$/)

  const output = result.context.find((item) => (item as { type?: string }).type === "function_call_output") as {
    call_id: string
    output: string
  }
  expect(output.call_id).toBe("call_1")
  expect(JSON.parse(output.output)).toMatchObject({ exit_code: 0, stdout: "hello from the harness fixture\n" })
  expect(events.at(-1)).toEqual({ type: "assistant_finished", text: "It says hello." })
})
