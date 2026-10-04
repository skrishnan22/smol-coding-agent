/** What every local tool returns to the agent loop. */
export type ToolResult =
  | {
      ok: true
      /** JSON sent back to the model as function_call_output. */
      output: string
      /** UI card label, e.g. "exit 0 · 14ms". */
      summary: string
    }
  | {
      ok: false
      output: string
      error: string
    }
