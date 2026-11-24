import { layer } from "@effect/platform-bun/BunServices"
import { $ } from "bun"
import { Data, Effect, FileSystem, Option, Path, Schema } from "effect"
import { decodeGitPaths, nulFields } from "./git-paths.ts"
import { alternatives } from "./read-declarations.ts"

const nonempty = Schema.decodeUnknownSync(Schema.NonEmptyString)
const json = Schema.encodeSync(Schema.fromJsonString(Schema.Json))
const tailUnder = (root: string, file: string) => {
  if (file === root) return Option.some("")
  if (root === "." && inside(file)) return Option.some(`/${file}`)
  if (file.startsWith(`${root}/`)) return Option.some(file.slice(root.length))
  return Option.none<string>()
}

type Target = { readonly file: string; readonly directory: boolean }
type Link = { readonly payload: string; readonly target: Option.Option<Target> }
export type LinkInputs = ReadonlyMap<string, Link>

/** Index and tree formats are both NUL-delimited; split metadata only at the first tab. */
const indexName = (entry: string) => nonempty(entry.slice(entry.indexOf("\t") + 1))

const inside = (file: string) => file !== ".." && !file.startsWith("../") && !file.startsWith("/")
const opencode = (path: Path.Path, file: string) => path.relative("opencode", file) || "."

/** Read only tracked aliases. Inspect their resolution in the checked-out filesystem, not their spelling. */
const checkoutIndex = (root: string) => Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const physical = yield* fs.realPath(root)
  const out = yield* Effect.promise(() => $`git ls-files --stage -z`.cwd(root).quiet().arrayBuffer().then(decodeGitPaths))
  const realTarget = (file: string) => Effect.gen(function* () {
    const target = yield* fs.realPath(file)
    const relative = path.relative(physical, target)
    if (!inside(relative)) return Option.none<Target>()
    const stat = yield* fs.stat(target)
    return Option.some({ file: opencode(path, relative || "."), directory: stat.type === "Directory" })
  }).pipe(Effect.catch(() => Effect.succeed(Option.none<Target>())))
  const resolve = (name: string) => Effect.gen(function* () {
    const file = path.join(physical, name)
    const payload = yield* fs.readLink(file).pipe(Effect.orElseSucceed(() => ""))
    const target = yield* (payload && realTarget(file) || Effect.succeed(Option.none<Target>()))
    return [opencode(path, name), { payload, target }] as const
  })
  const entries = nulFields(out)
  const links = new Map(yield* Effect.forEach(new Set(entries.filter((entry) => entry.startsWith("120000 ")).values().map(indexName)), resolve))
  const tracked = entries.map((entry) => opencode(path, indexName(entry)))
  return { tracked, links }
}).pipe(Effect.provide(layer), Effect.runPromise)

export const checkoutPaths = checkoutIndex
export const checkoutLinks = (root: string) => checkoutIndex(root).then(({ links }) => links)

class BadTreeLink extends Data.TaggedError("BadTreeLink")<{ readonly entry: string }> {}

const treeEntry = (entry: string) => {
  const tab = entry.indexOf("\t")
  const [mode, kind, oid] = entry.slice(0, tab).split(" ")
  if (!mode || !kind || !oid || tab < 0) return Effect.fail(new BadTreeLink({ entry }))
  return Effect.succeed({ name: entry.slice(tab + 1), mode, kind, oid })
}

/** Resolve historical links in their own tree: a retarget must retain both content operands. */
export const predecessorLinks = (root: string, base: string, changed: ReadonlyArray<string>) => Effect.gen(function* () {
  const path = yield* Path.Path
  const out = yield* Effect.promise(() => $`git ls-tree -r -t -z ${base} --`.cwd(root).quiet().arrayBuffer().then(decodeGitPaths))
  const fields = nulFields(out)
  const aliases = yield* Effect.forEach(fields.filter((entry) => entry.startsWith("120000 ")), treeEntry)
  if (!aliases.some(({ name }) => changed.includes(opencode(path, name)))) return new Map<string, Link>()
  const blobs = new Map(yield* Effect.forEach(aliases, ({ name, oid }) =>
    Effect.promise(() => $`git cat-file blob ${oid}`.cwd(root).quiet().arrayBuffer().then(decodeGitPaths))
      .pipe(Effect.map((payload) => [name, payload] as const)),
  ))
  const entries = yield* Effect.forEach(fields, treeEntry)
  const kinds = new Map(entries.map(({ name, kind }) => [name, kind]))
  return new Map(aliases.map(({ name }) => [opencode(path, name), { payload: blobs.get(name) || "", target: resolveTree(root, path, kinds, blobs, name) }]))
}).pipe(Effect.provide(layer), Effect.runPromise)

const resolveTree = (
  root: string, path: Path.Path, kinds: ReadonlyMap<string, string>, blobs: ReadonlyMap<string, string>, name: string,
) => {
  let pending = name.split("/")
  let at = root
  let followed = 0
  while (pending.length) {
    const [part = "", ...rest] = pending
    pending = rest
    at = path.resolve(at, part || ".")
    const candidate = path.relative(root, at)
    if (!inside(candidate)) continue
    const payload = blobs.get(candidate)
    if (!payload) continue
    if (++followed > 40) return Option.none<Target>()
    at = (path.isAbsolute(payload) && "/") || path.dirname(at)
    pending = [...payload.split("/"), ...pending]
  }
  const file = path.relative(root, at)
  if (!inside(file) || (file && !kinds.has(file))) return Option.none<Target>()
  return Option.some({ file: opencode(path, file || "."), directory: kinds.get(file) === "tree" || !file })
}

const below = (root: string, suffix: string) => (root === "." && suffix && suffix.slice(1)) || `${root}${suffix}`

/** Every observable spelling of this content; keep link names as inputs in their own right. */
export const linkAliases = (links: LinkInputs, file: string) => [...links].flatMap(([name, { target }]) => {
  if (Option.isNone(target)) return []
  const { file: canonical, directory } = target.value
  if (file === canonical) return [name]
  if (!directory) return []
  return Option.match(tailUnder(canonical, file), { onNone: () => [], onSome: (suffix) => [`${name}${suffix}`] })
})

const resolve = (links: LinkInputs, file: string) => {
  let canonical = file
  const seen = new Set([file])
  for (let followed = 0; followed < 40; followed++) {
    const next = nextTarget(links, canonical)
    if (seen.has(next)) break
    seen.add(next)
    canonical = next
  }
  return { canonical, seen }
}

export const linkTarget = (links: LinkInputs, file: string) => resolve(links, file).canonical

const nextTarget = (links: LinkInputs, file: string) => {
  for (const [name, { target }] of links) {
    const suffix = tailUnder(name, file)
    if (Option.isSome(suffix) && Option.isSome(target) && (target.value.directory || !suffix.value))
      return below(target.value.file, suffix.value)
  }
  return file
}

/** Match recorded spellings and resolved content, including deleted members of a linked directory. */
export const linkReads = (
  links: LinkInputs, read: (file: string) => boolean, exact: ReadonlySet<string>, scopes: ReadonlyArray<string>,
) => {
  const contains = (name: string, scope: string) => Option.isSome(tailUnder(name, scope))
  const literalRoot = (scope: string) => scope.replace(/[/]?[^/]*[*?[\]{}].*$/, "")
  const branches = (scope: string): string[] => {
    const alternativesOf = alternatives(scope)
    return alternativesOf.length > 0 && alternativesOf.flatMap(branches) || [scope]
  }
  const bounded = scopes.flatMap(branches)
  const literal = bounded.filter((scope) => literalRoot(scope) === scope)
  const resolved = [...exact, ...literal].map((file) => resolve(links, file))
  const spellings = new Set(resolved.flatMap(({ seen }) => [...seen]))
  const touches = (name: string) => read(name) || [...spellings].some((file) => contains(name, file)) ||
    bounded.some((scope) => {
      if (name.startsWith("../") !== scope.startsWith("../")) return false
      const root = literalRoot(scope)
      return contains(name, root) || (root !== scope && (!root || contains(root, name)))
    })
  const used = [...links].filter(([name]) => touches(name))
  const unsafe = used.find(([, { target }]) => Option.isNone(target))
  const canonical = new Set(resolved.flatMap(({ canonical, seen }) => (seen.size > 1 && [canonical]) || []))
  const fingerprint = json(used.map(([name, { payload, target }]) => [name, payload, Option.getOrNull(target)]).toSorted())
  const has = (file: string) => {
    const target = linkTarget(links, file)
    return read(file) || canonical.has(target) || read(target) || linkAliases(links, target).some(read)
  }
  return { has, canonical, fingerprint: (used.length > 0 && fingerprint) || "", unsafe: unsafe?.[0] }
}

/** Only selection sees these derived operands; lint and debt still see Git's actual operands. */
const closeSnapshot = (changed: Set<string>, snapshot: LinkInputs, files: ReadonlyArray<string>, known: ReadonlyArray<string>) => {
  for (const file of files) {
    const canonical = linkTarget(snapshot, file)
    changed.add(canonical)
    for (const name of linkAliases(snapshot, canonical)) changed.add(name)
    const target = snapshot.get(file)?.target
    if (target && Option.isSome(target) && target.value.directory) {
      for (const member of known) if (Option.isSome(tailUnder(target.value.file, member))) changed.add(member)
    }
  }
}

export const closeLinks = (links: LinkInputs, prior: LinkInputs, files: ReadonlyArray<string>, known: ReadonlyArray<string>) => {
  const changed = new Set(files)
  closeSnapshot(changed, links, files, known)
  closeSnapshot(changed, prior, files, known)
  for (const file of [...changed]) for (const alias of linkAliases(links, file)) changed.add(alias)
  return [...changed]
}
