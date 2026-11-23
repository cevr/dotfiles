import { Glob } from "bun"

export const ALL_READS = "all"
// Direct reads name files or globs. Indirect reads assert the complete scope
// of an opaque operation. If that scope is not known, use the sentinel alone.
const READS = /^\s*(?:\/\/|\*)\s*@reads(-indirect)?[ \t]+(.+?)\s*$/gm

export const readDeclarations = (source: string) => [...source.matchAll(READS)].flatMap((match) => {
  const indirect = match[1] === "-indirect"
  return String(match[2]).split(/\s+/).map((pattern) => ({ pattern, indirect }))
})

export const readsOf = (source: string): ReadonlyArray<string> => readDeclarations(source).map(({ pattern }) => pattern)

/** A selector never treats the unknown-input sentinel as a literal filename. */
export const readMatcher = (patterns: ReadonlyArray<string>) => {
  if (patterns.includes(ALL_READS)) return () => true
  const globs = patterns.map((pattern) => new Glob(pattern))
  return (file: string) => globs.some((glob) => glob.match(file))
}
