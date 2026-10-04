import { realpath } from "node:fs/promises"
import { homedir, tmpdir } from "node:os"

export const SANDBOX_EXEC = "/usr/bin/sandbox-exec"
export const BASH_TIMEOUT_MS = 30_000
export const MAX_STREAM_BYTES = 16 * 1024

// Background jobs can hold the pipes open after bash exits.
const PIPE_GRACE_MS = 200

export type ProfileOptions = {
  rootDir: string
  tmpDir: string
  home: string
}

/** Only backslash and double quote need escaping in an SBPL string. */
function sbpl(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`
}

/** Allow everything, then subtract. The last matching rule wins, so order matters. */
export function buildProfile({ rootDir, tmpDir, home }: ProfileOptions): string {
  return [
    "(version 1)",
    "(allow default)",
    "(deny file-write*)",
    // /dev/tty is left out on purpose: editors that open the terminal should fail, not take over the TUI.
    `(allow file-write* (subpath ${sbpl(rootDir)}) (subpath ${sbpl(tmpDir)}) (literal "/dev/null"))`,
    "(deny network*)",
    // .env.example is re-allowed after the .env* deny.
    `(deny file-read* (subpath ${sbpl(`${home}/.ssh`)}) (subpath ${sbpl(`${home}/.aws`)}) (regex #"/\\.env(\\..*)?$"))`,
    `(allow file-read* (literal ${sbpl(`${rootDir}/.env.example`)}))`,
  ].join("\n")
}

export type SandboxOptions = {
  rootDir: string
  /** Tests pass a temp home. */
  home?: string
  timeoutMs?: number
  maxStreamBytes?: number
}

export type RawRun = {
  exitCode: number
  stdout: string
  stderr: string
  truncated: boolean
  timedOut: boolean
}

/** Keeps the first `max` bytes and keeps draining, so the child never blocks on a full pipe. */
function capture(stream: ReadableStream<Uint8Array>, max: number) {
  const chunks: Uint8Array[] = []
  let size = 0
  let truncated = false
  const reader = stream.getReader()

  const done = (async () => {
    try {
      for (;;) {
        const { done: finished, value } = await reader.read()
        if (finished) return
        const room = max - size
        if (room > 0) {
          const part = value.subarray(0, room)
          chunks.push(part)
          size += part.length
        }
        if (value.length > room) truncated = true
      }
    } catch {
      // reader cancelled
    }
  })()

  return {
    done,
    cancel: () => reader.cancel().catch(() => {}),
    text: () => new TextDecoder().decode(Buffer.concat(chunks)),
    truncated: () => truncated,
  }
}

export async function runSandboxed(command: string, options: SandboxOptions): Promise<RawRun> {
  const rootDir = await realpath(options.rootDir)
  const tmpDir = await realpath(tmpdir())
  const home = await realpath(options.home ?? homedir())
  const timeoutMs = options.timeoutMs ?? BASH_TIMEOUT_MS
  const maxStreamBytes = options.maxStreamBytes ?? MAX_STREAM_BYTES

  const proc = Bun.spawn([SANDBOX_EXEC, "-p", buildProfile({ rootDir, tmpDir, home }), "/bin/bash", "-c", command], {
    cwd: rootDir,
    // stdin is /dev/null, so a bare `cat` gets EOF instead of hanging.
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    // Allowlist: the parent's env holds OPENAI_API_KEY.
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin:/usr/sbin:/sbin",
      HOME: home,
      LANG: process.env.LANG ?? "en_US.UTF-8",
      TERM: process.env.TERM ?? "dumb",
      TMPDIR: tmpDir,
    },
  })

  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    proc.kill("SIGKILL")
  }, timeoutMs)

  const out = capture(proc.stdout, maxStreamBytes)
  const err = capture(proc.stderr, maxStreamBytes)

  await proc.exited
  clearTimeout(timer)

  // A leftover grandchild (`sleep 100 &`) can keep the pipes open; don't wait for it.
  await Promise.race([Promise.all([out.done, err.done]), Bun.sleep(PIPE_GRACE_MS)])
  await Promise.all([out.cancel(), err.cancel()])

  return {
    exitCode: proc.exitCode ?? -1,
    stdout: out.text(),
    stderr: err.text(),
    truncated: out.truncated() || err.truncated(),
    timedOut,
  }
}
