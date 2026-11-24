/** A change and all its operands, in Git's order (old then new for a rename or copy). */
export interface Change {
  readonly status: string
  readonly paths: ReadonlyArray<string>
}

/** The fields of Git's -z protocols. A path can contain every separator except NUL. */
const terminated = Schema.decodeUnknownSync(Schema.String.check(Schema.isPattern(/\0$/)))
const statusField = Schema.decodeUnknownSync(Schema.String.check(Schema.isPattern(/^(?:[ADMTUXB]|[MRC]\d+)$/)))
const pathname = Schema.decodeUnknownSync(Schema.NonEmptyString)

// The workspace APIs take strings. Fail closed on a pathname the APIs cannot
// represent rather than silently selecting for a replacement character.
const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true })
export const decodeGitPaths = (bytes: ArrayBuffer | Uint8Array): string => utf8.decode(bytes)

export const decodeGitPathChunks = (chunks: ReadonlyArray<Uint8Array>): string => {
  const bytes = new Uint8Array(chunks.reduce((size, chunk) => size + chunk.length, 0))
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.length
  }
  return decodeGitPaths(bytes)
}

export const nulFields = (out: string): ReadonlyArray<string> => {
  if (out === "") return []
  return terminated(out).slice(0, -1).split("\0")
}

/** `git diff --name-status -z`: one status field, then one or two unquoted path fields. */
export const parseNameStatus = (out: string): ReadonlyArray<Change> => {
  const fields = nulFields(out)
  const changes = new Array<Change>()
  for (let index = 0; index < fields.length;) {
    const word = statusField(fields[index++])
    const status = word.slice(0, 1)
    const paths = [pathname(fields[index++])]
    if (status === "R" || status === "C") paths.push(pathname(fields[index++]))
    changes.push({ status, paths })
  }
  return changes
}
import { Schema } from "effect"
