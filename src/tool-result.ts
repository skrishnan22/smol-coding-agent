/** What every local tool returns to the agent loop. */
export type ToolResult =
  | {
      ok: true
      /** JSON string sent back to the model as function_call_output. */
      output: string
      /** One-line label for the UI card, e.g. "exit 0 · 14ms". */
      summary: string
    }
  | {
      ok: false
      /** Structured error JSON still returned to the model. */
      output: string
      error: string
    }
