import { expect, test } from "bun:test"
import { createOpenAIClient } from "../src/openai/client.js"
import type { OpenAIFetch, OpenAIWideEvent } from "../src/openai/types.js"

const ignoreLog = async (_event: OpenAIWideEvent) => {}

test("sends one stateless Responses API request and parses its result", async () => {
  let receivedUrl = ""
  let receivedInit: RequestInit | undefined
  const events: OpenAIWideEvent[] = []
  const input = [{ type: "message" as const, role: "user" as const, content: "Say hello" }]

  const fetch: OpenAIFetch = async (url, init) => {
    receivedUrl = String(url)
    receivedInit = init

    return Response.json({
      id: "resp_123",
      status: "completed",
      output: [
        { id: "rs_1", type: "reasoning", summary: [] },
        {
          id: "msg_1",
          type: "message",
          role: "assistant",
          status: "completed",
          content: [
            { type: "output_text", text: "Hello from the model.", annotations: [] },
          ],
        },
      ],
      usage: { input_tokens: 120, output_tokens: 30, total_tokens: 150 },
    })
  }

  const client = createOpenAIClient({
    apiKey: "test-key",
    fetch,
    log: async (event) => {
      events.push(event)
    },
  })
  const result = await client.respond(input)

  expect(receivedUrl).toBe("https://api.openai.com/v1/responses")
  expect(receivedInit?.method).toBe("POST")
  expect(receivedInit?.headers).toEqual({
    Authorization: "Bearer test-key",
    "Content-Type": "application/json",
  })
  expect(JSON.parse(String(receivedInit?.body))).toEqual({
    model: "gpt-5.6-luna",
    input,
    reasoning: { effort: "none" },
    store: false,
    parallel_tool_calls: false,
    max_output_tokens: 800,
  })
  expect(result).toEqual({
    id: "resp_123",
    status: "completed",
    text: "Hello from the model.",
    output: [
      { id: "rs_1", type: "reasoning", summary: [] },
      {
        id: "msg_1",
        type: "message",
        role: "assistant",
        status: "completed",
        content: [
          { type: "output_text", text: "Hello from the model.", annotations: [] },
        ],
      },
    ],
    usage: { inputTokens: 120, outputTokens: 30, estimatedCostUsd: 0.00006 },
  })
  expect(events).toHaveLength(1)
  expect(events[0]).toMatchObject({
    event: "openai.response",
    provider: "openai",
    endpoint: "/v1/responses",
    model: "gpt-5.6-luna",
    outcome: "success",
    http_status: 200,
    response_id: "resp_123",
    response_status: "completed",
    request_body: {
      model: "gpt-5.6-luna",
      input,
        reasoning: { effort: "none" },
      store: false,
      parallel_tool_calls: false,
      max_output_tokens: 800,
    },
    usage: { inputTokens: 120, outputTokens: 30, estimatedCostUsd: 0.00006 },
    raw_response: {
      id: "resp_123",
      status: "completed",
    },
  })
  expect(events[0]?.timestamp).toEqual(expect.any(String))
  expect(events[0]?.duration_ms).toEqual(expect.any(Number))
  expect(JSON.stringify(events[0])).not.toContain("test-key")
})

test("reports the provider error message for a failed HTTP response", async () => {
  const events: OpenAIWideEvent[] = []
  const fetch: OpenAIFetch = async () =>
    Response.json({ error: { message: "Invalid API key" } }, { status: 401 })
  const client = createOpenAIClient({
    apiKey: "bad-key",
    fetch,
    log: async (event) => {
      events.push(event)
    },
  })

  await expect(client.respond([{ type: "message", role: "user", content: "hello" }])).rejects.toThrow(
    "OpenAI request failed (401): Invalid API key",
  )
  expect(events).toHaveLength(1)
  expect(events[0]).toMatchObject({
    event: "openai.response",
    outcome: "error",
    http_status: 401,
    error: { name: "Error", message: "OpenAI request failed (401): Invalid API key" },
    raw_response: { error: { message: "Invalid API key" } },
  })
})

test("rejects a successful HTTP response with a malformed body", async () => {
  const fetch: OpenAIFetch = async () => Response.json({ id: "resp_123", output: [] })
  const client = createOpenAIClient({ apiKey: "test-key", fetch, log: ignoreLog })

  expect(client.respond([{ type: "message", role: "user", content: "hello" }])).rejects.toThrow("Malformed OpenAI response")
})

test("rejects a blank API key before making a request", () => {
  const fetch: OpenAIFetch = async () => {
    throw new Error("fetch should not run")
  }

  expect(() => createOpenAIClient({ apiKey: "  ", fetch, log: ignoreLog })).toThrow("OPENAI_API_KEY is required")
})
