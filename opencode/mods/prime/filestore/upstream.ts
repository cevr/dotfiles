// The upstream reading `bun run daily` left on this host (update.ts
// `upstreamFile`), read from the file: one small read when the TUI starts and
// on each reconnect (opencode/build.ts), never per frame. No file, or one that
// is not a reading, is none.
import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { parseUpstream, upstreamFile, type UpstreamReading } from "../update.ts"

export function readUpstream(file = upstreamFile(homedir())): UpstreamReading | undefined {
  try {
    return parseUpstream(readFileSync(file, "utf8"))
  } catch {
    return undefined
  }
}
