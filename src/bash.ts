import { z } from "zod"
import { runSandboxed, type SandboxOptions } from "./sandbox.js"
import type { ToolResult } from "./tool-result.js"

const argumentsSchema = z
  .object({
    command: z.string().min(1, "command must not be empty"),
  })
  .strict()

function failure(error: string): ToolResult {
  return { ok: false, error, output: JSON.stringify({ error }) }
}

/**
 * Validate and run one shell command in the sandbox.
 * A command that ran is always `ok: true`, whatever its exit code: `tool_failed`
 * means the harness could not run it. Sandbox denials show up as stderr + exit code.
 */
export async function runBash(rawArguments: string, options: SandboxOptions): Promise<ToolResult> {
  let parsedArgs: unknown
  try {
    parsedArgs = JSON.parse(rawArguments)
  } catch {
    return failure("arguments must be valid JSON")
  }

  const args = argumentsSchema.safeParse(parsedArgs)
  if (!args.success) {
    return failure(args.error.issues[0]?.message ?? "invalid arguments")
  }

  const startedAt = performance.now()
  let run
  try {
    run = await runSandboxed(args.data.command, options)
  } catch (cause) {
    return failure(`failed to start sandbox: ${cause instanceof Error ? cause.message : String(cause)}`)
  }
  const durationMs = Math.round(performance.now() - startedAt)

  return {
    ok: true,
    summary: run.timedOut ? `timed out · ${durationMs}ms` : `exit ${run.exitCode} · ${durationMs}ms`,
    output: JSON.stringify({
      exit_code: run.exitCode,
      stdout: run.stdout,
      stderr: run.stderr,
      truncated: run.truncated,
      timed_out: run.timedOut,
    }),
  }
}
