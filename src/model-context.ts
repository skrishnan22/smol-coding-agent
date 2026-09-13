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
