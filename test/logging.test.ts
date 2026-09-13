import { expect, test } from "bun:test"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createJsonlSink } from "../src/logging/jsonl.js"

test("appends each wide event as one JSON line", async () => {
  const directory = await mkdtemp(join(tmpdir(), "harness-logs-"))
  const path = join(directory, "nested", "events.jsonl")

  try {
    const log = createJsonlSink<{ event: string; value: number }>(path)

    await log({ event: "first", value: 1 })
    await log({ event: "second", value: 2 })

    const lines = (await readFile(path, "utf8")).trim().split("\n")
    expect(lines).toHaveLength(2)
    expect(lines.map((line) => JSON.parse(line))).toEqual([
      { event: "first", value: 1 },
      { event: "second", value: 2 },
    ])
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
