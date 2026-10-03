import { createCliRenderer } from "@opentui/core"
import { createRoot, useKeyboard } from "@opentui/react"
import { useCallback, useMemo, useRef, useState } from "react"
import { runTurn, type TurnEvent } from "./agent-loop.js"
import { createJsonlSink } from "./logging/jsonl.js"
import { createInitialModelContext } from "./model-context.js"
import { createOpenAIClient } from "./openai/client.js"
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
  onSubmit: (prompt: string) => void
}

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
        <box style={{ flexDirection: "column", marginBottom: 1 }}>
          <text content="YOU" style={{ fg: "#8fbcff" }} />
          <text content={item.text} wrapMode="word" />
        </box>
      )
    case "assistant":
      return (
        <box style={{ flexDirection: "column", marginBottom: 1 }}>
          <text content="ASSISTANT" style={{ fg: "#9ece6a" }} />
          <text content={item.text} wrapMode="word" />
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
      const summary = item.summary === undefined ? "" : ` · ${item.summary}`
      const focusMark = focused ? "▸ " : "  "
      const lines = expanded ? (item.output === undefined ? 4 : 5) : 3

      return (
        <box
          focusable={item.status !== "running"}
          focused={focused}
          style={{
            border: true,
            borderColor: focused ? "#8fbcff" : color,
            flexDirection: "column",
            height: lines,
            marginBottom: 1,
            paddingX: 1,
          }}
        >
          <text content={`${focusMark}${label.padEnd(8)} ${item.name}${summary}`} style={{ fg: color }} />
          {expanded ? <text content={item.input} style={{ fg: "#8c94a3" }} wrapMode="word" /> : null}
          {expanded && item.output !== undefined ? (
            <text content={item.output} style={{ fg: "#8c94a3" }} wrapMode="word" />
          ) : null}
        </box>
      )
    }
  }
}

export function HarnessView({ items, busy, usage, onSubmit }: HarnessViewProps) {
  const [draft, setDraft] = useState("")
  const [focus, setFocus] = useState<FocusTarget>("prompt")
  const [expandedCallIds, setExpandedCallIds] = useState<ReadonlySet<string>>(() => new Set())

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

  useKeyboard((key) => {
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

  const submit = useCallback(
    () => {
      const prompt = draft.trim()
      if (prompt.length === 0 || busy || focus !== "prompt") return

      setDraft("")
      setFocus("prompt")
      onSubmit(prompt)
    },
    [busy, draft, focus, onSubmit],
  )

  return (
    <box style={{ flexDirection: "column", padding: 1 }}>
      <text content={busy ? "AI harness · running" : "AI harness"} style={{ fg: "#8fbcff" }} />

      <scrollbox
        flexGrow={1}
        stickyScroll={true}
        stickyStart="bottom"
        contentOptions={{ paddingRight: 1 }}
        verticalScrollbarOptions={{ visible: true }}
      >
        {items.length === 0 ? (
          <text content="Messages and tool calls will appear here." style={{ fg: "#8c94a3" }} />
        ) : (
          items.map((item) => (
            <TranscriptRow
              key={item.id}
              item={item}
              focused={item.kind === "tool" && focus === item.callId}
              expanded={item.kind === "tool" ? toolExpanded(item, expandedCallIds) : false}
            />
          ))
        )}
      </scrollbox>

      <box title={busy ? "Running" : focus === "prompt" ? "Prompt" : "Prompt (Tab)"} style={{ border: true, height: 3 }}>
        <input
          value={draft}
          placeholder={busy ? "Waiting for the agent" : "Ask the harness"}
          focused={!busy && focus === "prompt"}
          onInput={setDraft}
          onSubmit={submit}
        />
      </box>

      <text
        content={`input ${usage.inputTokens} · output ${usage.outputTokens} · $${usage.costUsd.toFixed(6)}`}
        style={{ fg: "#8c94a3" }}
      />
    </box>
  )
}

const EMPTY_USAGE: Usage = { inputTokens: 0, outputTokens: 0, costUsd: 0 }

type AppProps = {
  client: OpenAIClient
}

export function App({ client }: AppProps) {
  const [items, setItems] = useState<TranscriptItem[]>([])
  const [busy, setBusy] = useState(false)
  const [usage, setUsage] = useState(EMPTY_USAGE)
  const nextId = useRef(0)
  // Model context is provider input state, not UI transcript state.
  const modelContext = useRef<ModelInputItem[]>(createInitialModelContext())

  const onSubmit = useCallback(
    (prompt: string) => {
      nextId.current += 1
      const userItem: TranscriptItem = { id: `local-${nextId.current}`, kind: "user", text: prompt }
      setItems((current) => [...current, userItem])
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
          setBusy(false)
        })
    },
    [client],
  )

  return <HarnessView items={items} busy={busy} usage={usage} onSubmit={onSubmit} />
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
  createRoot(renderer).render(<App client={client} />)
}
