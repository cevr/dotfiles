/**
 * The ratchet on parsing run state from prose (the commitments spec, "Parsers of run state"): every regular expression
 * (a literal, `RegExp(…)` with or without `new`, a string `.match`/`.matchAll`/`.search`, a `.split` on a marker line) in a non-test source of orchestrate, status, the queue's stale check and the orchestrate
 * skill's scripts is an entry of `no-prose-state.allow.json` ({ file, source, why, until }), and every entry is an
 * expression there. A new parser fails here until it is listed with why and until which unit; each unit of the
 * program shrinks the list, and the last ends with only `stays` entries.
 *
 * It finds its sources by walking, not import, so it declares them for the gate's selection (scripts/reach.ts `readsOf`):
 * @reads mods/orchestrate/** mods/status/** mods/queue/stale.ts ../skills/orchestrate/scripts/** scripts/no-prose-state.allow.json
 */
import * as BunServices from "@effect/platform-bun/BunServices"
import { Array as Arr, Effect, FileSystem, Option, Path, Predicate, Schema } from "effect"
import { describe, expect, it } from "effect-bun-test"
import { parseSync, Visitor } from "oxc-parser"


/** The folders and files the ratchet watches, relative to the repository (the parent of opencode/, where the gate runs the suite). */
const ROOTS = ["opencode/mods/orchestrate", "opencode/mods/status", "opencode/mods/queue/stale.ts", "skills/orchestrate/scripts"]

const Entry = Schema.Struct({
  file: Schema.String,
  source: Schema.String,
  why: Schema.String,
  until: Schema.Literals(["triggers-wake", "hand-back-tools", "verdict-tools", "parsers-out", "stays"]),
})
type Entry = typeof Entry.Type
const decodeAllow = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Array(Entry)))

/** A source the ratchet reads: TypeScript, not a test, not a dependency. */
const isSource = (name: string) => /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)

/** The repository's root and the allow list: the list's paths are relative to the root. */
const places = Effect.gen(function* () {
  const path = yield* Path.Path
  const opencode = path.resolve(".")
  return { repo: path.join(opencode, ".."), allow: path.join(opencode, "scripts", "no-prose-state.allow.json") }
})

/** Every source under `at` (a file or a directory), relative to the repository. */
const sourcesUnder = (repo: string, at: string): Effect.Effect<ReadonlyArray<string>, unknown, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const full = path.join(repo, at)
    if ((yield* fs.stat(full)).type !== "Directory") return [at]
    const names = (yield* fs.readDirectory(full)).filter((name) => name !== "node_modules")
    const each = yield* Effect.forEach(names, (name) =>
      Effect.gen(function* () {
        const child = path.join(at, name)
        if ((yield* fs.stat(path.join(repo, child))).type === "Directory") return yield* sourcesUnder(repo, child)
        return Arr.filter([child], () => isSource(name))
      }),
    )
    return each.flat()
  })


/** The string methods that take their string argument as a regular expression. */
const MATCHING = ["match", "matchAll", "search"]

/** A string argument's text: a plain string literal's value, or a template's raw text; none for anything else. */
const stringOf = (node: { readonly type: string }): Option.Option<string> => {
  if (node.type === "Literal" && "value" in node && Predicate.isString(node.value)) return Option.some(node.value)
  if (node.type === "TemplateLiteral" && "quasis" in node && Array.isArray(node.quasis)) return Option.some(node.quasis.map((quasi: { value: { raw: string } }) => quasi.value.raw).join("${}"))
  return Option.none()
}

/** A marker line: a split on text that holds a line break and something else (`"\n## Verdict\n"`), not on a bare line break. */
const isMarker = (text: string): boolean => /[\n]|\\n/.test(text) && text.replace(/\\n|\n|\r|\\r/g, "").trim() !== ""

/**
 * The regular expressions of one source, each by its text: a literal, a `RegExp(…)` call with or without `new`, a
 * string `.match`, `.matchAll` or `.search` (each makes its string a regular expression), and a `.split` on a marker line.
 */
const expressionsOf = (file: string, text: string): ReadonlyArray<string> => {
  const found = new Set<string>()
  const isRegExp = (callee: { readonly type: string }) => callee.type === "Identifier" && "name" in callee && callee.name === "RegExp"
  new Visitor({
    Literal: (node) => {
      if ("regex" in node && node.regex) found.add(text.slice(node.start, node.end))
    },
    NewExpression: (node) => {
      if (isRegExp(node.callee)) found.add(text.slice(node.start, node.end))
    },
    CallExpression: (node) => {
      if (isRegExp(node.callee)) found.add(text.slice(node.start, node.end))
      if (node.callee.type !== "MemberExpression" || node.callee.computed || node.callee.property.type !== "Identifier") return
      const method = node.callee.property.name
      const first = Option.flatMap(Option.fromUndefinedOr(node.arguments[0]), stringOf)
      if (MATCHING.includes(method) && Option.isSome(first)) found.add(text.slice(node.start, node.end))
      if (method === "split" && Option.exists(first, isMarker)) found.add(text.slice(node.start, node.end))
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

/** The watched sources (file → text) and the allow list. */
const read = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const { repo, allow } = yield* places
  const files = (yield* Effect.forEach(ROOTS, (root) => sourcesUnder(repo, root))).flat()
  const texts = yield* Effect.forEach(files, (file) => Effect.map(fs.readFileString(path.join(repo, file)), (text) => [file, text] as const))
  const sources: ReadonlyMap<string, string> = new Map(texts)
  return { sources, allow: yield* decodeAllow(yield* fs.readFileString(allow)) }
})

describe("no run state parsed from prose", () => {
  it.live.layer(BunServices.layer)("every expression in the watched sources has an entry, and every entry an expression", () =>
    Effect.gen(function* () {
      const { sources, allow } = yield* read
      expect(ratchet(sources, allow)).toEqual({ unlisted: [], stale: [] })
    }),
  )

  it.live.layer(BunServices.layer)("each entry says why, and nothing is listed twice", () =>
    Effect.gen(function* () {
      const { allow: entries } = yield* read
      expect(entries.filter((entry) => entry.why.trim().length < 20)).toEqual([])
      expect(entries.length).toBe(new Set(entries.map((entry) => keyOf(entry.file, entry.source))).size)
    }),
  )

  it.live.layer(BunServices.layer)("a new expression in record.ts, in a scratch copy, fails until listed; a listed one gone fails too", () =>
    Effect.gen(function* () {
      const { sources: all, allow } = yield* read
      const record = "opencode/mods/orchestrate/record.ts"
      const text = Option.getOrElse(Option.fromUndefinedOr(all.get(record)), () => "")
      const added = new Map([...all, [record, `${text}\nexport const verdictOf = (line: string) => /verdict: (\\w+)/.exec(line)\n`]])
      expect(ratchet(added, allow)).toEqual({ unlisted: [{ file: record, source: "/verdict: (\\w+)/" }], stale: [] })
      // The other parsers a parser takes, each caught: a string match, a split on a marker line, RegExp called without new.
      const parsers = [
        'text.match("Verdict: ([A-Z]+)")',
        'text.matchAll(`round-${n}-request`)',
        'text.search("^Head: ")',
        'text.split("\\n## Verdict\\n")',
        'RegExp("^Verdict: (\\\\w+)", "m")',
      ]
      const parsed = new Map([...all, [record, `${text}\n${parsers.map((parser, at) => `export const parser${at} = (text: string, n: number) => ${parser}`).join("\n")}\n`]])
      expect(ratchet(parsed, allow).unlisted.map((each) => each.source)).toEqual(parsers)
      // A bare line split, a plain replace and a string's own methods are no parsers of state.
      const plain = new Map([...all, [record, `${text}\nexport const lines = (text: string) => [text.split("\\n"), text.replace("a", "b"), text.startsWith("x")]\n`]])
      expect(ratchet(plain, allow).unlisted).toEqual([])
      const gone = new Map([...all, [record, ""]])
      expect(ratchet(gone, allow).stale.map((each) => each.file)).toEqual(expect.arrayContaining([record]))
    }),
  )
})
