import { appendFile, mkdir } from "node:fs/promises"
import { dirname } from "node:path"
import type { LogSink } from "./types.js"

export function createJsonlSink<Event extends object>(path: string): LogSink<Event> {
  return async (event) => {
    await mkdir(dirname(path), { recursive: true })
    await appendFile(path, `${JSON.stringify(event)}\n`, "utf8")
  }
}
