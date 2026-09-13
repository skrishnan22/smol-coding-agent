import { afterEach, expect, test } from "bun:test"
import { testRender } from "@opentui/react/test-utils"
import { act } from "react"
import { App, HarnessView, type TranscriptItem } from "../src/app.js"
import { createUserMessage } from "../src/model-context.js"
import type { ModelInputItem, OpenAIClient, OpenAIResponse } from "../src/openai/types.js"

let renderer: Awaited<ReturnType<typeof testRender>>["renderer"] | undefined

afterEach(() => {
  act(() => renderer?.destroy())
  renderer = undefined
})

const idleClient: OpenAIClient = {
  respond: async () => {
    throw new Error("idleClient.respond should not be called")
  },
}

function deferredResponse() {
  let resolve!: (value: OpenAIResponse) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<OpenAIResponse>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}




test("renders the empty harness shell", async () => {
  const screen = await testRender(<App client={idleClient} />, { width: 80, height: 20 })
  renderer = screen.renderer

  await screen.renderOnce()
  const frame = screen.captureCharFrame()

  expect(frame).toContain("AI harness")
  expect(frame).toContain("Ask the harness")
  expect(frame).toContain("input 0 · output 0 · $0.000000")
})

test("submitting a prompt calls OpenAI once and shows the assistant reply", async () => {
  const pending = deferredResponse()
  const calls: ModelInputItem[][] = []

  const client: OpenAIClient = {
    respond: async (input) => {
      calls.push([...input])
      return pending.promise
    },
  }

  const screen = await testRender(<App client={client} />, { width: 80, height: 24 })
  renderer = screen.renderer

  await act(async () => {
    await screen.mockInput.typeText("Explain the loop")
  })
  await screen.flush()

  act(() => {
    screen.mockInput.pressEnter()
  })
  await screen.flush()

  let frame = screen.captureCharFrame()
  expect(frame).toContain("YOU")
  expect(frame).toContain("Explain the loop")
  expect(frame).toContain("AI harness · running")
  expect(frame).toContain("Waiting for the agent")
  expect(calls).toEqual([[createUserMessage("Explain the loop")]])

  const firstOutput = [
    {
      id: "msg_1",
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: "Here is the explanation." }],
    },
  ]

  await act(async () => {
    pending.resolve({
      id: "resp_1",
      status: "completed",
      text: "Here is the explanation.",
      output: firstOutput,
      usage: { inputTokens: 10, outputTokens: 5, estimatedCostUsd: 0.000008 },
    })
    await pending.promise
  })
  await screen.flush()

  frame = screen.captureCharFrame()
  expect(frame).toContain("ASSISTANT")
  expect(frame).toContain("Here is the explanation.")
  expect(frame).toContain("input 10 · output 5 · $0.000008")
  expect(frame).toContain("Ask the harness")
  expect(frame).not.toContain("AI harness · running")
  expect(calls).toHaveLength(1)
})

test("a second prompt resends the accumulated model context", async () => {
  const firstOutput = [
    {
      id: "msg_1",
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: "Your name is Ada." }],
    },
  ]
  const secondOutput = [
    {
      id: "msg_2",
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: "Ada" }],
    },
  ]

  const responses = [
    {
      id: "resp_1",
      status: "completed",
      text: "Your name is Ada.",
      output: firstOutput,
      usage: { inputTokens: 8, outputTokens: 4, estimatedCostUsd: 0.000006 },
    },
    {
      id: "resp_2",
      status: "completed",
      text: "Ada",
      output: secondOutput,
      usage: { inputTokens: 20, outputTokens: 2, estimatedCostUsd: 0.000006 },
    },
  ] satisfies OpenAIResponse[]

  const calls: ModelInputItem[][] = []
  const client: OpenAIClient = {
    respond: async (input) => {
      calls.push([...input])
      const next = responses[calls.length - 1]
      if (next === undefined) throw new Error("unexpected extra respond call")
      return next
    },
  }

  const screen = await testRender(<App client={client} />, { width: 80, height: 28 })
  renderer = screen.renderer

  await act(async () => {
    await screen.mockInput.typeText("My name is Ada")
  })
  await screen.flush()
  await act(async () => {
    screen.mockInput.pressEnter()
    await Promise.resolve()
  })
  await screen.flush()

  expect(calls[0]).toEqual([createUserMessage("My name is Ada")])

  await act(async () => {
    await screen.mockInput.typeText("What is my name?")
  })
  await screen.flush()
  await act(async () => {
    screen.mockInput.pressEnter()
    await Promise.resolve()
  })
  await screen.flush()

  expect(calls).toHaveLength(2)
  expect(calls[1]).toEqual([
    createUserMessage("My name is Ada"),
    ...firstOutput,
    createUserMessage("What is my name?"),
  ])

  const frame = screen.captureCharFrame()
  expect(frame).toContain("My name is Ada")
  expect(frame).toContain("Your name is Ada.")
  expect(frame).toContain("What is my name?")
  expect(frame).toContain("Ada")
  expect(frame).toContain("input 28 · output 6 · $0.000012")
})


test("OpenAI failure shows a transcript error and clears busy state", async () => {
  const pending = deferredResponse()
  const client: OpenAIClient = {
    respond: async () => pending.promise,
  }

  const screen = await testRender(<App client={client} />, { width: 80, height: 24 })
  renderer = screen.renderer

  await act(async () => {
    await screen.mockInput.typeText("hi")
  })
  await screen.flush()

  act(() => {
    screen.mockInput.pressEnter()
  })
  await screen.flush()

  expect(screen.captureCharFrame()).toContain("AI harness · running")

  await act(async () => {
    pending.reject(new Error("OpenAI request failed (401): Invalid API key"))
    await pending.promise.catch(() => {})
  })
  await screen.flush()

  const frame = screen.captureCharFrame()
  expect(frame).toContain("ERROR")
  expect(frame).toContain("OpenAI request failed (401): Invalid API key")
  expect(frame).toContain("Ask the harness")
  expect(frame).not.toContain("AI harness · running")
})

test("renders assistant output, tool states, and real usage", async () => {
  const items = [
    { id: "1", kind: "assistant", text: "I will inspect the file." },
    {
      id: "2",
      kind: "tool",
      callId: "call-1",
      name: "read_file",
      input: '{"path":"package.json"}',
      status: "running",
    },
    {
      id: "3",
      kind: "tool",
      callId: "call-2",
      name: "read_file",
      input: '{"path":"missing.txt"}',
      status: "failed",
      summary: "File not found",
    },
  ] satisfies readonly TranscriptItem[]

  const screen = await testRender(
    <HarnessView
      items={items}
      busy
      usage={{ inputTokens: 120, outputTokens: 30, costUsd: 0.00006 }}
      onSubmit={() => {}}
    />,
    { width: 80, height: 24 },
  )
  renderer = screen.renderer

  await screen.renderOnce()
  const frame = screen.captureCharFrame()

  expect(frame).toContain("ASSISTANT")
  expect(frame).toContain("I will inspect the file.")
  expect(frame).toContain("running  read_file")
  expect(frame).toContain('{"path":"package.json"}')
  expect(frame).toContain("failed   read_file · File not found")
  expect(frame).toContain("input 120 · output 30 · $0.000060")
})
