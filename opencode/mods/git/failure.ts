// What a failing GitHub Actions job's log says: the tests it names as failing
// and an excerpt around the first failure, so an agent reads the cause in the
// `pr` tool's answer instead of fetching the log by hand. The log is the raw
// text `actions/jobs/<id>/logs` answers: each line opens with a timestamp,
// and colours are ANSI escapes.
import type { JobFailure } from "./report.ts"

/** How many lines an excerpt holds. */
export const EXCERPT_LINES = 20
/** How many failing tests one job names at most. */
export const MOST_TESTS = 10

const STAMP = /^\uFEFF?\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z ?/
// oxlint-disable-next-line no-control-regex -- the escapes are what is stripped
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g

/** A log line without its timestamp and colours. */
export const plain = (line: string): string => line.replace(STAMP, "").replace(ANSI, "").trimEnd()

/**
 * The test a line names as failing, by the runners' words: bun's `(fail)`,
 * vitest's and jest's `×`/`✕`/`✗`, jest's `FAIL <file>`, TAP's `not ok`, Go's
 * `--- FAIL:`. A timing in brackets or parentheses at its end is dropped.
 */
export const failingTest = (line: string): string | undefined => {
  const text = line.trim()
  const match =
    /^\(fail\) (.+)$/.exec(text) ??
    /^[×✕✗] (.+)$/.exec(text) ??
    /^FAIL (\S.*)$/.exec(text) ??
    /^not ok \d+ (?:- )?(.+)$/.exec(text) ??
    /^--- FAIL: (\S+)/.exec(text)
  if (match === null) return undefined
  const name = (match[1] ?? "").replace(/\s+[[(]\d+(?:\.\d+)?\s*m?s[\])]$/, "").trim()
  return name.length === 0 ? undefined : name
}

const ERROR = /^##\[error\]/
const GROUP = /^##\[(?:group|endgroup)\]/
/** A passing or skipped test's line, which an excerpt leaves out. */
const PASSED = /^(?:\(pass\)|\(skip\)|✓|√|ok \d)/

/** How many indented lines under a failing test the excerpt keeps. */
export const DETAIL_LINES = 3

/**
 * The tests a job's log names as failing (each once, in order, at most
 * MOST_TESTS) and an excerpt of at most EXCERPT_LINES: each failing test's
 * line with up to DETAIL_LINES indented lines under it, and each `##[error]`
 * line, in log order; with neither, the log's last lines. Group markers,
 * passing tests and blank lines are left out of the excerpt.
 */
export const jobFailure = (check: string, log: string): JobFailure => {
  const lines = log.split(/\r?\n/).map(plain)
  const tests: Array<string> = []
  for (const line of lines) {
    const name = failingTest(line)
    if (name !== undefined && !tests.includes(name) && tests.length < MOST_TESTS) tests.push(name)
  }
  const shown = (line: string) => line.trim().length > 0 && !GROUP.test(line) && !PASSED.test(line.trim())
  // Parallel runners interleave their output, so the excerpt is the failing
  // tests' own lines (each with the indented detail under it) and the errors,
  // not a block of the log.
  const picked = new Set<number>()
  lines.forEach((line, index) => {
    if (ERROR.test(line)) picked.add(index)
    if (failingTest(line) === undefined) return
    picked.add(index)
    for (let next = index + 1; next < lines.length && next <= index + DETAIL_LINES && /^\s{2,}\S/.test(lines[next] ?? ""); next++) picked.add(next)
  })
  const excerpt =
    picked.size > 0
      ? [...picked].sort((left, right) => left - right).map((index) => lines[index] ?? "").filter(shown).slice(0, EXCERPT_LINES)
      : lines.filter(shown).slice(-EXCERPT_LINES)
  return { check, tests, excerpt: excerpt.map((line) => line.replace(ERROR, "error: ")) }
}

/** A failing check whose log could not be read: why, in its place. */
export const unread = (check: string, note: string): JobFailure => ({ check, tests: [], excerpt: [], note })
