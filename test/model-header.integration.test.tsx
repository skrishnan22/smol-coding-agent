import { afterEach, expect, test } from "bun:test"
import { testRender } from "@opentui/react/test-utils"
import { act } from "react"
import { App } from "../src/app.js"
import type { OpenAIClient, OpenAIResponse } from "../src/openai/types.js"

let renderer: Awaited<ReturnType<typeof testRender>>["renderer"] | undefined

afterEach(() => {
  act(() => renderer?.destroy())
  renderer = undefined
})

const model = { name: "gpt-5.6-luna", effort: "none" }

test("the header shows the model and reasoning effort, and 'running' while a turn is in flight", async () => {
  let release!: (value: OpenAIResponse) => void
  const client: OpenAIClient = { respond: () => new Promise<OpenAIResponse>((resolve) => (release = resolve)) }

  const screen = await testRender(<App client={client} model={model} />, { width: 80, height: 20 })
  renderer = screen.renderer
  await screen.renderOnce()
  expect(screen.captureCharFrame()).toContain("AI harness · gpt-5.6-luna · effort none")
  expect(screen.captureCharFrame()).not.toContain("running")

  await act(async () => {
    await screen.mockInput.typeText("hello")
  })
  await screen.flush()
  act(() => screen.mockInput.pressEnter())
  await screen.flush()
  await screen.renderOnce()
  expect(screen.captureCharFrame()).toContain("AI harness · gpt-5.6-luna · effort none · running")

  release({
    id: "r",
    status: "completed",
    text: "hi",
    output: [{ type: "message", content: [{ type: "output_text", text: "hi" }] }],
    usage: { inputTokens: 1, outputTokens: 1, estimatedCostUsd: 0 },
  })
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 50))
  })
  await screen.flush()
  await screen.renderOnce()
  expect(screen.captureCharFrame()).toContain("AI harness · gpt-5.6-luna · effort none")
  expect(screen.captureCharFrame()).not.toContain("running")
})

test("without model info the header is unchanged", async () => {
  const client: OpenAIClient = { respond: async () => { throw new Error("not called") } }
  const screen = await testRender(<App client={client} />, { width: 80, height: 20 })
  renderer = screen.renderer
  await screen.renderOnce()
  const frame = screen.captureCharFrame()
  expect(frame).toContain("AI harness")
  expect(frame).not.toContain("effort")
})
