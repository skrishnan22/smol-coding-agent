import { expect, test } from "bun:test"
import { runTurn, type TurnEvent } from "../src/agent-loop.js"
import { createUserMessage } from "../src/model-context.js"
import type { ModelInputItem, OpenAIClient, OpenAIResponse } from "../src/openai/types.js"
import type { ReadFileResult } from "../src/read-file.js"

function scriptedClient(responses: OpenAIResponse[]): OpenAIClient {
  let index = 0
  return {
    respond: async (input) => {
      const next = responses[index]
      index += 1
      if (next === undefined) {
        throw new Error(`unexpected respond call #${index} with ${input.length} input items`)
      }
      return next
    },
  }
}

test("runTurn executes one function_call, correlates call_id, and continues to final text", async () => {
  const functionCall = {
    type: "function_call",
    call_id: "call_1",
    name: "read_file",
    arguments: '{"path":"package.json"}',
  }
  const client = scriptedClient([
    {
      id: "resp_1",
      status: "completed",
      text: "",
      output: [functionCall],
      usage: { inputTokens: 10, outputTokens: 5, estimatedCostUsd: 0.00001 },
    },
    {
      id: "resp_2",
      status: "completed",
      text: "package.json has the project name.",
      output: [
        {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "package.json has the project name." }],
        },
      ],
      usage: { inputTokens: 40, outputTokens: 12, estimatedCostUsd: 0.00002 },
    },
  ])

  const events: TurnEvent[] = []
  const toolOutputs: string[] = []
  let secondInput: ModelInputItem[] | undefined

  const originalRespond = client.respond
  client.respond = async (input) => {
    if (secondInput === undefined && input.some((item) => (item as { type?: string }).type === "function_call_output")) {
      secondInput = [...input]
    }
    return originalRespond(input)
  }

  const result = await runTurn({
    prompt: "Read package.json",
    context: [],
    client,
    rootDir: process.cwd(),
    onEvent: (event) => events.push(event),
    executeReadFile: async (rawArguments) => {
      toolOutputs.push(rawArguments)
      const success: ReadFileResult = {
        ok: true,
        path: "package.json",
        bytes: 12,
        output: JSON.stringify({ path: "package.json", bytes: 12, content: '{"name":"x"}' }),
      }
      return success
    },
  })

  expect(toolOutputs).toEqual(['{"path":"package.json"}'])
  expect(secondInput).toEqual([
    createUserMessage("Read package.json"),
    functionCall,
    {
      type: "function_call_output",
      call_id: "call_1",
      output: JSON.stringify({ path: "package.json", bytes: 12, content: '{"name":"x"}' }),
    },
  ])
  expect(result.context).toEqual([
    ...(secondInput ?? []),
    {
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: "package.json has the project name." }],
    },
  ])
  expect(events.map((event) => event.type)).toEqual([
    "model_started",
    "usage_recorded",
    "tool_started",
    "tool_finished",
    "model_started",
    "usage_recorded",
    "assistant_finished",
  ])
  expect(events).toContainEqual({
    type: "tool_started",
    callId: "call_1",
    name: "read_file",
    rawArguments: '{"path":"package.json"}',
  })
  expect(events).toContainEqual({
    type: "assistant_finished",
    text: "package.json has the project name.",
  })
})

test("runTurn returns a tool error to the model and continues after tool_failed", async () => {
  const functionCall = {
    type: "function_call",
    call_id: "call_err",
    name: "read_file",
    arguments: '{"path":"missing.txt"}',
  }
  const client = scriptedClient([
    {
      id: "resp_1",
      status: "completed",
      text: "",
      output: [functionCall],
      usage: { inputTokens: 8, outputTokens: 4, estimatedCostUsd: 0.000008 },
    },
    {
      id: "resp_2",
      status: "completed",
      text: "That file is missing.",
      output: [
        {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "That file is missing." }],
        },
      ],
      usage: { inputTokens: 20, outputTokens: 6, estimatedCostUsd: 0.00001 },
    },
  ])

  const events: TurnEvent[] = []
  await runTurn({
    prompt: "Read missing.txt",
    context: [],
    client,
    rootDir: process.cwd(),
    onEvent: (event) => events.push(event),
    executeReadFile: async () => ({
      ok: false,
      error: "file not found: missing.txt",
      output: JSON.stringify({ error: "file not found: missing.txt" }),
    }),
  })

  expect(events.map((event) => event.type)).toEqual([
    "model_started",
    "usage_recorded",
    "tool_started",
    "tool_failed",
    "model_started",
    "usage_recorded",
    "assistant_finished",
  ])
  expect(events).toContainEqual({
    type: "tool_failed",
    callId: "call_err",
    error: "file not found: missing.txt",
  })
})

test("runTurn fails visibly on multiple function_calls without appending them", async () => {
  const client = scriptedClient([
    {
      id: "resp_1",
      status: "completed",
      text: "",
      output: [
        {
          type: "function_call",
          call_id: "call_1",
          name: "read_file",
          arguments: '{"path":"a.txt"}',
        },
        {
          type: "function_call",
          call_id: "call_2",
          name: "read_file",
          arguments: '{"path":"b.txt"}',
        },
      ],
      usage: { inputTokens: 9, outputTokens: 6, estimatedCostUsd: 0.000009 },
    },
  ])

  const events: TurnEvent[] = []
  const result = await runTurn({
    prompt: "Read two files",
    context: [],
    client,
    rootDir: process.cwd(),
    onEvent: (event) => events.push(event),
  })

  expect(result.context).toEqual([createUserMessage("Read two files")])
  expect(events.map((event) => event.type)).toEqual(["model_started", "usage_recorded", "turn_failed"])
  expect(events.at(-1)).toEqual({
    type: "turn_failed",
    message: "Unsupported response: 2 function calls in one turn",
  })
})


test("runTurn stops after the provider-call limit", async () => {
  const functionCall = {
    type: "function_call",
    call_id: "call_loop",
    name: "read_file",
    arguments: '{"path":"package.json"}',
  }

  let calls = 0
  const client: OpenAIClient = {
    respond: async () => {
      calls += 1
      return {
        id: `resp_${calls}`,
        status: "completed",
        text: "",
        output: [{ ...functionCall, call_id: `call_${calls}` }],
        usage: { inputTokens: 1, outputTokens: 1, estimatedCostUsd: 0.000001 },
      }
    },
  }

  const events: TurnEvent[] = []
  await runTurn({
    prompt: "keep reading",
    context: [],
    client,
    rootDir: process.cwd(),
    maxProviderCalls: 3,
    onEvent: (event) => events.push(event),
    executeReadFile: async () => ({
      ok: true,
      path: "package.json",
      bytes: 1,
      output: '{"path":"package.json","bytes":1,"content":"{}"}',
    }),
  })

  expect(calls).toBe(3)
  expect(events.at(-1)).toEqual({
    type: "turn_failed",
    message: "Exceeded 3 provider calls without final text",
  })
})
