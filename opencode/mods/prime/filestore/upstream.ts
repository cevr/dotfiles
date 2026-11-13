// The upstream reading `bun run daily` left on this host (update.ts
// `upstreamFile`), read from the file: one small read when the TUI starts and
// on each reconnect (opencode/build.ts), never per frame. No file, or one that
// is not a reading, is none. The host's dirs come from the TUI's dirs seam
// (decider/tui-dirs.ts), never the ambient env: a simulated TUI has its own.
import { readFileSync } from "node:fs"
import * as TuiDirs from "@dotfiles/decider/tui-dirs"
import { parseUpstream, upstreamFile, type UpstreamReading } from "../update.ts"

/** Where the reading is on the host in force: its state dir's `opencode-daily/upstream.json`. */
export const upstreamPath = () => {
  const dirs = TuiDirs.dirs()
  return upstreamFile(dirs.home, dirs.state)
}

export function readUpstream(file = upstreamPath()): UpstreamReading | undefined {
  try {
    return parseUpstream(readFileSync(file, "utf8"))
  } catch {
    return undefined
  }
}
