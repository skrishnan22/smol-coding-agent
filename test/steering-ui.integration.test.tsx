import { afterEach, expect, test } from "bun:test"
import { testRender } from "@opentui/react/test-utils"
import { act } from "react"
import { App } from "../src/app.js"
import type { ModelInputItem, OpenAIClient, OpenAIResponse } from "../src/openai/types.js"

let renderer: Awaited<ReturnType<typeof testRender>>["renderer"] | undefined

afterEach(() => {
  act(() => renderer?.destroy())
  renderer = undefined
})

/** A model call the test resolves by hand. */
function deferred() {
  let resolve!: (value: OpenAIResponse) => void
  let reject!: (reason: Error) => void
  const promise = new Promise<OpenAIResponse>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

const textResponse = (text: string): OpenAIResponse => ({
  id: "resp_text",
  status: "completed",
  text,
  output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text }] }],
  usage: { inputTokens: 10, outputTokens: 5, estimatedCostUsd: 0.00001 },
})

const readCallResponse = (): OpenAIResponse => ({
  id: "resp_call",
  status: "completed",
  text: "",
  output: [
    { type: "function_call", call_id: "call_1", name: "read_file", arguments: '{"path":"fixtures/hello.txt"}' },
  ],
  usage: { inputTokens: 10, outputTokens: 5, estimatedCostUsd: 0.00001 },
})

function setup() {
  const pending = [deferred(), deferred(), deferred()]
  const calls: ModelInputItem[][] = []
  const client: OpenAIClient = {
    respond: async (input) => {
      calls.push([...input])
      return pending[calls.length - 1]!.promise
    },
  }
  return { pending, calls, client }
}

async function open(client: OpenAIClient) {
  const screen = await testRender(<App client={client} />, { width: 80, height: 40 })
  renderer = screen.renderer
  const settle = async () => {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 60))
    })
    await screen.flush()
    await screen.renderOnce()
    await screen.renderOnce()
  }
  const type = async (text: string) => {
    await act(async () => {
      await screen.mockInput.typeText(text)
    })
    await screen.flush()
  }
  return { screen, settle, type }
}

const userTexts = (input: ModelInputItem[]) =>
  input.filter((item) => (item as { role?: string }).role === "user").map((item) => (item as { content: string }).content)

test("Enter while a turn runs queues a follow-up that the model sees once it would stop", async () => {
  const { pending, calls, client } = setup()
  const { screen, settle, type } = await open(client)

  await type("Explain the loop")
  act(() => screen.mockInput.pressEnter())
  await settle()
  expect(calls).toHaveLength(1)

  await type("then be brief")
  act(() => screen.mockInput.pressEnter())
  await settle()

  let frame = screen.captureCharFrame()
  expect(frame).toContain("QUEUED · follow-up")
  expect(frame).toContain("then be brief")
  expect(calls).toHaveLength(1) // not sent yet

  // The model finishes; the follow-up is injected.
  pending[0]!.resolve(textResponse("Here is the explanation."))
  await settle()

  expect(calls).toHaveLength(2)
  expect(userTexts(calls[1]!)).toEqual(["Explain the loop", "then be brief"])
  frame = screen.captureCharFrame()
  expect(frame).not.toContain("QUEUED")
  expect(frame).toContain("Here is the explanation.")

  pending[1]!.resolve(textResponse("Short version."))
  await settle()

  frame = screen.captureCharFrame()
  expect(frame).toContain("Short version.")
  expect(frame).toContain("then be brief") // now a normal YOU row
  expect(frame).toContain("AI harness")
  expect(frame).not.toContain("AI harness · running")
})

test("Ctrl+S queues steering that goes in right after the tool output, before the next model call", async () => {
  const { pending, calls, client } = setup()
  const { screen, settle, type } = await open(client)

  await type("Read the fixture")
  act(() => screen.mockInput.pressEnter())
  await settle()

  await type("only summarize it")
  act(() => screen.mockInput.pressKey("s", { ctrl: true }))
  await settle()

  let frame = screen.captureCharFrame()
  expect(frame).toContain("QUEUED · steering")
  expect(frame).toContain("only summarize it")

  // The model asks for a tool; steering drains after it runs.
  pending[0]!.resolve(readCallResponse())
  await settle()

  expect(calls).toHaveLength(2)
  const kinds = calls[1]!.map((item) => String((item as { type: string; role?: string }).role ?? (item as { type: string }).type))
  expect(kinds).toEqual(["developer", "user", "function_call", "function_call_output", "user"])
  expect(userTexts(calls[1]!)).toEqual(["Read the fixture", "only summarize it"])

  frame = screen.captureCharFrame()
  expect(frame).not.toContain("QUEUED")
  expect(frame).toContain("read_file")

  pending[1]!.resolve(textResponse("A summary."))
  await settle()
  expect(screen.captureCharFrame()).toContain("A summary.")
})

test("when idle, Enter and Ctrl+S both just start a turn", async () => {
  const { pending, calls, client } = setup()
  const { screen, settle, type } = await open(client)

  await type("first")
  act(() => screen.mockInput.pressKey("s", { ctrl: true }))
  await settle()

  expect(calls).toHaveLength(1)
  expect(userTexts(calls[0]!)).toEqual(["first"])
  expect(screen.captureCharFrame()).not.toContain("QUEUED")

  pending[0]!.resolve(textResponse("done"))
  await settle()
})

test("a queued message is not lost when the turn fails: it becomes the next prompt", async () => {
  const { pending, calls, client } = setup()
  const { screen, settle, type } = await open(client)

  await type("first")
  act(() => screen.mockInput.pressEnter())
  await settle()

  await type("queued one")
  act(() => screen.mockInput.pressEnter())
  await settle()
  expect(screen.captureCharFrame()).toContain("QUEUED · follow-up")

  // The call fails, so the loop never reaches a drain point.
  pending[0]!.reject(new Error("provider is down"))
  await settle()

  expect(calls).toHaveLength(2)
  expect(userTexts(calls[1]!)).toEqual(["first", "queued one"])
  const frame = screen.captureCharFrame()
  expect(frame).toContain("provider is down")
  expect(frame).not.toContain("QUEUED")

  pending[1]!.resolve(textResponse("Recovered."))
  await settle()
  expect(screen.captureCharFrame()).toContain("Recovered.")
})
