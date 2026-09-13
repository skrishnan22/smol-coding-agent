import { createCliRenderer } from "@opentui/core"
import { createRoot } from "@opentui/react"
import { useCallback, useRef, useState } from "react"
import { createJsonlSink } from "./logging/jsonl.js"
import { appendResponseOutput, appendUserMessage } from "./model-context.js"
import { createOpenAIClient } from "./openai/client.js"
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
    }

export type Usage = {
  inputTokens: number
  outputTokens: number
  costUsd: number
}

type HarnessViewProps = {
  items: readonly TranscriptItem[]
  busy: boolean
  usage: Usage
  onSubmit: (prompt: string) => void
}

function TranscriptRow({ item }: { item: TranscriptItem }) {
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

      return (
        <box
          style={{
            border: true,
            borderColor: color,
            flexDirection: "column",
            height: item.status === "running" ? 4 : 3,
            marginBottom: 1,
            paddingX: 1,
          }}
        >
          <text content={`${label.padEnd(8)} ${item.name}${summary}`} style={{ fg: color }} />
          {item.status === "running" ? <text content={item.input} style={{ fg: "#8c94a3" }} wrapMode="word" /> : null}
        </box>
      )
    }
  }
}

export function HarnessView({ items, busy, usage, onSubmit }: HarnessViewProps) {
  const [draft, setDraft] = useState("")

  const submit = useCallback(
    () => {
      const prompt = draft.trim()
      if (prompt.length === 0 || busy) return

      setDraft("")
      onSubmit(prompt)
    },
    [busy, draft, onSubmit],
  )

  return (
    <box style={{ flexDirection: "column", padding: 1 }}>
      <text content={busy ? "AI harness · running" : "AI harness"} style={{ fg: "#8fbcff" }} />

      <scrollbox flexGrow={1} contentOptions={{ paddingRight: 1 }} verticalScrollbarOptions={{ visible: true }}>
        {items.length === 0 ? (
          <text content="Messages and tool calls will appear here." style={{ fg: "#8c94a3" }} />
        ) : (
          items.map((item) => <TranscriptRow key={item.id} item={item} />)
        )}
      </scrollbox>

      <box title={busy ? "Running" : "Prompt"} style={{ border: true, height: 3 }}>
        <input
          value={draft}
          placeholder={busy ? "Waiting for the agent" : "Ask the harness"}
          focused={!busy}
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
  const modelContext = useRef<ModelInputItem[]>([])

  const onSubmit = useCallback(
    (prompt: string) => {
      nextId.current += 1
      const userItem: TranscriptItem = { id: `local-${nextId.current}`, kind: "user", text: prompt }
      setItems((current) => [...current, userItem])

      const nextContext = appendUserMessage(modelContext.current, prompt)
      modelContext.current = nextContext
      setBusy(true)

      void client
        .respond(nextContext)
        .then((result) => {
          modelContext.current = appendResponseOutput(modelContext.current, result.output)

          nextId.current += 1
          const assistantItem: TranscriptItem = {
            id: `local-${nextId.current}`,
            kind: "assistant",
            text: result.text,
          }
          setItems((current) => [...current, assistantItem])
          setUsage((current) => ({
            inputTokens: current.inputTokens + result.usage.inputTokens,
            outputTokens: current.outputTokens + result.usage.outputTokens,
            costUsd: current.costUsd + result.usage.estimatedCostUsd,
          }))
        })
        .catch((cause: unknown) => {
          nextId.current += 1
          const message = cause instanceof Error ? cause.message : String(cause)
          const errorItem: TranscriptItem = { id: `local-${nextId.current}`, kind: "error", text: message }
          setItems((current) => [...current, errorItem])
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

  const log = createJsonlSink<OpenAIWideEvent>(".harness/logs/openai.jsonl")
  const client = createOpenAIClient({
    apiKey,
    fetch,
    log,
  })

  const renderer = await createCliRenderer({ exitOnCtrlC: true })
  createRoot(renderer).render(<App client={client} />)
}
