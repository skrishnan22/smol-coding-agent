import { lstat, readFile as readFileBytes, realpath } from "node:fs/promises"
import { isAbsolute, relative, resolve, sep } from "node:path"
import { z } from "zod"

export const MAX_READ_FILE_BYTES = 32 * 1024

const argumentsSchema = z
  .object({
    path: z.string().min(1, "path must not be empty"),
  })
  .strict()

export type ReadFileSuccess = {
  ok: true
  /** JSON string sent back to the model as function_call_output. */
  output: string
  path: string
  bytes: number
}

export type ReadFileFailure = {
  ok: false
  /** Structured error JSON still returned to the model. */
  output: string
  error: string
}

export type ReadFileResult = ReadFileSuccess | ReadFileFailure

export type ReadFileOptions = {
  /** Startup directory the relative path is rooted at. */
  rootDir: string
}

function failure(error: string): ReadFileFailure {
  return {
    ok: false,
    error,
    output: JSON.stringify({ error }),
  }
}

/**
 * Validate and read one relative UTF-8 file under rootDir.
 * Returns a model-facing JSON string for both success and failure.
 */
export async function readFile(rawArguments: string, options: ReadFileOptions): Promise<ReadFileResult> {
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

  const requestedPath = args.data.path
  if (isAbsolute(requestedPath)) {
    return failure("path must be relative to the startup directory")
  }

  const rootDir = await realpath(options.rootDir)
  const candidate = resolve(rootDir, requestedPath)
  const unresolvedRelative = relative(rootDir, candidate)
  if (
    unresolvedRelative.startsWith(`..${sep}`) ||
    unresolvedRelative === ".." ||
    isAbsolute(unresolvedRelative)
  ) {
    return failure("path escapes the startup directory")
  }

  let stats
  try {
    stats = await lstat(candidate)
  } catch {
    return failure(`file not found: ${requestedPath}`)
  }

  if (stats.isSymbolicLink()) {
    let target: string
    try {
      target = await realpath(candidate)
    } catch {
      return failure(`file not found: ${requestedPath}`)
    }
    const relativeToRoot = relative(rootDir, target)
    if (relativeToRoot.startsWith(`..${sep}`) || relativeToRoot === ".." || isAbsolute(relativeToRoot)) {
      return failure("path escapes the startup directory")
    }
  }

  let realTarget: string
  try {
    realTarget = await realpath(candidate)
  } catch {
    return failure(`file not found: ${requestedPath}`)
  }

  const relativeToRoot = relative(rootDir, realTarget)
  if (relativeToRoot.startsWith(`..${sep}`) || relativeToRoot === ".." || isAbsolute(relativeToRoot)) {
    return failure("path escapes the startup directory")
  }

  const finalStats = await lstat(realTarget)
  if (!finalStats.isFile()) {
    return failure("path must refer to a regular file")
  }

  if (finalStats.size > MAX_READ_FILE_BYTES) {
    return failure(`file exceeds ${MAX_READ_FILE_BYTES} byte limit`)
  }

  const bytes = await readFileBytes(realTarget)
  if (bytes.byteLength > MAX_READ_FILE_BYTES) {
    return failure(`file exceeds ${MAX_READ_FILE_BYTES} byte limit`)
  }

  let content: string
  try {
    content = new TextDecoder("utf-8", { fatal: true }).decode(bytes)
  } catch {
    return failure("file is not valid UTF-8 text")
  }

  const normalizedPath = relativeToRoot.split(sep).join("/")
  const payload = {
    path: normalizedPath,
    bytes: bytes.byteLength,
    content,
  }

  return {
    ok: true,
    path: normalizedPath,
    bytes: bytes.byteLength,
    output: JSON.stringify(payload),
  }
}
