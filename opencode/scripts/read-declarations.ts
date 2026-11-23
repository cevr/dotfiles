import { Glob } from "bun"

export const ALL_READS = "all"
// Direct reads name files or globs. Indirect reads assert the complete scope
// of an opaque operation. If that scope is not known, use the sentinel alone.
const READS = /^\s*(?:\/\/|\*)\s*@reads(-indirect)?[ \t]+(.+?)\s*$/gm
const REASON = /^\s*(?:\/\/|\*)\s*@reads-reason[ \t]+(\S.*?)\s*$/gm

export const readDeclarations = (source: string) => [...source.matchAll(READS)].flatMap((match) => {
  const indirect = match[1] === "-indirect"
  return String(match[2]).split(/\s+/).map((pattern) => ({ pattern, indirect }))
})

export const readsOf = (source: string): ReadonlyArray<string> => readDeclarations(source).map(({ pattern }) => pattern)

export const readReasons = (source: string) => [...source.matchAll(REASON)].map((match) => String(match[1]))

export const alternatives = (glob: string) => {
  if (!glob.startsWith("{") || !glob.endsWith("}")) return []
  const parts = new Array<string>()
  let start = 1
  let depth = 0
  for (let index = start; index < glob.length - 1; index++) {
    const character = glob[index]
    if (character === "{") depth++
    if (character === "}") depth--
    if (depth < 0) return []
    if (depth === 0 && character === ",") {
      parts.push(glob.slice(start, index))
      start = index + 1
    }
  }
  if (parts.length === 0 || depth !== 0) return []
  return [...parts, glob.slice(start, -1)]
}

const compile = (pattern: string): ((file: string) => boolean) => {
  const branches = alternatives(pattern)
  if (branches.length > 0) {
    const matchers = branches.map(compile)
    return (file) => matchers.some((matches) => matches(file))
  }
  const glob = new Glob(pattern)
  const outer = pattern.startsWith("../")
  return (file) => outer === file.startsWith("../") && glob.match(file)
}

/** A selector never treats the unknown-input sentinel as a literal filename. */
export const readMatcher = (patterns: ReadonlyArray<string>) => {
  if (patterns.includes(ALL_READS)) return () => true
  const globs = patterns.map(compile)
  return (file: string) => globs.some((matches) => matches(file))
}

export const matchingReads = (source: string, files: ReadonlyArray<string>): ReadonlyArray<string> =>
  files.filter(readMatcher(readsOf(source)))
