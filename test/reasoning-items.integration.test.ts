import { expect, test } from "bun:test"
import { runTurn } from "../src/agent-loop.js"
import { createInitialModelContext } from "../src/model-context.js"
import { createOpenAIClient } from "../src/openai/client.js"

type Item = Record<string, unknown>

// What a reasoning model returns with store: false and include: reasoning.encrypted_content.
const reasoning = { id: "rs_1", type: "reasoning", summary: [], encrypted_content: "gAAAA-opaque-blob" }
const readCall = { type: "function_call", call_id: "call_1", name: "read_file", arguments: '{"path":"fixtures/hello.txt"}' }

function scripted(responses: unknown[]) {
  const requests: Record<string, unknown>[] = []
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

const respond = (output: Item[]) => ({
  id: "resp",
  status: "completed",
  output,
  usage: { input_tokens: 10, output_tokens: 5 },
})

const answer = { type: "message", role: "assistant", content: [{ type: "output_text", text: "done" }] }

test("requests ask for encrypted reasoning so a stateless follow-up can replay it", async () => {
  const { client, requests } = scripted([respond([answer])])
  await runTurn({ prompt: "hi", context: createInitialModelContext(), client, rootDir: process.cwd(), onEvent: () => {} })

  expect(requests[0]).toMatchObject({
    store: false,
    reasoning: { effort: "low" },
    include: ["reasoning.encrypted_content"],
  })
})

test("a reasoning item comes back unchanged and ahead of its function_call and the call's output", async () => {
  const { client, requests } = scripted([respond([reasoning, readCall]), respond([answer])])

  await runTurn({ prompt: "read it", context: createInitialModelContext(), client, rootDir: process.cwd(), onEvent: () => {} })

  const input = requests[1]!.input as Item[]
  const shape = input.map((item) => (item.type === "message" ? String(item.role) : String(item.type)))
  expect(shape).toEqual(["developer", "user", "reasoning", "function_call", "function_call_output"])
  expect(input[2]).toEqual(reasoning) // byte-for-byte, including the encrypted blob
})

test("reasoning items from an earlier answer stay in the context for the next prompt", async () => {
  const { client, requests } = scripted([respond([reasoning, answer]), respond([answer])])

  const first = await runTurn({ prompt: "one", context: createInitialModelContext(), client, rootDir: process.cwd(), onEvent: () => {} })
  await runTurn({ prompt: "two", context: first.context, client, rootDir: process.cwd(), onEvent: () => {} })

  const input = requests[1]!.input as Item[]
  const shape = input.map((item) => (item.type === "message" ? String(item.role) : String(item.type)))
  expect(shape).toEqual(["developer", "user", "reasoning", "assistant", "user"])
  expect(input[2]).toEqual(reasoning)
})
