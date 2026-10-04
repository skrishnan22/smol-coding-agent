import type { LogSink } from "../logging/types.js"

export const RESPONSE_STATUSES = [
  "completed",
  "failed",
  "in_progress",
  "cancelled",
  "queued",
  "incomplete",
] as const

export type ResponseStatus = (typeof RESPONSE_STATUSES)[number]

export type OpenAIFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>

export type OpenAIUsage = {
  inputTokens: number
  outputTokens: number
  estimatedCostUsd: number
}

export type OpenAIResponse = {
  id: string
  status: ResponseStatus
  /** Set when status is "incomplete", e.g. "max_output_tokens". */
  incompleteReason?: string
  text: string
  output: readonly unknown[]
  usage: OpenAIUsage
}

export type UserInputMessage = {
  type: "message"
  role: "user"
  content: string
}

export type DeveloperInputMessage = {
  type: "message"
  role: "developer"
  content: string
}

/** Context for store:false turns: local messages plus provider output items, resent as returned. */
export type ModelInputItem = UserInputMessage | DeveloperInputMessage | Record<string, unknown>

export type OpenAITool = {
  type: "function"
  name: string
  description: string
  parameters: {
    type: "object"
    properties: Record<string, unknown>
    required: string[]
    additionalProperties: false
  }
  strict: true
}

export type OpenAIRequestBody = {
  model: string
  input: readonly ModelInputItem[]
  tools: readonly OpenAITool[]
  reasoning: { effort: string }
  include: readonly string[]
  store: false
  parallel_tool_calls: true
  max_output_tokens: number
}

type OpenAIWideEventBase = {
  event: "openai.response"
  timestamp: string
  duration_ms: number
  provider: "openai"
  endpoint: "/v1/responses"
  model: string
  request_body: OpenAIRequestBody
}

export type OpenAIWideEvent =
  | (OpenAIWideEventBase & {
      outcome: "success"
      http_status: number
      response_id: string
      response_status: ResponseStatus
      usage: OpenAIUsage
      raw_response: unknown
    })
  | (OpenAIWideEventBase & {
      outcome: "error"
      http_status: number | null
      error: { name: string; message: string }
      raw_response?: unknown
    })

export type OpenAIClientOptions = {
  apiKey: string
  fetch: OpenAIFetch
  log: LogSink<OpenAIWideEvent>
}

export type OpenAIClient = {
  respond: (input: readonly ModelInputItem[]) => Promise<OpenAIResponse>
}
