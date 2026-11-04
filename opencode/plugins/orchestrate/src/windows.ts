// The compaction window each agent kind runs at: the orchestrate tuner's
// compact.json `windows` when present, else the defaults. The same file the
// Claude Code status mod reads, so both hosts compact at the same sizes.
import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { WORKER } from "./roles.ts"

export const ROOT = "root"
export type Kind = "planner" | "implementor" | "verifier" | typeof WORKER | typeof ROOT

export const DEFAULT_FILE = join(homedir(), ".cache/orchestrate/compact.json")

export const DEFAULTS: Readonly<Record<Kind, number>> = {
  planner: 400e3,
  implementor: 400e3,
  verifier: 400e3,
  worker: 200e3,
  root: 400e3,
}

/** The largest window each role runs at, whatever the tuner says. Root has no cap. */
const MAX: Readonly<Partial<Record<Kind, number>>> = { planner: 400e3, implementor: 400e3, verifier: 400e3, worker: 200e3 }

/** Former kind names → current: a former name's window counts for its current name unless that has its own. */
const RENAMED: Readonly<Record<string, Kind>> = {
  "orchestrate-worker": "worker",
  "orchestrate-planner": "planner",
  "orchestrate-implementor": "implementor",
  "orchestrate-verifier": "verifier",
  "orchestrate-reviewer": "verifier",
}

const KINDS = Object.keys(DEFAULTS) as Kind[]
const isKind = (name: string): name is Kind => (KINDS as string[]).includes(name)

/** compact.json's valid `windows`: a whole count of tokens up to 1M. */
export function parseWindows(text: string): Partial<Record<Kind, number>> {
  const parsed = JSON.parse(text) as { windows?: Record<string, unknown> }
  const valid = Object.entries(parsed.windows ?? {}).filter(
    (entry): entry is [string, number] =>
      typeof entry[1] === "number" && Number.isInteger(entry[1]) && entry[1] > 0 && entry[1] <= 1e6,
  )
  const named: Partial<Record<Kind, number>> = {}
  for (const [kind, window] of valid) if (isKind(kind)) named[kind] = window
  for (const [kind, window] of valid) {
    const current = RENAMED[kind]
    if (current) named[current] ??= window
  }
  return named
}

/** Each kind's window: the file's, capped, else the default. A missing or broken file gives the defaults. */
export function windows(file = DEFAULT_FILE): Record<Kind, number> {
  let tuned: Partial<Record<Kind, number>> = {}
  try {
    tuned = parseWindows(readFileSync(file, "utf8"))
  } catch {}
  return Object.fromEntries(
    KINDS.map((kind) => {
      const window = tuned[kind] ?? DEFAULTS[kind]
      return [kind, Math.min(window, MAX[kind] ?? window)]
    }),
  ) as Record<Kind, number>
}

/**
 * Kept word for word through every compaction, as on Claude Code: the files
 * the work depends on, where it stands and what the user asked.
 */
export const KEEP =
  "Keep these word for word: the path of every plan, log, notes or state file the work reads or writes; the current step and its next action; each instruction the user gave during the session. Name a file by its path rather than restating its contents: it can be read again."
