// A verifier's findings, read from its report (service.ts `Findings`). The
// report is a unit's `round-N-findings.md`, or a batch's findings file that
// names each unit's (protocol.md, Verifier: a row per unit with its findings
// path, absolute or relative to the batch file). A unit file whose first line
// is not a `changes` verdict holds none; one that is holds each Blocker and
// Major by its id (`### M1 — …`, `- **B2** …`) under the Blockers and Major
// headings, as `<unit>/<id>`, the unit being its directory's name. A `changes`
// file with no id is one finding, the unit's own.
import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { basename, dirname, isAbsolute, join, resolve } from "node:path"
import { Effect, Layer } from "effect"
import { Findings } from "../service.ts"

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
  const home = path.startsWith("~/") ? join(homedir(), path.slice(2)) : path
  return isAbsolute(home) ? home : resolve(from, home)
}

/** The findings `report` holds, reading files with `read`; none when the report cannot be read. */
export const findingsIn = (report: string, read: (path: string) => string | undefined): ReadonlyArray<string> | undefined => {
  const path = expand(report, process.cwd())
  const text = read(path)
  if (text === undefined) return undefined
  if (UNIT_FILE.test(basename(path))) return unitFindings(basename(dirname(path)), text)
  const units = [...new Set((text.match(UNIT_PATH) ?? []).map((found) => expand(found, dirname(path))))]
  return units.flatMap((unit) => {
    const found = read(unit)
    return found === undefined ? [] : unitFindings(basename(dirname(unit)), found)
  })
}

const readText = (path: string) => {
  try {
    return readFileSync(path, "utf8")
  } catch {
    return undefined
  }
}

export const layer = Layer.succeed(Findings, { read: (report) => Effect.sync(() => findingsIn(report, readText)) })
