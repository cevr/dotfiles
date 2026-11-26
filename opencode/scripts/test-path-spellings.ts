import { Effect, Path, Schema } from "effect"
import { alternatives } from "./read-declarations.ts"

const path = Effect.runSync(Effect.provide(Path.Path, Path.layer))
const quoted = Schema.encodeSync(Schema.fromJsonString(Schema.String))
const folded = (file: string) => file.normalize("NFC").toLowerCase()
const clean = (file: string) => path.normalize(file).replace(/\/$/, "") || "."
const entries = (file: string) => {
  const result = [file]
  for (let dir = path.dirname(file); dir !== "." && dir !== ".." && dir !== "/"; dir = path.dirname(dir)) result.push(dir)
  return result
}

const expanded = (pattern: string): ReadonlyArray<string> => {
  const branches = alternatives(pattern)
  return (branches.length > 0 && branches.flatMap(expanded)) || [pattern]
}

/** Git is the source of spelling and also supplies directory spellings. Never let disk folding pick between collisions. */
export const trackedSpellings = (names: ReadonlyArray<string>, lookup: (file: string) => string) => {
  const exact = new Set(names.flatMap(entries))
  const buckets = new Map<string, Set<string>>()
  for (const name of exact) {
    const key = folded(name)
    const choices = buckets.get(key) || new Set<string>()
    choices.add(name)
    buckets.set(key, choices)
  }
  return (input: string) => {
    const file = clean(input)
    const candidates = [...(buckets.get(folded(file)) || [])]
    if (candidates.length > 1) return { file, candidates, ambiguous: true, rejected: !exact.has(file) }
    if (exact.has(file)) return { file, candidates: [], ambiguous: false, rejected: false }
    const known = candidates[0]
    if (known) return { file, candidates, ambiguous: false, rejected: true }
    const actual = lookup(file)
    if (!actual || actual === file) return { file, candidates: [], ambiguous: false, rejected: false }
    if (exact.has(actual)) return { file, candidates: [actual], ambiguous: false, rejected: true }
    const onDisk = [...(buckets.get(folded(actual)) || [])]
    return { file, candidates: onDisk, ambiguous: onDisk.length !== 1, rejected: true }
  }
}

export type TrackedSpellings = ReturnType<typeof trackedSpellings>

const patternParts = (pattern: string) => {
  const parts = pattern.split("/")
  const glob = parts.findIndex((part) => /[*?[\]{}]/.test(part))
  if (glob < 0) return { anchor: pattern, suffix: "" }
  return { anchor: parts.slice(0, glob).join("/"), suffix: parts.slice(glob).join("/") }
}

const resolvedName = (fact: ReturnType<TrackedSpellings>) => fact.candidates[0] || fact.file

export const spellingReads = (
  resolve: TrackedSpellings, patterns: ReadonlyArray<string>, observed: ReadonlyArray<string>, literals: ReadonlyArray<string> = [],
) => {
  const names = observed.map((file) => ({ fact: resolve(file), suffix: (file.endsWith("/") && "/") || "" }))
  const literalNames = literals.map((file) => ({ fact: resolve(file), suffix: "" }))
  const literalsSet = new Set(literals)
  const scopes = patterns.flatMap((file) => (literalsSet.has(file) && []) || expanded(file))
    .values().filter((file) => !literalsSet.has(file)).map(patternParts).toArray()
  const anchored = scopes.flatMap(({ anchor, suffix }) => (anchor && [{ fact: resolve(anchor), suffix }]) || [])
  const facts = [...names, ...literalNames, ...anchored].map(({ fact }) => fact)
  const rejected = facts.flatMap(({ file, candidates, rejected }) =>
    (rejected && [`read spelling ${quoted(file)} is not the tracked name${(candidates.length > 0 && `; use ${candidates.map((name) => quoted(name)).join(" or ")}`) || ""}`]) || [],
  )
  const map = ({ fact, suffix }: { fact: ReturnType<TrackedSpellings>; suffix: string }) => {
    if (fact.ambiguous && fact.candidates.length === 0) return []
    return (fact.candidates.length > 0 && fact.candidates || [fact.file]).map((file) => `${file}${suffix}`)
  }
  const checked = anchored.map(({ fact, suffix }) => [resolvedName(fact), suffix].filter(Boolean).join("/"))
  return {
    rejected: [...new Set(rejected)], ambiguous: facts.some(({ ambiguous }) => ambiguous),
    paths: names.flatMap(map), literalPaths: literalNames.flatMap(map),
    patterns: [...scopes.values().filter(({ anchor }) => !anchor).map(({ suffix }) => suffix), ...checked],
  }
}
