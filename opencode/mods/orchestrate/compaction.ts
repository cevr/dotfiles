// The compaction window each agent kind runs at: the orchestrate tuner's
// compact.json `windows` when present, else the defaults. The same file the
// Claude Code status mod reads, so both hosts compact at the same sizes. And
// what every compaction keeps word for word.
import { Option, Schema } from "effect"
import { RENAMED } from "./role.ts"

export const ROOT = "root"
export type Kind = "planner" | "implementor" | "verifier" | "worker" | typeof ROOT
export type Windows = Readonly<Record<Kind, number>>

export const DEFAULTS: Windows = {
  planner: 400e3,
  implementor: 400e3,
  verifier: 400e3,
  worker: 200e3,
  root: 400e3,
}

/** The largest window each role runs at, whatever the tuner says. Root has no cap. */
const MAX: Readonly<Partial<Record<Kind, number>>> = { planner: 400e3, implementor: 400e3, verifier: 400e3, worker: 200e3 }

const KINDS = Object.keys(DEFAULTS) as Kind[]
const isKind = (name: string): name is Kind => (KINDS as string[]).includes(name)

const File = Schema.fromJsonString(Schema.Struct({ windows: Schema.optional(Schema.Unknown) }))

/**
 * compact.json's valid `windows`: a whole count of tokens up to 1M. A former
 * kind name's window counts for its current name unless that has its own.
 * None when the text is not such a file.
 */
export const parseWindows = (text: string): Option.Option<Partial<Record<Kind, number>>> =>
  Schema.decodeUnknownOption(File)(text).pipe(
    Option.map((file) => {
      const windows = typeof file.windows === "object" && file.windows !== null ? file.windows : {}
      const valid = Object.entries(windows).filter(
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
    }),
  )

/** Each kind's window: compact.json's, capped, else the default. No file, or a broken one, gives the defaults. */
export const windowsOf = (text: string | undefined): Windows => {
  const tuned = text === undefined ? {} : Option.getOrElse(parseWindows(text), () => ({}))
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

/** The keep-list as the user message the compaction request carries after the conversation, before the summary prompt. */
export const keepMessage = (): { role: "user"; content: Array<{ type: "text"; text: string }> } => ({
  role: "user",
  content: [{ type: "text", text: KEEP }],
})
