import { z } from "zod"
import {
  RESPONSE_STATUSES,
  type OpenAIClient,
  type OpenAIClientOptions,
  type OpenAIRequestBody,
  type OpenAIResponse,
  type OpenAIWideEvent,
} from "./types.js"
import { BASH_TOOL, READ_FILE_TOOL } from "./tools.js"

const RESPONSES_URL = "https://api.openai.com/v1/responses"

export const OPENAI_MODEL = "gpt-5.6-luna"
/**
 * Ceiling on tokens the model may generate per response. With reasoning off, all of it is
 * available for the answer and tool arguments. OpenCode defaults to the same 32_000.
 * You only pay for what is generated; a lower cap would just cut long answers and file writes short.
 */
export const MAX_OUTPUT_TOKENS = 32_000
export const INPUT_USD_PER_MILLION_TOKENS = 0.2
export const OUTPUT_USD_PER_MILLION_TOKENS = 1.2

const responseSchema = z.object({
  id: z.string(),
  status: z.enum(RESPONSE_STATUSES),
  output: z.array(z.unknown()),
  // Present when status is "incomplete", e.g. { reason: "max_output_tokens" }.
  incomplete_details: z.object({ reason: z.string() }).nullish(),
  usage: z.object({
    input_tokens: z.number().int().nonnegative(),
    output_tokens: z.number().int().nonnegative(),
  }),
})

const messageOutputSchema = z.object({
  type: z.literal("message"),
  content: z.array(z.unknown()),
})

const outputTextSchema = z.object({
  type: z.literal("output_text"),
  text: z.string(),
})

const providerErrorSchema = z.object({
  error: z.object({ message: z.string() }),
})

export function createOpenAIClient(options: OpenAIClientOptions): OpenAIClient {
  const apiKey = options.apiKey.trim()
  if (apiKey.length === 0) throw new Error("OPENAI_API_KEY is required")

  return {
    async respond(input) {
      const timestamp = new Date().toISOString()
      const startedAt = performance.now()
      const requestBody = {
        model: OPENAI_MODEL,
        input,
        tools: [READ_FILE_TOOL, BASH_TOOL],
        reasoning: { effort: "none" },
        store: false,
        parallel_tool_calls: true,
        max_output_tokens: MAX_OUTPUT_TOKENS,
      } satisfies OpenAIRequestBody

      let httpStatus: number | null = null
      let rawResponse: unknown
      let outcome: CallOutcome

      try {
        const response = await options.fetch(RESPONSES_URL, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(requestBody),
        })

        httpStatus = response.status
        rawResponse = await readJson(response)

        if (!response.ok) {
          const message = readProviderError(rawResponse, response.statusText)
          throw new Error(`OpenAI request failed (${response.status}): ${message}`)
        }

        outcome = { ok: true, result: parseResponse(rawResponse) }
      } catch (cause) {
        outcome = { ok: false, error: toError(cause) }
      }

      const event = createWideEvent({
        timestamp,
        durationMs: Math.round(performance.now() - startedAt),
        requestBody,
        httpStatus,
        rawResponse,
        outcome,
      })
      await options.log(event)

      if (!outcome.ok) throw outcome.error
      return outcome.result
    },
  }
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json()
  } catch {
    throw new Error("Malformed OpenAI response: body is not valid JSON")
  }
}

function readProviderError(body: unknown, statusText: string): string {
  const parsed = providerErrorSchema.safeParse(body)
  return parsed.success ? parsed.data.error.message : statusText || "Unknown provider error"
}

function parseResponse(body: unknown): OpenAIResponse {
  const parsed = responseSchema.safeParse(body)
  if (!parsed.success) {
    throw new Error("Malformed OpenAI response: missing or invalid required fields")
  }

  const { id, status, output, usage, incomplete_details } = parsed.data

  return {
    id,
    status,
    ...(incomplete_details ? { incompleteReason: incomplete_details.reason } : {}),
    text: extractOutputText(output),
    output,
    usage: {
      inputTokens: usage.input_tokens,
      outputTokens: usage.output_tokens,
      estimatedCostUsd:
        (usage.input_tokens * INPUT_USD_PER_MILLION_TOKENS +
          usage.output_tokens * OUTPUT_USD_PER_MILLION_TOKENS) /
        1_000_000,
    },
  }
}

function extractOutputText(output: readonly unknown[]): string {
  const parts: string[] = []

  for (const rawItem of output) {
    const item = messageOutputSchema.safeParse(rawItem)
    if (!item.success) continue

    for (const rawContent of item.data.content) {
      const content = outputTextSchema.safeParse(rawContent)
      if (content.success) parts.push(content.data.text)
    }
  }

  return parts.join("")
}

type CallOutcome =
  | { ok: true; result: OpenAIResponse }
  | { ok: false; error: Error }

type WideEventInput = {
  timestamp: string
  durationMs: number
  requestBody: OpenAIRequestBody
  httpStatus: number | null
  rawResponse: unknown
  outcome: CallOutcome
}

function createWideEvent(input: WideEventInput): OpenAIWideEvent {
  const base = {
    event: "openai.response" as const,
    timestamp: input.timestamp,
    duration_ms: input.durationMs,
    provider: "openai" as const,
    endpoint: "/v1/responses" as const,
    model: OPENAI_MODEL,
    request_body: input.requestBody,
  }

  if (input.outcome.ok) {
    return {
      ...base,
      outcome: "success",
      http_status: input.httpStatus ?? 200,
      response_id: input.outcome.result.id,
      response_status: input.outcome.result.status,
      usage: input.outcome.result.usage,
      raw_response: input.rawResponse,
    }
  }

  return {
    ...base,
    outcome: "error",
    http_status: input.httpStatus,
    error: {
      name: input.outcome.error.name,
      message: input.outcome.error.message,
    },
    ...(input.rawResponse === undefined ? {} : { raw_response: input.rawResponse }),
  }
}

function toError(cause: unknown): Error {
  return cause instanceof Error ? cause : new Error(String(cause))
}
