import { z } from "zod"
import type { OpenAITool } from "./types.js"

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

// Same shape as read_file; the description is what teaches the model the sandbox rules.
export const BASH_TOOL = {
  type: "function",
  name: "bash",
  description:
    "Run one shell command with /bin/bash -c inside a sandbox. " +
    "Each call is a fresh shell: cd and env vars do not persist, so chain with && when needed. " +
    "The working directory is the project root. " +
    "Files can be read broadly (except credential paths) but written only under the project and temp dir. " +
    "There is no network access. Commands time out after 30s and output is truncated at 16 KiB.",
  parameters: {
    type: "object",
    properties: {
      command: {
        type: "string",
        description: 'The shell command to run, e.g. "ls -la src && cat package.json".',
      },
    },
    required: ["command"],
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
  arguments: string
}

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
