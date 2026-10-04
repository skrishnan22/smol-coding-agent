import { afterEach, expect, test } from "bun:test"
import { testRender } from "@opentui/react/test-utils"
import { act } from "react"
import { App, HarnessView, type TranscriptItem } from "../src/app.js"
import { createInitialModelContext, createUserMessage } from "../src/model-context.js"
import type { ModelInputItem, OpenAIClient, OpenAIResponse } from "../src/openai/types.js"

// Layout and markdown content settle a few frames after the first render, so wait for a stable frame.
const withoutSpinner = (frame: string) => frame.replace(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/g, "")

async function frameOf(screen: Awaited<ReturnType<typeof testRender>>): Promise<string> {
  let previous = ""
  let stable = 0
  for (let i = 0; i < 80 && stable < 10; i += 1) {
    await screen.renderOnce()
    await new Promise((resolve) => setTimeout(resolve, 25))
    const current = screen.captureCharFrame()
    // The spinner animates forever while busy; ignore it when deciding the frame has settled.
    stable = withoutSpinner(current) === withoutSpinner(previous) ? stable + 1 : 0
    previous = current
  }
  return previous
}

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


test("a function_call runs read_file, continues, and shows the assistant reply", async () => {
  const functionCall = {
    type: "function_call",
    call_id: "call_read_1",
    name: "read_file",
    arguments: '{"path":"package.json"}',
  }

  const calls: ModelInputItem[][] = []
  const responses = [
    {
      id: "resp_tool",
      status: "completed",
      text: "",
      output: [functionCall],
      usage: { inputTokens: 12, outputTokens: 8, estimatedCostUsd: 0.000012 },
    },
    {
      id: "resp_final",
      status: "completed",
      text: "package.json lists the harness dependencies.",
      output: [
        {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "package.json lists the harness dependencies." }],
        },
      ],
      usage: { inputTokens: 40, outputTokens: 10, estimatedCostUsd: 0.00002 },
    },
  ] satisfies OpenAIResponse[]

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
    await screen.mockInput.typeText("Read package.json")
  })
  await screen.flush()
  await act(async () => {
    screen.mockInput.pressEnter()
    await Promise.resolve()
    await Promise.resolve()
  })
  await screen.flush()

  const frame = (await frameOf(screen))
  expect(frame).toContain("YOU")
  expect(frame).toContain("Read package.json")
  expect(frame).toContain("done     read_file")
  expect(frame).toContain("package.json")
  expect(frame).toContain("ASSISTANT")
  expect(frame).toContain("package.json lists the harness dependencies.")
  expect(frame).toContain("input 52 · output 18 · $0.000032")
  expect(frame).toContain("Ask the harness")
  expect(frame).not.toContain("AI harness · running")
  expect(calls).toHaveLength(2)
  expect(calls[0]).toEqual([...createInitialModelContext(), createUserMessage("Read package.json")])
  expect(calls[1]?.at(-1)).toMatchObject({
    type: "function_call_output",
    call_id: "call_read_1",
  })
})


test("several read_file calls in one response each get a card, then the model continues", async () => {
  const output = [
    { type: "function_call", call_id: "call_1", name: "read_file", arguments: '{"path":"a.txt"}' },
    { type: "function_call", call_id: "call_2", name: "read_file", arguments: '{"path":"b.txt"}' },
  ]

  let responses = 0
  const client: OpenAIClient = {
    respond: async () => {
      responses += 1
      return {
        id: `resp_${responses}`,
        status: "completed",
        text: responses === 1 ? "" : "Neither file exists.",
        output:
          responses === 1
            ? output
            : [{ type: "message", content: [{ type: "output_text", text: "Neither file exists." }] }],
        usage: { inputTokens: 9, outputTokens: 6, estimatedCostUsd: 0.000009 },
      }
    },
  }

  const screen = await testRender(<App client={client} />, { width: 80, height: 40 })
  renderer = screen.renderer

  await act(async () => {
    await screen.mockInput.typeText("Read two files")
  })
  await screen.flush()
  await act(async () => {
    screen.mockInput.pressEnter()
    await new Promise((resolve) => setTimeout(resolve, 50))
  })
  await screen.flush()
  await screen.renderOnce()
  await screen.renderOnce()

  const frame = (await frameOf(screen))
  expect(responses).toBe(2)
  expect(frame).toContain("failed   read_file a.txt · file not found: a.txt")
  expect(frame).toContain("failed   read_file b.txt · file not found: b.txt")
  expect(frame).toContain("Neither file exists.")
  expect(frame).not.toContain("ERROR")
})

test("renders the empty harness shell", async () => {
  const screen = await testRender(<App client={idleClient} />, { width: 80, height: 20 })
  renderer = screen.renderer

  await screen.renderOnce()
  const frame = (await frameOf(screen))

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

  let frame = (await frameOf(screen))
  expect(frame).toContain("YOU")
  expect(frame).toContain("Explain the loop")
  expect(frame).toContain("AI harness · running")
  expect(frame).toContain("Type to queue or steer")
  expect(frame).toContain("thinking…")
  expect(calls).toEqual([[...createInitialModelContext(), createUserMessage("Explain the loop")]])

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

  frame = (await frameOf(screen))
  expect(frame).toContain("ASSISTANT")
  expect(frame).toContain("Here is the explanation.")
  expect(frame).not.toContain("thinking…")
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

  expect(calls[0]).toEqual([...createInitialModelContext(), createUserMessage("My name is Ada")])

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
    ...createInitialModelContext(),
    createUserMessage("My name is Ada"),
    ...firstOutput,
    createUserMessage("What is my name?"),
  ])

  const frame = (await frameOf(screen))
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

  expect((await frameOf(screen))).toContain("AI harness · running")

  await act(async () => {
    pending.reject(new Error("OpenAI request failed (401): Invalid API key"))
    await pending.promise.catch(() => {})
  })
  await screen.flush()

  const frame = (await frameOf(screen))
  expect(frame).toContain("ERROR")
  expect(frame).toContain("OpenAI request failed (401): Invalid API key")
  expect(frame).toContain("Ask the harness")
  expect(frame).not.toContain("AI harness · running")
})


test("completed tool cards collapse and expand with Enter", async () => {
  const items = [
    {
      id: "1",
      kind: "tool",
      callId: "call-1",
      name: "read_file",
      input: '{"path":"fixtures/hello.txt"}',
      status: "succeeded",
      summary: "fixtures/hello.txt · 31B",
      output: '{"path":"fixtures/hello.txt","bytes":31,"content":"hello from the harness fixture\\n"}',
    },
  ] satisfies readonly TranscriptItem[]

  const screen = await testRender(
    <HarnessView items={items} busy={false} usage={{ inputTokens: 1, outputTokens: 1, costUsd: 0.000001 }} onSubmit={() => {}} />,
    { width: 80, height: 20 },
  )
  renderer = screen.renderer

  await screen.renderOnce()
  let frame = (await frameOf(screen))
  expect(frame).toContain("done     read_file · fixtures/hello.txt · 31B")
  expect(frame).not.toContain('{"path":"fixtures/hello.txt"}')

  act(() => {
    screen.mockInput.pressTab()
  })
  await screen.flush()
  act(() => {
    screen.mockInput.pressEnter()
  })
  await screen.flush()

  frame = (await frameOf(screen))
  expect(frame).toContain('{"path":"fixtures/hello.txt"}')
  expect(frame).toContain("hello from the harness")
  expect(frame).toContain("fixture")
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

  // Sticky-bottom scrolling settles on the second frame.
  await screen.renderOnce()
  await screen.renderOnce()
  const frame = (await frameOf(screen))

  expect(frame).toContain("ASSISTANT")
  expect(frame).toContain("I will inspect the file.")
  expect(frame).toContain("running  read_file")
  expect(frame).toContain('{"path":"package.json"}')
  expect(frame).toContain("failed   read_file missing.txt · File not found")
  expect(frame).toContain("input 120 · output 30 · $0.000060")
})

test("assistant markdown renders formatted, with the code block intact and tool calls on one line", async () => {
  const items = [
    {
      id: "1",
      kind: "tool",
      callId: "c1",
      name: "read_file",
      input: '{"path":"a.ts"}',
      status: "succeeded",
      summary: "a.ts · 10B",
      output: "{}",
    },
    {
      id: "2",
      kind: "assistant",
      text: "# Result\n\nUse **bold** and `code`.\n\n```ts\nconst answer = 42\n```\n\n- first\n- second",
    },
  ] satisfies readonly TranscriptItem[]

  const screen = await testRender(
    <HarnessView items={items} busy={false} usage={{ inputTokens: 1, outputTokens: 1, costUsd: 0 }} onSubmit={() => {}} />,
    { width: 80, height: 24 },
  )
  renderer = screen.renderer

  const frame = await frameOf(screen)
  expect(frame).toContain("Result")
  expect(frame).not.toContain("# Result")
  expect(frame).toContain("Use bold and code.")
  expect(frame).not.toContain("**bold**")
  expect(frame).toContain("const answer = 42")
  expect(frame).not.toContain("```")
  expect(frame).toContain("done     read_file · a.ts · 10B")
  expect(frame).not.toContain("┌─read_file")
})

test("a long answer opens at its first line, and the next turn still follows the bottom", async () => {
  const long = `START of answer\n\n${Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join("\n\n")}\n\nEND of answer`
  const replies = [long, "Second reply."]
  const client: OpenAIClient = {
    respond: async () => {
      const text = replies.shift() ?? "unexpected"
      return {
        id: "resp",
        status: "completed",
        text,
        output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text }] }],
        usage: { inputTokens: 1, outputTokens: 1, estimatedCostUsd: 0 },
      }
    },
  }
  const screen = await testRender(<App client={client} />, { width: 60, height: 20 })
  renderer = screen.renderer

  const ask = async (text: string) => {
    await act(async () => {
      await screen.mockInput.typeText(text)
    })
    await screen.flush()
    await act(async () => {
      screen.mockInput.pressEnter()
      await new Promise((resolve) => setTimeout(resolve, 150))
    })
    await screen.flush()
  }

  await ask("first question")
  let frame = await frameOf(screen)
  expect(frame).toContain("START of answer")
  expect(frame).not.toContain("END of answer")
  expect(frame).toContain("AI harness")
  expect(frame).toContain("input 1 · output 1")

  await ask("second question")
  frame = await frameOf(screen)
  expect(frame).toContain("Second reply.")
})

test("tool lines show a trimmed command, expanded output is clipped, and user messages carry an accent bar", async () => {
  const longCommand = `echo ${"x".repeat(200)}`
  const longOutput = Array.from({ length: 40 }, (_, i) => `output line ${i + 1}`).join("\n")
  const items = [
    { id: "1", kind: "user", text: "run it" },
    {
      id: "2",
      kind: "tool",
      callId: "c1",
      name: "bash",
      input: JSON.stringify({ command: longCommand }),
      status: "succeeded",
      summary: "exit 0 · 12ms",
      output: longOutput,
    },
  ] satisfies readonly TranscriptItem[]

  const screen = await testRender(
    <HarnessView items={items} busy={false} usage={{ inputTokens: 1, outputTokens: 1, costUsd: 0 }} onSubmit={() => {}} />,
    { width: 100, height: 40 },
  )
  renderer = screen.renderer

  let frame = await frameOf(screen)
  expect(frame).toContain("done     bash echo xxx")
  expect(frame).toContain("… · exit 0 · 12ms")
  expect(frame).not.toContain("x".repeat(80))
  expect(frame).not.toContain("output line 1")
  expect(frame).toContain("│ YOU")

  act(() => {
    screen.mockInput.pressTab()
  })
  act(() => {
    screen.mockInput.pressEnter()
  })
  frame = await frameOf(screen)
  expect(frame).toContain("output line 1")
  expect(frame).toContain("output line 12")
  expect(frame).not.toContain("output line 13")
  expect(frame).toContain("more chars")
})
