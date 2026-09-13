import { expect, test } from "bun:test"
import { READ_FILE_TOOL, listFunctionCalls } from "../src/openai/tools.js"

test("READ_FILE_TOOL is a strict single-argument function schema", () => {
  expect(READ_FILE_TOOL).toEqual({
    type: "function",
    name: "read_file",
    description: "Read a UTF-8 text file under the harness startup directory.",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Relative path from the process startup directory.",
        },
      },
      required: ["path"],
      additionalProperties: false,
    },
    strict: true,
  })
})

test("listFunctionCalls extracts call_id, name, and raw arguments", () => {
  const output = [
    { id: "rs_1", type: "reasoning", summary: [] },
    {
      type: "function_call",
      call_id: "call_abc",
      name: "read_file",
      arguments: '{"path":"package.json"}',
    },
  ]

  expect(listFunctionCalls(output)).toEqual([
    {
      callId: "call_abc",
      name: "read_file",
      arguments: '{"path":"package.json"}',
    },
  ])
})

test("listFunctionCalls returns every function_call in order", () => {
  const output = [
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
  ]

  expect(listFunctionCalls(output)).toHaveLength(2)
  expect(listFunctionCalls(output).map((call) => call.callId)).toEqual(["call_1", "call_2"])
})
