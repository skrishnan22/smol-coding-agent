import { realpath } from "node:fs/promises"
import { homedir, tmpdir } from "node:os"

export const SANDBOX_EXEC = "/usr/bin/sandbox-exec"
export const BASH_TIMEOUT_MS = 30_000
export const MAX_STREAM_BYTES = 16 * 1024

/** How long to keep draining pipes after bash exits (background jobs can hold them open). */
const PIPE_GRACE_MS = 200

export type ProfileOptions = {
  /** Resolved project directory. Writable. */
  rootDir: string
  /** Resolved temp directory. Writable. */
  tmpDir: string
  /** Resolved home directory. Credential paths under it are unreadable. */
  home: string
}

/** SBPL string literal: only backslash and double quote need escaping. */
function sbpl(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`
}

/**
 * Seatbelt profile. Starts from allow-default and subtracts, because a
 * deny-default profile would have to list every system library bash needs.
 * Rule order matters: the last matching rule wins.
 */
export function buildProfile({ rootDir, tmpDir, home }: ProfileOptions): string {
  return [
    "(version 1)",
    "(allow default)",
    // No writes anywhere...
    "(deny file-write*)",
    // ...except the project, temp, and /dev/null. /dev/tty is deliberately absent:
    // programs that open the terminal directly (editors) fail instead of grabbing the TUI.
    `(allow file-write* (subpath ${sbpl(rootDir)}) (subpath ${sbpl(tmpDir)}) (literal "/dev/null"))`,
    "(deny network*)",
    // Reads are open except credentials. The allow after the deny re-opens .env.example.
    `(deny file-read* (subpath ${sbpl(`${home}/.ssh`)}) (subpath ${sbpl(`${home}/.aws`)}) (regex #"/\\.env(\\..*)?$"))`,
    `(allow file-read* (literal ${sbpl(`${rootDir}/.env.example`)}))`,
  ].join("\n")
}

export type SandboxOptions = {
  rootDir: string
  /** Defaults to the real home directory. Tests pass a temp one. */
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

/** Keep the first `max` bytes of a stream; keep draining so the child never blocks on a full pipe. */
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

/** Run one command in a fresh `bash -c` under the Seatbelt profile. Throws if it cannot spawn. */
export async function runSandboxed(command: string, options: SandboxOptions): Promise<RawRun> {
  const rootDir = await realpath(options.rootDir)
  const tmpDir = await realpath(tmpdir())
  const home = await realpath(options.home ?? homedir())
  const timeoutMs = options.timeoutMs ?? BASH_TIMEOUT_MS
  const maxStreamBytes = options.maxStreamBytes ?? MAX_STREAM_BYTES

  const proc = Bun.spawn([SANDBOX_EXEC, "-p", buildProfile({ rootDir, tmpDir, home }), "/bin/bash", "-c", command], {
    cwd: rootDir,
    // /dev/null: reads return EOF at once, so `cat` with no file exits instead of hanging.
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    // Allowlist, not inherit: the parent's env holds OPENAI_API_KEY.
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

  // A surviving grandchild (`sleep 100 &`) can hold the pipes open. Don't wait for them.
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
