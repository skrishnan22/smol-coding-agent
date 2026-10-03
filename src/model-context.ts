import type { DeveloperInputMessage, ModelInputItem, UserInputMessage } from "./openai/types.js"

export const DEVELOPER_GUIDANCE = [
  "You are the model inside a minimal learning harness.",
  "You have two tools: read_file reads one UTF-8 text file under the process startup directory (exactly { \"path\": string }, relative),",
  "and bash runs one command in a fresh sandboxed shell (exactly { \"command\": string }).",
  "Every call is stateless. Use a tool when you need to inspect or change files; answer directly when you do not.",
].join(" ")

export function createDeveloperMessage(content: string = DEVELOPER_GUIDANCE): DeveloperInputMessage {
  return { type: "message", role: "developer", content }
}

export function createInitialModelContext(): ModelInputItem[] {
  return [createDeveloperMessage()]
}

export function createUserMessage(content: string): UserInputMessage {
  return { type: "message", role: "user", content }
}

export function appendUserMessage(
  context: readonly ModelInputItem[],
  content: string,
): ModelInputItem[] {
  return [...context, createUserMessage(content)]
}

export function appendResponseOutput(
  context: readonly ModelInputItem[],
  output: readonly unknown[],
): ModelInputItem[] {
  return [...context, ...(output as ModelInputItem[])]
}

export type FunctionCallOutputItem = {
  type: "function_call_output"
  call_id: string
  output: string
}

/** Build the Responses item that correlates a tool result to a prior function_call. */
export function createFunctionCallOutput(callId: string, output: string): FunctionCallOutputItem {
  return {
    type: "function_call_output",
    call_id: callId,
    output,
  }
}

export function appendFunctionCallOutput(
  context: readonly ModelInputItem[],
  callId: string,
  output: string,
): ModelInputItem[] {
  return [...context, createFunctionCallOutput(callId, output)]
}
