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

type Tool = {
  execute: ToolExecutor
  /**
   * Whether calls to this tool may run alongside other calls. read_file only reads, so it can.
   * bash can touch anything, and nothing tells us which files, so it cannot.
   */
  parallelSafe: boolean
}

const defaultExecuteReadFile: ToolExecutor = (rawArguments, rootDir) => readFile(rawArguments, { rootDir })
const defaultExecuteBash: ToolExecutor = (rawArguments, rootDir) => runBash(rawArguments, { rootDir })

function failure(error: string): ToolResult {
  return { ok: false, error, output: JSON.stringify({ error }) }
}

async function executeTool(
  call: ParsedFunctionCall,
  rootDir: string,
  tools: Record<string, Tool>,
): Promise<ToolResult> {
  const tool = tools[call.name]
  if (tool === undefined) return failure(`unknown tool: ${call.name}`)

  try {
    return await tool.execute(call.arguments, rootDir)
  } catch (cause) {
    // One crashing tool must not reject Promise.all and lose its siblings' results.
    return failure(`tool crashed: ${cause instanceof Error ? cause.message : String(cause)}`)
  }
}

/**
 * One user turn: call the model, run any tool calls it asks for, continue until final text.
 * Emits ordered events for the UI; returns the updated model context.
 *
 * When a response holds several calls, they run together only if every call is to a
 * parallel-safe tool. Otherwise the whole batch runs one by one, in order. Either way the
 * outputs go back to the model in call order, not completion order.
 */
export async function runTurn({
  prompt,
  context: initialContext,
  client,
  rootDir,
  onEvent,
  maxProviderCalls = MAX_PROVIDER_CALLS,
  executeReadFile = defaultExecuteReadFile,
  executeBash = defaultExecuteBash,
}: RunTurnOptions): Promise<RunTurnResult> {
  const tools: Record<string, Tool> = {
    read_file: { execute: executeReadFile, parallelSafe: true },
    bash: { execute: executeBash, parallelSafe: false },
  }
  let context = appendUserMessage(initialContext, prompt)

  const emitStarted = (call: ParsedFunctionCall) =>
    onEvent({ type: "tool_started", callId: call.callId, name: call.name, rawArguments: call.arguments })

  /** Run one call and report how it ended as soon as it does. */
  const runCall = async (call: ParsedFunctionCall): Promise<ToolResult> => {
    const toolResult = await executeTool(call, rootDir, tools)
    if (toolResult.ok) {
      onEvent({ type: "tool_finished", callId: call.callId, output: toolResult.output, summary: toolResult.summary })
    } else {
      onEvent({ type: "tool_failed", callId: call.callId, error: toolResult.error })
    }
    return toolResult
  }

  for (let providerCalls = 0; providerCalls < maxProviderCalls; providerCalls += 1) {
    onEvent({ type: "model_started" })

    let result
    try {
      result = await client.respond(context)
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause)
      onEvent({ type: "turn_failed", message })
      return { context }
    }

    onEvent({
      type: "usage_recorded",
      inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens,
      estimatedCostUsd: result.usage.estimatedCostUsd,
    })

    // The provider needs to see its own calls before it sees their outputs.
    context = appendResponseOutput(context, result.output)

    const calls = listFunctionCalls(result.output)
    if (calls.length > 0) {
      const runTogether = calls.length > 1 && calls.every((call) => tools[call.name]?.parallelSafe === true)

      let results: ToolResult[]
      if (runTogether) {
        // Every card shows as running at once; Promise.all keeps results in call order.
        calls.forEach(emitStarted)
        results = await Promise.all(calls.map(runCall))
      } else {
        // A card only shows as running when its turn comes.
        results = []
        for (const call of calls) {
          emitStarted(call)
          results.push(await runCall(call))
        }
      }

      calls.forEach((call, index) => {
        context = appendFunctionCallOutput(context, call.callId, results[index]!.output)
      })
      continue
    }

    onEvent({ type: "assistant_finished", text: result.text })
    return { context }
  }

  onEvent({
    type: "turn_failed",
    message: `Exceeded ${maxProviderCalls} provider calls without final text`,
  })
  return { context }
}
