import { createCliRenderer, SyntaxStyle, type ScrollBoxRenderable } from "@opentui/core"
import { createRoot, useKeyboard } from "@opentui/react"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { runTurn, type QueuedKind, type TurnEvent } from "./agent-loop.js"
import { createJsonlSink } from "./logging/jsonl.js"
import { createInitialModelContext } from "./model-context.js"
import { createOpenAIClient, OPENAI_MODEL, OPENAI_REASONING_EFFORT } from "./openai/client.js"
import { SANDBOX_EXEC } from "./sandbox.js"
import type { ModelInputItem, OpenAIClient, OpenAIWideEvent } from "./openai/types.js"

export type TranscriptItem =
  | { id: string; kind: "user"; text: string }
  | { id: string; kind: "assistant"; text: string }
  | { id: string; kind: "error"; text: string }
  | {
      id: string
      kind: "tool"
      callId: string
      name: string
      input: string
      status: "running" | "succeeded" | "failed"
      summary?: string
      output?: string
    }

/** Pending until the loop injects it. */
export type QueuedMessage = { id: string; kind: QueuedKind; text: string }

export type ModelInfo = { name: string; effort: string }

export type Usage = {
  inputTokens: number
  outputTokens: number
  costUsd: number
}

type FocusTarget = "prompt" | string

type HarnessViewProps = {
  items: readonly TranscriptItem[]
  busy: boolean
  usage: Usage
  model?: ModelInfo
  queued?: readonly QueuedMessage[]
  /** Enter sends a follow_up, Ctrl+S sends steering. Both start a turn when idle. */
  onSubmit: (prompt: string, kind: QueuedKind) => void
}

function headerText(model: ModelInfo | undefined, busy: boolean): string {
  const parts = ["AI harness"]
  if (model !== undefined) parts.push(model.name, `effort ${model.effort}`)
  if (busy) parts.push("running")
  return parts.join(" · ")
}

const MARKDOWN_STYLE = SyntaxStyle.fromStyles({
  default: { fg: "#c0caf5" },
  "markup.heading": { fg: "#7aa2f7", bold: true },
  "markup.strong": { bold: true },
  "markup.italic": { italic: true },
  "markup.raw": { fg: "#e0af68" },
  "markup.link": { fg: "#7dcfff", underline: true },
  "markup.link.url": { fg: "#7dcfff", underline: true },
  "markup.list": { fg: "#bb9af7" },
  keyword: { fg: "#bb9af7", italic: true },
  string: { fg: "#9ece6a" },
  comment: { fg: "#565f89", italic: true },
  number: { fg: "#ff9e64" },
  function: { fg: "#7aa2f7" },
  type: { fg: "#2ac3de" },
  operator: { fg: "#89ddff" },
  punctuation: { fg: "#89ddff" },
})

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]

function ThinkingIndicator() {
  const [frame, setFrame] = useState(0)

  useEffect(() => {
    const timer = setInterval(() => setFrame((current) => (current + 1) % SPINNER_FRAMES.length), 80)
    return () => clearInterval(timer)
  }, [])

  return <text content={`${SPINNER_FRAMES[frame]} thinking…`} style={{ fg: "#8c94a3" }} marginBottom={1} />
}

const ARG_PREVIEW_CHARS = 60
const EXPANDED_INPUT_CHARS = 300
const EXPANDED_OUTPUT_CHARS = 600
const EXPANDED_OUTPUT_LINES = 12

const oneLine = (text: string) => text.replace(/\s+/g, " ").trim()

function truncate(text: string, maxChars: number): string {
  return text.length <= maxChars ? text : `${text.slice(0, maxChars - 1)}…`
}

/** The argument worth showing: the command or path when there is one, else the raw JSON. */
function describeArgs(rawArguments: string): string {
  try {
    const parsed: unknown = JSON.parse(rawArguments)
    if (typeof parsed === "object" && parsed !== null) {
      const { command, path } = parsed as Record<string, unknown>
      if (typeof command === "string") return command
      if (typeof path === "string") return path
    }
  } catch {
    // Arguments that are not JSON are shown as-is below.
  }
  return rawArguments
}

/** Long output stays available but does not take over the transcript. */
function clipBlock(text: string, maxChars: number, maxLines: number): string {
  const lines = text.split("\n")
  const byLines = lines.length > maxLines ? lines.slice(0, maxLines).join("\n") : text
  const clipped = byLines.length > maxChars ? byLines.slice(0, maxChars) : byLines
  const hidden = text.length - clipped.length
  return hidden > 0 ? `${clipped}\n… ${hidden} more chars` : clipped
}

const assistantRowId = (itemId: string) => `assistant-${itemId}`

function toolExpanded(
  item: Extract<TranscriptItem, { kind: "tool" }>,
  expandedCallIds: ReadonlySet<string>,
): boolean {
  if (item.status === "running" || item.status === "failed") return true
  return expandedCallIds.has(item.callId)
}

function TranscriptRow({
  item,
  focused,
  expanded,
}: {
  item: TranscriptItem
  focused: boolean
  expanded: boolean
}) {
  switch (item.kind) {
    case "user":
      return (
        <box
          border={["left"]}
          borderColor="#8fbcff"
          backgroundColor="#1f2335"
          style={{ flexDirection: "column", marginBottom: 1, paddingX: 1 }}
        >
          <text content="YOU" style={{ fg: "#8fbcff" }} />
          <text content={item.text} wrapMode="word" />
        </box>
      )
    case "assistant":
      return (
        <box id={assistantRowId(item.id)} style={{ flexDirection: "column", marginBottom: 1 }}>
          <text content="ASSISTANT" style={{ fg: "#9ece6a" }} />
          <markdown content={item.text} syntaxStyle={MARKDOWN_STYLE} conceal={true} />
        </box>
      )
    case "error":
      return (
        <box style={{ flexDirection: "column", marginBottom: 1 }}>
          <text content="ERROR" style={{ fg: "#f7768e" }} />
          <text content={item.text} wrapMode="word" style={{ fg: "#f7768e" }} />
        </box>
      )
    case "tool": {
      const label = item.status === "succeeded" ? "done" : item.status
      const color = item.status === "running" ? "#e0af68" : item.status === "succeeded" ? "#9ece6a" : "#f7768e"
      const args = oneLine(describeArgs(item.input))
      // read_file's summary already leads with the path, so do not say it twice.
      const preview = item.summary?.startsWith(args) === true ? "" : ` ${truncate(args, ARG_PREVIEW_CHARS)}`
      const summary = item.summary === undefined ? "" : ` · ${truncate(oneLine(item.summary), 80)}`
      const focusMark = focused ? "▸ " : "  "

      return (
        <box
          focusable={item.status !== "running"}
          focused={focused}
          style={{ flexDirection: "column", marginBottom: expanded ? 1 : 0 }}
        >
          <text
            content={`${focusMark}${label.padEnd(8)} ${item.name}${preview}${summary}`}
            style={{ fg: focused ? "#8fbcff" : color }}
          />
          {expanded ? (
            <text content={truncate(item.input, EXPANDED_INPUT_CHARS)} style={{ fg: "#565f89" }} wrapMode="word" />
          ) : null}
          {expanded && item.output !== undefined ? (
            <text
              content={clipBlock(item.output, EXPANDED_OUTPUT_CHARS, EXPANDED_OUTPUT_LINES)}
              style={{ fg: "#565f89" }}
              wrapMode="word"
            />
          ) : null}
        </box>
      )
    }
  }
}

export function HarnessView({ items, busy, usage, model, queued = [], onSubmit }: HarnessViewProps) {
  const [draft, setDraft] = useState("")
  const [focus, setFocus] = useState<FocusTarget>("prompt")
  const [expandedCallIds, setExpandedCallIds] = useState<ReadonlySet<string>>(() => new Set())

  // Dead air between model calls: the model is working and no tool is.
  const thinking = busy && !items.some((item) => item.kind === "tool" && item.status === "running")

  const scrollRef = useRef<ScrollBoxRenderable | null>(null)
  const lastItem = items.at(-1)
  const lastAssistantId = lastItem?.kind === "assistant" ? lastItem.id : undefined

  // A finished answer should be read from its first line, not its last. Pin its top to the
  // viewport top; a short answer still ends at the bottom because the scrollbox clamps.
  useEffect(() => {
    if (lastAssistantId === undefined) return
    const timer = setTimeout(() => {
      const scroll = scrollRef.current
      const row = scroll?.findDescendantById(assistantRowId(lastAssistantId))
      if (scroll === null || scroll === undefined || row === undefined) return
      scroll.scrollTo(scroll.scrollTop + (row.y - scroll.y))
    }, 50)
    return () => clearTimeout(timer)
  }, [lastAssistantId])

  const focusableToolIds = useMemo(
    () =>
      items
        .filter((item): item is Extract<TranscriptItem, { kind: "tool" }> => item.kind === "tool" && item.status !== "running")
        .map((item) => item.callId),
    [items],
  )

  const cycleFocus = useCallback(
    (direction: 1 | -1) => {
      const targets: FocusTarget[] = ["prompt", ...focusableToolIds]
      const currentIndex = Math.max(0, targets.indexOf(focus))
      const nextIndex = (currentIndex + direction + targets.length) % targets.length
      setFocus(targets[nextIndex] ?? "prompt")
    },
    [focus, focusableToolIds],
  )

  const submit = useCallback(
    (kind: QueuedKind) => {
      const prompt = draft.trim()
      if (prompt.length === 0 || focus !== "prompt") return

      setDraft("")
      setFocus("prompt")
      onSubmit(prompt, kind)
    },
    [draft, focus, onSubmit],
  )

  useKeyboard((key) => {
    // Ctrl+S steers. Enter (on the input) queues a follow-up.
    if (key.ctrl && key.name === "s") {
      submit("steering")
      return
    }

    if (busy) return

    if (key.name === "tab") {
      cycleFocus(key.shift ? -1 : 1)
      return
    }

    if ((key.name === "return" || key.name === "enter") && focus !== "prompt") {
      setExpandedCallIds((current) => {
        const next = new Set(current)
        if (next.has(focus)) next.delete(focus)
        else next.add(focus)
        return next
      })
    }
  })

  return (
    <box style={{ flexDirection: "column", padding: 1 }}>
      <text content={headerText(model, busy)} style={{ fg: "#8fbcff", flexShrink: 0 }} />

      <scrollbox
        ref={scrollRef}
        flexGrow={1}
        stickyScroll={true}
        stickyStart="bottom"
        contentOptions={{ paddingRight: 1 }}
        verticalScrollbarOptions={{ visible: true }}
      >
        {items.length === 0 && queued.length === 0 && !thinking ? (
          <text content="Messages and tool calls will appear here." style={{ fg: "#8c94a3" }} />
        ) : (
          <>
            {items.map((item) => (
              <TranscriptRow
                key={item.id}
                item={item}
                focused={item.kind === "tool" && focus === item.callId}
                expanded={item.kind === "tool" ? toolExpanded(item, expandedCallIds) : false}
              />
            ))}
            {thinking ? <ThinkingIndicator /> : null}
            {queued.map((message) => (
              <box key={message.id} style={{ flexDirection: "column", marginBottom: 1 }}>
                <text
                  content={`QUEUED · ${message.kind === "steering" ? "steering" : "follow-up"}`}
                  style={{ fg: "#e0af68" }}
                />
                <text content={message.text} wrapMode="word" style={{ fg: "#8c94a3" }} />
              </box>
            ))}
          </>
        )}
      </scrollbox>

      <box title={busy ? "Running · Enter queues follow-up · Ctrl+S steers" : focus === "prompt" ? "Prompt" : "Prompt (Tab)"} style={{ border: true, height: 3, flexShrink: 0 }}>
        <input
          value={draft}
          placeholder={busy ? "Type to queue or steer" : "Ask the harness"}
          focused={focus === "prompt"}
          onInput={setDraft}
          onSubmit={() => submit("follow_up")}
        />
      </box>

      <text
        content={`input ${usage.inputTokens} · output ${usage.outputTokens} · $${usage.costUsd.toFixed(6)}`}
        style={{ fg: "#8c94a3", flexShrink: 0 }}
      />
    </box>
  )
}

const EMPTY_USAGE: Usage = { inputTokens: 0, outputTokens: 0, costUsd: 0 }

type AppProps = {
  client: OpenAIClient
  model?: ModelInfo
}

export function App({ client, model }: AppProps) {
  const [items, setItems] = useState<TranscriptItem[]>([])
  const [queued, setQueued] = useState<QueuedMessage[]>([])
  const [busy, setBusy] = useState(false)
  const [usage, setUsage] = useState(EMPTY_USAGE)
  const nextId = useRef(0)
  // Provider input state, not UI state.
  const modelContext = useRef<ModelInputItem[]>(createInitialModelContext())
  // The loop drains these; the `queued` state is only for display.
  const busyRef = useRef(false)
  const queues = useRef<Record<QueuedKind, string[]>>({ steering: [], follow_up: [] })

  const takeQueue = (kind: QueuedKind) => queues.current[kind].splice(0)

  const startTurn = useCallback(
    (prompt: string) => {
      nextId.current += 1
      const userItem: TranscriptItem = { id: `local-${nextId.current}`, kind: "user", text: prompt }
      setItems((current) => [...current, userItem])
      busyRef.current = true
      setBusy(true)

      const handleEvent = (event: TurnEvent) => {
        switch (event.type) {
          case "model_started":
            return
          case "usage_recorded":
            setUsage((current) => ({
              inputTokens: current.inputTokens + event.inputTokens,
              outputTokens: current.outputTokens + event.outputTokens,
              costUsd: current.costUsd + event.estimatedCostUsd,
            }))
            return
          case "tool_started":
            nextId.current += 1
            setItems((current) => [
              ...current,
              {
                id: `local-${nextId.current}`,
                kind: "tool",
                callId: event.callId,
                name: event.name,
                input: event.rawArguments,
                status: "running",
              },
            ])
            return
          case "tool_finished":
            setItems((current) =>
              current.map((item) =>
                item.kind === "tool" && item.callId === event.callId
                  ? { ...item, status: "succeeded", summary: event.summary, output: event.output }
                  : item,
              ),
            )
            return
          case "tool_failed":
            setItems((current) =>
              current.map((item) =>
                item.kind === "tool" && item.callId === event.callId
                  ? {
                      ...item,
                      status: "failed",
                      summary: event.error,
                      output: JSON.stringify({ error: event.error }),
                    }
                  : item,
              ),
            )
            return
          case "assistant_finished":
            nextId.current += 1
            setItems((current) => [
              ...current,
              {
                id: `local-${nextId.current}`,
                kind: "assistant",
                text: event.text,
              },
            ])
            return
          case "message_injected":
            nextId.current += 1
            setQueued((current) => {
              const index = current.findIndex((message) => message.kind === event.kind)
              return index < 0 ? current : current.filter((_, i) => i !== index)
            })
            setItems((current) => [
              ...current,
              { id: `local-${nextId.current}`, kind: "user", text: event.text },
            ])
            return
          case "turn_failed":
            nextId.current += 1
            setItems((current) => [
              ...current,
              {
                id: `local-${nextId.current}`,
                kind: "error",
                text: event.message,
              },
            ])
            return
        }
      }

      void runTurn({
        prompt,
        context: modelContext.current,
        client,
        rootDir: process.cwd(),
        onEvent: handleEvent,
        takeSteering: () => takeQueue("steering"),
        takeFollowUp: () => takeQueue("follow_up"),
      })
        .then((result) => {
          modelContext.current = result.context
        })
        .catch((cause: unknown) => {
          nextId.current += 1
          const message = cause instanceof Error ? cause.message : String(cause)
          setItems((current) => [
            ...current,
            { id: `local-${nextId.current}`, kind: "error", text: message },
          ])
        })
        .finally(() => {
          busyRef.current = false
          setBusy(false)

          // A failed turn can leave queued messages unread; the oldest becomes the next prompt.
          const kind: QueuedKind | undefined = (["steering", "follow_up"] as const).find(
            (candidate) => queues.current[candidate].length > 0,
          )
          if (kind === undefined) return
          const next = queues.current[kind].shift()!
          setQueued((current) => {
            const index = current.findIndex((message) => message.kind === kind)
            return index < 0 ? current : current.filter((_, i) => i !== index)
          })
          startTurn(next)
        })
    },
    [client],
  )

  const onSubmit = useCallback(
    (prompt: string, kind: QueuedKind) => {
      if (!busyRef.current) {
        startTurn(prompt)
        return
      }
      queues.current[kind].push(prompt)
      nextId.current += 1
      setQueued((current) => [...current, { id: `local-${nextId.current}`, kind, text: prompt }])
    },
    [startTurn],
  )

  return <HarnessView items={items} busy={busy} usage={usage} model={model} queued={queued} onSubmit={onSubmit} />
}

if (import.meta.main) {
  const apiKey = Bun.env.OPENAI_API_KEY ?? ""
  if (apiKey.trim().length === 0) {
    console.error("Configuration error: OPENAI_API_KEY is required")
    process.exit(1)
  }

  if (process.platform !== "darwin" || !(await Bun.file(SANDBOX_EXEC).exists())) {
    console.error(`Configuration error: the bash tool needs macOS Seatbelt (${SANDBOX_EXEC})`)
    process.exit(1)
  }

  const log = createJsonlSink<OpenAIWideEvent>(".harness/logs/openai.jsonl")
  const client = createOpenAIClient({
    apiKey,
    fetch,
    log,
  })

  const renderer = await createCliRenderer({ exitOnCtrlC: true })
  createRoot(renderer).render(<App client={client} model={{ name: OPENAI_MODEL, effort: OPENAI_REASONING_EFFORT }} />)
}
