import { afterEach, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { MAX_READ_FILE_BYTES, readFile } from "../src/read-file.js"

let rootDir: string | undefined

afterEach(async () => {
  if (rootDir !== undefined) {
    await rm(rootDir, { recursive: true, force: true })
    rootDir = undefined
  }
})

async function makeRoot(): Promise<string> {
  rootDir = await mkdtemp(join(tmpdir(), "harness-read-file-"))
  return rootDir
}

test("reads a valid UTF-8 file under the startup directory", async () => {
  const root = await makeRoot()
  await writeFile(join(root, "notes.txt"), "hello harness", "utf8")

  const result = await readFile(JSON.stringify({ path: "notes.txt" }), { rootDir: root })

  expect(result.ok).toBe(true)
  if (!result.ok) return
  expect(result.path).toBe("notes.txt")
  expect(result.bytes).toBe(Buffer.byteLength("hello harness", "utf8"))
  expect(JSON.parse(result.output)).toEqual({
    path: "notes.txt",
    bytes: Buffer.byteLength("hello harness", "utf8"),
    content: "hello harness",
  })
})

test("rejects absolute paths and parent traversal", async () => {
  const root = await makeRoot()
  await writeFile(join(root, "notes.txt"), "hello", "utf8")

  const absolute = await readFile(JSON.stringify({ path: "/etc/passwd" }), { rootDir: root })
  expect(absolute.ok).toBe(false)
  if (absolute.ok) return
  expect(absolute.error).toContain("relative")

  const traversal = await readFile(JSON.stringify({ path: "../notes.txt" }), { rootDir: root })
  expect(traversal.ok).toBe(false)
  if (traversal.ok) return
  expect(traversal.error).toContain("escapes")
})

test("rejects a symlink that resolves outside the startup directory", async () => {
  const root = await makeRoot()
  const outside = await mkdtemp(join(tmpdir(), "harness-outside-"))
  try {
    await writeFile(join(outside, "secret.txt"), "nope", "utf8")
    await symlink(join(outside, "secret.txt"), join(root, "link.txt"))

    const result = await readFile(JSON.stringify({ path: "link.txt" }), { rootDir: root })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toContain("escapes")
  } finally {
    await rm(outside, { recursive: true, force: true })
  }
})

test("rejects a directory, oversized file, and invalid UTF-8 file", async () => {
  const root = await makeRoot()
  await mkdir(join(root, "dir"))
  await writeFile(join(root, "big.txt"), Buffer.alloc(MAX_READ_FILE_BYTES + 1))
  await writeFile(join(root, "binary.bin"), Buffer.from([0xff, 0xfe, 0xfd]))

  const directory = await readFile(JSON.stringify({ path: "dir" }), { rootDir: root })
  expect(directory.ok).toBe(false)
  if (!directory.ok) expect(directory.error).toContain("regular file")

  const oversized = await readFile(JSON.stringify({ path: "big.txt" }), { rootDir: root })
  expect(oversized.ok).toBe(false)
  if (!oversized.ok) expect(oversized.error).toContain("limit")

  const invalidUtf8 = await readFile(JSON.stringify({ path: "binary.bin" }), { rootDir: root })
  expect(invalidUtf8.ok).toBe(false)
  if (!invalidUtf8.ok) expect(invalidUtf8.error).toContain("UTF-8")
})

test("rejects empty path and malformed JSON arguments", async () => {
  const root = await makeRoot()

  const empty = await readFile(JSON.stringify({ path: "" }), { rootDir: root })
  expect(empty.ok).toBe(false)

  const malformed = await readFile("{", { rootDir: root })
  expect(malformed.ok).toBe(false)
  if (!malformed.ok) expect(malformed.error).toContain("JSON")
})
