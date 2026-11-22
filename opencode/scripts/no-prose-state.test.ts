/**
 * The ratchet on parsing run state from prose (the commitments spec, "Parsers of run state"): every regular expression
 * (a literal or `new RegExp`) in a non-test source of orchestrate, status, the queue's stale check and the orchestrate
 * skill's scripts is an entry of `no-prose-state.allow.json` ({ file, source, why, until }), and every entry is an
 * expression there. A new parser fails here until it is listed with why and until which unit; each unit of the
 * program shrinks the list, and the last ends with only `stays` entries.
 *
 * It finds its sources by walking, not import, so it declares them for the gate's selection (scripts/reach.ts `readsOf`):
 * @reads mods/orchestrate/** mods/status/** mods/queue/stale.ts ../skills/orchestrate/scripts/** scripts/no-prose-state.allow.json
 */
import { describe, expect, test } from "bun:test"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"
import { Array as Arr, Option, Schema } from "effect"
import { parseSync, Visitor } from "oxc-parser"

/** The repository's root: the allow list's paths are relative to it. The suite runs from opencode/, as the gate runs it. */
const OPENCODE = process.cwd()
const REPO = join(OPENCODE, "..")
const ROOTS = ["opencode/mods/orchestrate", "opencode/mods/status", "opencode/mods/queue/stale.ts", "skills/orchestrate/scripts"]
const ALLOW = join(OPENCODE, "scripts", "no-prose-state.allow.json")

const Entry = Schema.Struct({
  file: Schema.String,
  source: Schema.String,
  why: Schema.String,
  until: Schema.Literals(["triggers-wake", "hand-back-tools", "verdict-tools", "parsers-out", "stays"]),
})
type Entry = typeof Entry.Type
const decodeAllow = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Array(Entry)))

/** A source the ratchet reads: TypeScript, not a test, not a dependency. */
const isSource = (name: string) => /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)

/** Every source under `path` (a file or a directory), relative to the repository. */
const sourcesUnder = (path: string): ReadonlyArray<string> => {
  const full = join(REPO, path)
  if (!statSync(full).isDirectory()) return [path]
  return readdirSync(full)
    .filter((name) => name !== "node_modules")
    .flatMap((name) => {
      const child = join(path, name)
      if (statSync(join(REPO, child)).isDirectory()) return sourcesUnder(child)
      return Arr.filter([child], () => isSource(name))
    })
}

/** The regular expressions of one source, each by its text: a literal, or a `new RegExp(…)` call. */
const expressionsOf = (file: string, text: string): ReadonlyArray<string> => {
  const found = new Set<string>()
  new Visitor({
    Literal: (node) => {
      if ("regex" in node && node.regex) found.add(text.slice(node.start, node.end))
    },
    NewExpression: (node) => {
      if (node.callee.type === "Identifier" && node.callee.name === "RegExp") found.add(text.slice(node.start, node.end))
    },
  }).visit(parseSync(file, text).program)
  return [...found]
}

const keyOf = (file: string, source: string) => `${file}\n${source}`

/** The expressions with no entry, and the entries with no expression, over `sources` (file → text). */
const ratchet = (sources: ReadonlyMap<string, string>, allow: ReadonlyArray<Entry>) => {
  const found = [...sources].flatMap(([file, text]) => expressionsOf(file, text).map((source) => ({ file, source })))
  const listed = new Set(allow.map((entry) => keyOf(entry.file, entry.source)))
  const present = new Set(found.map((each) => keyOf(each.file, each.source)))
  return {
    unlisted: found.filter((each) => !listed.has(keyOf(each.file, each.source))),
    stale: allow.flatMap((entry) => Arr.filter([{ file: entry.file, source: entry.source }], () => !present.has(keyOf(entry.file, entry.source)))),
  }
}

const sources = (): ReadonlyMap<string, string> => new Map(ROOTS.flatMap(sourcesUnder).map((file) => [file, readFileSync(join(REPO, file), "utf8")] as const))
const allow = (): ReadonlyArray<Entry> => decodeAllow(readFileSync(ALLOW, "utf8"))

describe("no run state parsed from prose", () => {
  test("every expression in the watched sources has an entry, and every entry an expression", () => {
    expect(ratchet(sources(), allow())).toEqual({ unlisted: [], stale: [] })
  })

  test("each entry says why, and nothing is listed twice", () => {
    const entries = allow()
    expect(entries.filter((entry) => entry.why.trim().length < 20)).toEqual([])
    expect(entries.length).toBe(new Set(entries.map((entry) => keyOf(entry.file, entry.source))).size)
  })

  test("a new expression in record.ts, in a scratch copy, fails until listed; a listed one gone fails too", () => {
    const record = "opencode/mods/orchestrate/record.ts"
    const all = sources()
    const text = Option.getOrElse(Option.fromUndefinedOr(all.get(record)), () => "")
    const added = new Map([...all, [record, `${text}\nexport const verdictOf = (line: string) => /verdict: (\\w+)/.exec(line)\n`]])
    expect(ratchet(added, allow())).toEqual({ unlisted: [{ file: record, source: "/verdict: (\\w+)/" }], stale: [] })
    const gone = new Map([...all, [record, ""]])
    expect(ratchet(gone, allow()).stale.map((each) => each.file)).toEqual(expect.arrayContaining([record]))
  })
})
