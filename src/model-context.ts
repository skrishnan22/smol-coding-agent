import type { ModelInputItem, UserInputMessage } from "./openai/types.js"

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

