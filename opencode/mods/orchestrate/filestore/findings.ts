// A verifier's findings, read from its report (service.ts `Findings`). The
// report is a unit's `round-N-findings.md`, or a batch's findings file that
// names each unit's (protocol.md, Verifier: a row per unit with its findings
// path, absolute or relative to the batch file). What does not read (the
// report, a unit file it names, or a batch file naming none) is `Unread`,
// never an empty set. A unit file whose first line
// is not a `changes` verdict holds none; one that is holds each Blocker and
// Major by its id (`### M1 — …`, `- **B2** …`) under the Blockers and Major
// headings, as `<unit>/<id>`, the unit being its directory's name. A `changes`
// file with no id is one finding, the unit's own.
import { readFileSync } from "node:fs"
import * as TuiDirs from "@dotfiles/decider/tui-dirs"
import { basename, dirname, isAbsolute, join, resolve } from "node:path"
import { Effect, Layer } from "effect"
import { Findings, type FindingsRead } from "../service.ts"

const UNIT_FILE = /^round-\d+-findings\.md$/
const UNIT_PATH = /[^\s`'"()[\]<>|]*round-\d+-findings\.md/g
const HEADING = /^#{1,6}\s*\**\s*(blockers?|majors?|minor|optional|test strength|unproven|on base|rejected|receipts|check|repeat)\b/i
const ID = /^(?:#{1,6}\s*|[-*]\s*)?\**\s*([BM]\d+)\b/

/** A unit file's findings: none unless its verdict is `changes`. */
export const unitFindings = (unit: string, text: string): ReadonlyArray<string> => {
  const lines = text.split("\n")
  const first = lines.find((line) => line.trim() !== "") ?? ""
  if (!/changes/i.test(first)) return []
  const ids: Array<string> = []
  let failing = false
  for (const line of lines) {
    const heading = HEADING.exec(line)?.[1]
    if (heading !== undefined) {
      failing = /^(blocker|major)/i.test(heading)
      continue
    }
    const id = failing ? ID.exec(line.trim())?.[1] : undefined
    if (id !== undefined && !ids.includes(id)) ids.push(id)
  }
  return ids.length === 0 ? [unit] : ids.map((id) => `${unit}/${id}`)
}

const expand = (path: string, from: string) => {
  const home = path.startsWith("~/") ? join(TuiDirs.dirs().home, path.slice(2)) : path
  return isAbsolute(home) ? home : resolve(from, home)
}

/**
 * The findings `report` holds, reading files with `read`. `Unread` when the
 * report does not read, names no unit's findings file, or names one that does
 * not read: what is not read is never taken for no findings.
 */
export const findingsIn = (report: string, read: (path: string) => string | undefined): FindingsRead => {
  const path = expand(report, process.cwd())
  const text = read(path)
  if (text === undefined) return { _tag: "Unread", why: `the report ${path} does not read` }
  if (UNIT_FILE.test(basename(path))) return { _tag: "Read", findings: unitFindings(basename(dirname(path)), text) }
  const units = [...new Set((text.match(UNIT_PATH) ?? []).map((found) => expand(found, dirname(path))))]
  if (units.length === 0) return { _tag: "Unread", why: `the report ${path} names no unit's round-N-findings.md` }
  const findings: Array<string> = []
  const missing: Array<string> = []
  for (const unit of units) {
    const found = read(unit)
    if (found === undefined) missing.push(unit)
    else findings.push(...unitFindings(basename(dirname(unit)), found))
  }
  return missing.length === 0 ? { _tag: "Read", findings } : { _tag: "Unread", why: `the unit findings ${missing.length === 1 ? "file" : "files"} ${missing.join(", ")} of ${path} ${missing.length === 1 ? "does" : "do"} not read` }
}

const readText = (path: string) => {
  try {
    return readFileSync(path, "utf8")
  } catch {
    return undefined
  }
}

export const layer = Layer.succeed(Findings, { read: (report) => Effect.sync(() => findingsIn(report, readText)) })
