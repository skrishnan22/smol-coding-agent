import {
  appendFunctionCallOutput,
  appendResponseOutput,
  appendUserMessage,
} from "./model-context.js"
import { listFunctionCalls, type ParsedFunctionCall } from "./openai/tools.js"
import type { ModelInputItem, OpenAIClient } from "./openai/types.js"
import { runBash } from "./bash.js"
import { readFile } from "./read-file.js"
import type { ToolResult } from "./tool-result.js"

export const MAX_PROVIDER_CALLS = 8

export type TurnEvent =
  | { type: "model_started" }
  | {
      type: "usage_recorded"
      inputTokens: number
      outputTokens: number
      estimatedCostUsd: number
    }
  | { type: "tool_started"; callId: string; name: string; rawArguments: string }
  | { type: "tool_finished"; callId: string; output: string; summary: string }
  | { type: "tool_failed"; callId: string; error: string }
  | { type: "assistant_finished"; text: string }
  | { type: "turn_failed"; message: string }

export type RunTurnOptions = {
  prompt: string
  context: readonly ModelInputItem[]
  client: OpenAIClient
  rootDir: string
  onEvent: (event: TurnEvent) => void
  maxProviderCalls?: number
  /** Injectable for tests; defaults to the local read_file tool. */
  executeReadFile?: (rawArguments: string, rootDir: string) => Promise<ToolResult>
  /** Injectable for tests; defaults to the sandboxed bash tool. */
  executeBash?: (rawArguments: string, rootDir: string) => Promise<ToolResult>
}

export type RunTurnResult = {
  context: ModelInputItem[]
}

type ToolExecutor = (rawArguments: string, rootDir: string) => Promise<ToolResult>

const defaultExecuteReadFile: ToolExecutor = (rawArguments, rootDir) => readFile(rawArguments, { rootDir })
const defaultExecuteBash: ToolExecutor = (rawArguments, rootDir) => runBash(rawArguments, { rootDir })

async function executeTool(
  call: ParsedFunctionCall,
  rootDir: string,
  executors: Record<string, ToolExecutor>,
): Promise<ToolResult> {
  const execute = executors[call.name]
  if (execute === undefined) {
    const error = `unknown tool: ${call.name}`
    return { ok: false, error, output: JSON.stringify({ error }) }
  }
  return execute(call.arguments, rootDir)
}

/**
 * One user turn: call the model, optionally run one tool, continue until final text.
 * Emits ordered events for the UI; returns the updated model context.
 */
export async function runTurn(options: RunTurnOptions): Promise<RunTurnResult> {
  const maxProviderCalls = options.maxProviderCalls ?? MAX_PROVIDER_CALLS
  const executors: Record<string, ToolExecutor> = {
    read_file: options.executeReadFile ?? defaultExecuteReadFile,
    bash: options.executeBash ?? defaultExecuteBash,
  }
  let context = appendUserMessage(options.context, options.prompt)

  for (let providerCalls = 0; providerCalls < maxProviderCalls; providerCalls += 1) {
    options.onEvent({ type: "model_started" })

    let result
    try {
      result = await options.client.respond(context)
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause)
      options.onEvent({ type: "turn_failed", message })
      return { context }
    }

    options.onEvent({
      type: "usage_recorded",
      inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens,
      estimatedCostUsd: result.usage.estimatedCostUsd,
    })

    const calls = listFunctionCalls(result.output)
    if (calls.length > 1) {
      options.onEvent({
        type: "turn_failed",
        message: `Unsupported response: ${calls.length} function calls in one turn`,
      })
      return { context }
    }

    context = appendResponseOutput(context, result.output)

    if (calls.length === 1) {
      const call = calls[0]!
      options.onEvent({
        type: "tool_started",
        callId: call.callId,
        name: call.name,
        rawArguments: call.arguments,
      })

      const toolResult = await executeTool(call, options.rootDir, executors)
      context = appendFunctionCallOutput(context, call.callId, toolResult.output)

      if (toolResult.ok) {
        options.onEvent({
          type: "tool_finished",
          callId: call.callId,
          output: toolResult.output,
          summary: toolResult.summary,
        })
      } else {
        options.onEvent({
          type: "tool_failed",
          callId: call.callId,
          error: toolResult.error,
        })
      }

      continue
    }

    options.onEvent({ type: "assistant_finished", text: result.text })
    return { context }
  }

  options.onEvent({
    type: "turn_failed",
    message: `Exceeded ${maxProviderCalls} provider calls without final text`,
  })
  return { context }
}
