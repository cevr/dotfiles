// The files a cell attaches, read from the local filesystem. The size is
// checked before the read, and again after it, in case the file grew between.
import { readFile, stat } from "node:fs/promises"
import { Effect, Layer } from "effect"
import { FileTooLarge, FileUnreadable } from "../attachment.ts"
import { Files } from "../service.ts"
import { messageOf } from "../tools.ts"

/** The reason a filesystem error gives the model: the common ones in words, any other as its message. */
const reasonOf = (cause: unknown): string => {
  const code = typeof cause === "object" && cause !== null && "code" in cause ? cause.code : undefined
  if (code === "ENOENT" || code === "ENOTDIR") return "no such file"
  if (code === "EACCES" || code === "EPERM") return "permission denied"
  if (code === "EISDIR") return "a directory, not a file"
  return messageOf(cause)
}

const read = Effect.fn("Files.read")(function* (path: string, limit: number) {
  const unreadable = (cause: unknown) => new FileUnreadable({ path, reason: reasonOf(cause) })
  const info = yield* Effect.tryPromise({ try: () => stat(path), catch: unreadable })
  if (info.isDirectory()) return yield* new FileUnreadable({ path, reason: "a directory, not a file" })
  if (!info.isFile()) return yield* new FileUnreadable({ path, reason: "not a regular file" })
  if (info.size > limit) return yield* new FileTooLarge({ path, bytes: info.size, limit })
  const bytes = yield* Effect.tryPromise({ try: () => readFile(path), catch: unreadable })
  if (bytes.byteLength > limit) return yield* new FileTooLarge({ path, bytes: bytes.byteLength, limit })
  return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength)
})

export const layer = Layer.succeed(Files, Files.of({ read }))
