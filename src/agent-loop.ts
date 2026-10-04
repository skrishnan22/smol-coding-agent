import {
  appendResponseOutput,
  appendUserMessage,
  appendUserMessages,
  createFunctionCallOutput,
} from "./model-context.js"
import { listFunctionCalls, type ParsedFunctionCall } from "./openai/tools.js"
import type { ModelInputItem, OpenAIClient, OpenAIResponse } from "./openai/types.js"
import { runBash } from "./bash.js"
import { readFile } from "./read-file.js"
import type { ToolResult } from "./tool-result.js"

export const MAX_PROVIDER_CALLS = 8

/** steering goes in before the next model call; follow_up goes in when the model would stop. */
export type QueuedKind = "steering" | "follow_up"

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
  | { type: "message_injected"; kind: QueuedKind; text: string }
  | { type: "turn_failed"; message: string }

export type RunTurnOptions = {
  prompt: string
  context: readonly ModelInputItem[]
  client: OpenAIClient
  rootDir: string
  onEvent: (event: TurnEvent) => void
  maxProviderCalls?: number
  // Each take* returns the queued messages and empties the queue.
  takeSteering?: () => string[]
  takeFollowUp?: () => string[]
  // Overridable in tests.
  executeReadFile?: (rawArguments: string, rootDir: string) => Promise<ToolResult>
  executeBash?: (rawArguments: string, rootDir: string) => Promise<ToolResult>
}

export type RunTurnResult = {
  context: ModelInputItem[]
}

type ToolExecutor = (rawArguments: string, rootDir: string) => Promise<ToolResult>

type Tool = {
  execute: ToolExecutor
  /** Can run alongside other calls. bash cannot: we can't tell which files it touches. */
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
    const result = await tool.execute(call.arguments, rootDir)
    return result
  } catch (cause) {
    // A throw must not reject Promise.all and lose the other results.
    const message = cause instanceof Error ? cause.message : String(cause)
    return failure(`tool crashed: ${message}`)
  }
}

function emitToolStarted(call: ParsedFunctionCall, onEvent: (event: TurnEvent) => void): void {
  onEvent({ type: "tool_started", callId: call.callId, name: call.name, rawArguments: call.arguments })
}

async function runCall(
  call: ParsedFunctionCall,
  tools: Record<string, Tool>,
  rootDir: string,
  onEvent: (event: TurnEvent) => void,
): Promise<ToolResult> {
  const toolResult = await executeTool(call, rootDir, tools)

  if (toolResult.ok) {
    onEvent({ type: "tool_finished", callId: call.callId, output: toolResult.output, summary: toolResult.summary })
  } else {
    onEvent({ type: "tool_failed", callId: call.callId, error: toolResult.error })
  }

  return toolResult
}

/** One result per call, in call order. Runs together only if every call is parallel-safe. */
async function runToolCalls(
  calls: ParsedFunctionCall[],
  tools: Record<string, Tool>,
  rootDir: string,
  onEvent: (event: TurnEvent) => void,
): Promise<ToolResult[]> {
  const runTogether = calls.length > 1 && calls.every((call) => tools[call.name]?.parallelSafe === true)

  if (runTogether) {
    // Promise.all keeps input order, whatever finishes first.
    for (const call of calls) emitToolStarted(call, onEvent)
    const running = calls.map((call) => runCall(call, tools, rootDir, onEvent))
    const results = await Promise.all(running)
    return results
  }

  const results: ToolResult[] = []
  for (const call of calls) {
    emitToolStarted(call, onEvent)
    const result = await runCall(call, tools, rootDir, onEvent)
    results.push(result)
  }
  return results
}

function appendToolOutputs(
  context: readonly ModelInputItem[],
  calls: readonly ParsedFunctionCall[],
  results: readonly ToolResult[],
): ModelInputItem[] {
  const outputs = calls.map((call, index) => createFunctionCallOutput(call.callId, results[index]!.output))
  return [...context, ...outputs]
}

/** Drain-all: each queued message becomes its own user message, in typed order. */
function appendQueuedMessages(
  context: readonly ModelInputItem[],
  kind: QueuedKind,
  texts: readonly string[],
  onEvent: (event: TurnEvent) => void,
): ModelInputItem[] {
  texts.forEach((text) => onEvent({ type: "message_injected", kind, text }))
  return appendUserMessages(context, texts)
}

function describeUnfinishedResponse(response: OpenAIResponse): string {
  if (response.status === "incomplete") {
    const reason = response.incompleteReason ?? "unknown reason"
    return `The response was cut off before it finished (${reason}). Ask for less in one go, or raise the output limit.`
  }
  return `The response did not complete (status: ${response.status}).`
}

/** One user turn: model, then tools, repeated until the model answers and nothing is queued. */
export async function runTurn({
  prompt,
  context: initialContext,
  client,
  rootDir,
  onEvent,
  maxProviderCalls = MAX_PROVIDER_CALLS,
  takeSteering = () => [],
  takeFollowUp = () => [],
  executeReadFile = defaultExecuteReadFile,
  executeBash = defaultExecuteBash,
}: RunTurnOptions): Promise<RunTurnResult> {
  const tools: Record<string, Tool> = {
    read_file: { execute: executeReadFile, parallelSafe: true },
    bash: { execute: executeBash, parallelSafe: false },
  }
  let context = appendUserMessage(initialContext, prompt)

  let providerCalls = 0
  while (providerCalls < maxProviderCalls) {
    providerCalls += 1
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

    // Cut-off output can hold a half-written function_call; don't run it or keep it.
    if (result.status !== "completed") {
      onEvent({ type: "turn_failed", message: describeUnfinishedResponse(result) })
      return { context }
    }

    // The provider must see its calls before their outputs.
    context = appendResponseOutput(context, result.output)

    const calls = listFunctionCalls(result.output)
    if (calls.length > 0) {
      const results = await runToolCalls(calls, tools, rootDir, onEvent)
      context = appendToolOutputs(context, calls, results)

      // Drain point: every call has its output, so a user message cannot split them.
      context = appendQueuedMessages(context, "steering", takeSteering(), onEvent)
      continue
    }

    onEvent({ type: "assistant_finished", text: result.text })

    // Drain point: the model would stop here.
    const steering = takeSteering()
    if (steering.length > 0) {
      context = appendQueuedMessages(context, "steering", steering, onEvent)
      continue
    }

    // A follow-up is new work: fresh call budget.
    const followUps = takeFollowUp()
    if (followUps.length > 0) {
      context = appendQueuedMessages(context, "follow_up", followUps, onEvent)
      providerCalls = 0
      continue
    }

    return { context }
  }

  onEvent({
    type: "turn_failed",
    message: `Exceeded ${maxProviderCalls} provider calls without final text`,
  })
  return { context }
}
