import { afterAll, beforeAll, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import { runBash } from "../src/bash.js"
import { MAX_STREAM_BYTES } from "../src/sandbox.js"

// Real sandbox-exec, so macOS only.
const sandboxTest = process.platform === "darwin" ? test : test.skip

let root: string
let home: string

beforeAll(async () => {
  const base = await realpath(await mkdtemp(join(tmpdir(), "harness-sandbox-")))
  root = join(base, "project")
  home = join(base, "home")
  await mkdir(root, { recursive: true })
  await mkdir(join(home, ".ssh"), { recursive: true })
  await writeFile(join(home, ".ssh", "key"), "PRIVATE")
  await writeFile(join(root, "hello.txt"), "hello from the project\n")
  await writeFile(join(root, ".env"), "SECRET=1\n")
  await writeFile(join(root, ".env.example"), "SECRET=\n")
  await symlink(join(home, ".ssh"), join(root, "ssh-link"))
})

afterAll(async () => {
  await rm(join(root, ".."), { recursive: true, force: true })
})

type Run = { exit_code: number; stdout: string; stderr: string; truncated: boolean; timed_out: boolean }

async function run(command: string, extra: Record<string, unknown> = {}) {
  const result = await runBash(JSON.stringify({ command }), { rootDir: root, home, ...extra })
  if (!result.ok) throw new Error(`harness failure: ${result.error}`)
  return { run: JSON.parse(result.output) as Run, summary: result.summary }
}

sandboxTest("reads and writes inside the project work", async () => {
  const { run: r, summary } = await run("cat hello.txt && echo written > out.txt && cat out.txt")
  expect(r.exit_code).toBe(0)
  expect(r.stdout).toBe("hello from the project\nwritten\n")
  expect(summary).toMatch(/^exit 0 · \d+ms$/)
})

sandboxTest("a write outside the project and temp dir is denied", async () => {
  const target = join(homedir(), `.harness-sandbox-probe-${process.pid}`)
  try {
    const { run: r } = await run(`echo nope > ${target}`)
    expect(r.exit_code).not.toBe(0)
    expect(r.stderr).toContain("Operation not permitted")
    expect(existsSync(target)).toBe(false)
  } finally {
    await rm(target, { force: true })
  }
})

sandboxTest("credential paths and .env are unreadable, .env.example is readable", async () => {
  const ssh = await run("cat ~/.ssh/key")
  expect(ssh.run.exit_code).not.toBe(0)
  expect(ssh.run.stdout).not.toContain("PRIVATE")
  expect(ssh.run.stderr).toContain("Operation not permitted")

  const env = await run("cat .env")
  expect(env.run.exit_code).not.toBe(0)
  expect(env.run.stdout).not.toContain("SECRET=1")

  const example = await run("cat .env.example")
  expect(example.run.exit_code).toBe(0)
  expect(example.run.stdout).toBe("SECRET=\n")
})

sandboxTest("a symlink inside the project does not reach a denied path", async () => {
  const { run: r } = await run("cat ssh-link/key")
  expect(r.exit_code).not.toBe(0)
  expect(r.stdout).not.toContain("PRIVATE")
})

sandboxTest("network access fails, even to localhost", async () => {
  let hits = 0
  const server = Bun.serve({
    port: 0,
    fetch() {
      hits += 1
      return new Response("reached")
    },
  })
  try {
    const { run: r } = await run(`curl -sS -m 5 http://127.0.0.1:${server.port}/`)
    expect(r.exit_code).not.toBe(0)
    expect(r.stdout).not.toContain("reached")
    expect(hits).toBe(0)
  } finally {
    await server.stop(true)
  }
})

sandboxTest("a command that outlives the timeout is killed and reported", async () => {
  const { run: r, summary } = await run("sleep 10", { timeoutMs: 300 })
  expect(r.timed_out).toBe(true)
  expect(summary).toMatch(/^timed out · \d+ms$/)
})

sandboxTest("output is capped at 16 KiB per stream and flagged", async () => {
  const { run: r } = await run("yes | head -c 100000")
  expect(r.truncated).toBe(true)
  expect(r.stdout.length).toBe(MAX_STREAM_BYTES)
})

sandboxTest("the child does not inherit the parent's environment", async () => {
  process.env.HARNESS_CANARY = "canary-value"
  try {
    const { run: r } = await run("env")
    expect(r.stdout).not.toContain("canary-value")
    expect(r.stdout).toContain(`HOME=${home}`)
  } finally {
    delete process.env.HARNESS_CANARY
  }
})

sandboxTest("stdin is EOF, so a bare cat returns instead of hanging", async () => {
  const started = performance.now()
  const { run: r } = await run("cat", { timeoutMs: 10_000 })
  expect(r.timed_out).toBe(false)
  expect(r.exit_code).toBe(0)
  expect(performance.now() - started).toBeLessThan(5_000)
})

sandboxTest("a background job holding the pipes open does not hang the call", async () => {
  const started = performance.now()
  const { run: r } = await run("sleep 5 & echo started", { timeoutMs: 10_000 })
  expect(r.stdout).toBe("started\n")
  expect(performance.now() - started).toBeLessThan(3_000)
})

sandboxTest("a non-zero exit is a normal result, not a harness failure", async () => {
  const { run: r, summary } = await run("echo oops >&2; exit 3")
  expect(r.exit_code).toBe(3)
  expect(r.stderr).toBe("oops\n")
  expect(summary).toMatch(/^exit 3 · /)
})

test("invalid arguments are a harness failure with a structured error", async () => {
  const bad = await runBash("{not json", { rootDir: root })
  expect(bad).toMatchObject({ ok: false, error: "arguments must be valid JSON" })
  const empty = await runBash(JSON.stringify({ command: "" }), { rootDir: root })
  expect(empty).toMatchObject({ ok: false, error: "command must not be empty" })
})
