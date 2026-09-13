import { z } from "zod"
import type { OpenAITool } from "./types.js"

/** Strict Responses API tool schema for the one local file reader. */
export const READ_FILE_TOOL = {
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
} satisfies OpenAITool

const functionCallSchema = z.object({
  type: z.literal("function_call"),
  call_id: z.string().min(1),
  name: z.string().min(1),
  arguments: z.string(),
})

export type ParsedFunctionCall = {
  callId: string
  name: string
  /** Raw JSON arguments string from the provider. */
  arguments: string
}

/** Collect function_call items from a Responses `output` array. */
export function listFunctionCalls(output: readonly unknown[]): ParsedFunctionCall[] {
  const calls: ParsedFunctionCall[] = []

  for (const item of output) {
    const parsed = functionCallSchema.safeParse(item)
    if (!parsed.success) continue
    calls.push({
      callId: parsed.data.call_id,
      name: parsed.data.name,
      arguments: parsed.data.arguments,
    })
  }

  return calls
}
