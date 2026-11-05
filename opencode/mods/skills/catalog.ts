// The skills a `$` token can name: OpenCode's registry (the list the skill
// tool offers) with each skill's tier, which the scan knows by path. The
// composer's popup draws it, and a sent prompt's tokens resolve against it.
// The RPC the TUI reads it over is declared here too, with its answer's schema.
import { Schema } from "effect"
import type { Token } from "./mention.ts"
import { tokens } from "./mention.ts"
import { collisions, qualified, type Found, type Registered, type Tier } from "./tier.ts"

/** One skill a `$` token can name. */
export interface Entry {
  /** What follows `$` to name it: the id, or `<id>:global` for a shadowed global skill. */
  readonly token: string
  /** Its id in OpenCode's registry, which a prompt attaches: `<id>:local` for the local copy of an id both tiers hold. */
  readonly id: string
  readonly description?: string
  /** Its tier, when a scan found it; a skill a plugin or URL added has none. */
  readonly tier?: Tier
  /** A global skill a local one of the same id hides from the plain id. */
  readonly shadowed: boolean
}

/** A registered skill, as far as the catalog needs it. */
export interface Skill extends Registered {
  readonly description?: string
}

/** The base id an entry is about: `review` for both `review` and `review:global`. */
const base = (entry: Entry) => (entry.shadowed ? entry.token.slice(0, -":global".length) : entry.token)

/**
 * The registry's skills, each with its tier by path, sorted by id with the
 * local entry before the global one it shadows. An id both tiers hold is two
 * entries: `$<id>` for its local copy (`<id>:local`) and `$<id>:global` for
 * the global one; the plain id, whichever copy OpenCode kept there, is not
 * listed again.
 */
export const catalog = (registered: ReadonlyArray<Skill>, found: ReadonlyArray<Found>): ReadonlyArray<Entry> => {
  const tiers = new Map(found.map((skill) => [skill.path, skill.tier]))
  const both = collisions(found)
  const pairs = new Map([...both].flatMap((id) => [[qualified(id, "local"), id] as const, [qualified(id, "global"), id] as const]))
  const entries = registered.flatMap((skill): ReadonlyArray<Entry> => {
    if (both.has(skill.id)) return []
    const description = skill.description === undefined ? {} : { description: skill.description }
    const pair = pairs.get(skill.id)
    if (pair !== undefined && skill.id === qualified(pair, "local")) return [{ token: pair, id: skill.id, ...description, tier: "local", shadowed: false }]
    if (pair !== undefined) return [{ token: skill.id, id: skill.id, ...description, tier: "global", shadowed: true }]
    const tier = tiers.get(skill.path)
    return [{ token: skill.id, id: skill.id, ...description, ...(tier === undefined ? {} : { tier }), shadowed: false }]
  })
  return entries.toSorted((a, b) => base(a).localeCompare(base(b)) || Number(a.shadowed) - Number(b.shadowed))
}

/** The tag the popup draws at an entry's right edge. */
export const label = (entry: Entry): string | undefined => {
  if (entry.tier === undefined) return undefined
  return entry.shadowed ? "global · shadowed" : entry.tier
}

/** One row of the composer's `$` popup, in the host's AutocompleteItem shape. */
export interface Row {
  readonly value: string
  readonly description?: string
  readonly label?: string
  readonly part: { readonly type: "skill"; readonly id: string }
}

/** The popup row of an entry: selecting it inserts `$<token>` and attaches the skill, as an `@` mention does. */
export const row = (entry: Entry): Row => {
  const tag = label(entry)
  return {
    value: entry.token,
    ...(entry.description === undefined ? {} : { description: entry.description }),
    ...(tag === undefined ? {} : { label: tag }),
    part: { type: "skill", id: entry.id },
  }
}

/**
 * The registry id a token names, or undefined when it names none, so the
 * token stays plain text. `$id` takes the plain id (the local skill when both
 * tiers hold it); `$id:global` the global one, shadowed or not; `$id:local` the
 * plain id only when it is local.
 */
export const resolve = (token: Pick<Token, "id" | "tier">, entries: ReadonlyArray<Entry>): string | undefined => {
  const plain = entries.find((entry) => entry.token === token.id)
  if (token.tier === undefined) return plain?.id
  if (token.tier === "local") return plain?.tier === "local" ? plain.id : undefined
  const global = entries.find((entry) => entry.token === qualified(token.id))
  if (global) return global.id
  return plain?.tier === "global" ? plain.id : undefined
}

/** A skill a prompt attaches, with the token that named it. */
export interface Attachment {
  readonly id: string
  readonly mention: { readonly start: number; readonly end: number; readonly text: string }
}

/**
 * The skills a prompt's `$` tokens name that it does not attach yet, in the
 * order they appear, each once. A token that names no skill attaches nothing.
 */
export const attachments = (text: string, attached: ReadonlyArray<string>, entries: ReadonlyArray<Entry>): ReadonlyArray<Attachment> => {
  const seen = new Set(attached)
  const added: Array<Attachment> = []
  for (const token of tokens(text)) {
    const id = resolve(token, entries)
    if (id === undefined || seen.has(id)) continue
    seen.add(id)
    added.push({ id, mention: { start: token.start, end: token.end, text: token.text } })
  }
  return added
}

// ── The RPC the composer reads ──

/** The skills RPC: `catalog` answers `{ entries }`, the catalog for the caller's location. */
export const SKILLS = {
  id: "dotfiles-opencode.skills",
  methods: {
    catalog: { input: { type: "object", properties: {} }, output: { type: "object" } },
  },
  events: {},
} as const

/** The catalog as `catalog` answers it. */
export const Answer = Schema.Struct({
  entries: Schema.Array(
    Schema.Struct({
      token: Schema.String,
      id: Schema.String,
      description: Schema.optionalKey(Schema.String),
      tier: Schema.optionalKey(Schema.Literals(["local", "global"])),
      shadowed: Schema.Boolean,
    }),
  ),
})
export type Answer = typeof Answer.Type
