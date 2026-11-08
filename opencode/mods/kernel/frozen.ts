// Each session's kernel description, frozen at its first request, so the
// tool definitions at the front of the cached prompt stay byte for byte the
// same for the session's life.
//
// While the kernel is the runtime, its description lists the tools it
// reaches (description.ts). That list moves: an MCP server connects or
// reconnects, a plugin reloads and its tools come back, a tool leaves. A new
// description rewrites the very first segment of the prompt, so every request
// after it writes the whole prompt to the cache again. Here a session keeps
// the description its first request offered. The runtime still reaches every
// live tool, and a change in the tools is told once, in a message
// (`notice`), never by a new description. A subagent is its own session, so
// it freezes its own at its first request.
//
// The runtime writes the live description without knowing the session
// (`describe`); the request hook knows the session and sees that text. So
// `describe` keeps the tools each text it wrote names, by the text, and
// `offer` reads them back from the text the request carries.
import { Effect, Option, Schema, Semaphore } from "effect"
import type { Json } from "./frame.ts"
import { firstSentence } from "./summary.ts"
import { pathOf, reachable, type Reached } from "./tools.ts"

/** The storage key prefix of a session's frozen description: `kernel-catalog:<sessionID>`. */
export const FROZEN_PREFIX = "kernel-catalog:"

/** How many live descriptions `describe` remembers: a few registry states are live at once, one per permission set. */
export const REMEMBERED = 32

/**
 * One session's entry: the description its first request offered, the
 * `stamp` of the kernel's words it was written with, and the tools the
 * session was last told of, by name.
 */
export const Frozen = Schema.Struct({ stamp: Schema.String, description: Schema.String, names: Schema.Array(Schema.String) })
export interface Frozen extends Schema.Schema.Type<typeof Frozen> {}

/** The plugin's storage, as the frozen descriptions use it. A read that breaks counts as empty. */
export interface Store {
  readonly get: (key: string) => Effect.Effect<unknown>
  readonly set: (key: string, value: Json) => Effect.Effect<void>
  readonly remove: (key: string) => Effect.Effect<void>
}

/** A tool as a change names it: its name and first sentence. */
export interface Named {
  readonly name: string
  readonly summary: string
}

/** The tools that joined and left since the session was last told of them. */
export interface Change {
  readonly added: ReadonlyArray<Named>
  readonly removed: ReadonlyArray<string>
}

/** What a request offers: the session's frozen description, and the change to tell it of, when there is one. */
export interface Offer {
  readonly description: string
  readonly change?: Change
}

/** The words that tell a session its tools changed while its list stayed as it was. */
export const notice = (change: Change): string =>
  [
    "The kernel's tools changed since this session's tool list was written. The list in the kernel's description stays as it was, so the prompt cache holds; this is the change.",
    ...(change.added.length === 0
      ? []
      : ["New tools, called like the others (read `tools.docs(name)` before the first call):", ...change.added.map((tool) => `- ${pathOf(tool.name)}: ${tool.summary}`)]),
    ...(change.removed.length === 0 ? [] : ["Gone (a call now throws):", ...change.removed.map((name) => `- ${pathOf(name)}`)]),
  ].join("\n")

const decodeFrozen = Schema.decodeUnknownOption(Frozen)
const byName = (left: string, right: string) => (left < right ? -1 : left > right ? 1 : 0)

/**
 * The frozen descriptions over `store`. `write` is the live description of
 * the tools; `stamp` names the kernel's own words (its limits and text), so a
 * session frozen under other words takes the new ones once.
 */
export const make = (write: (tools: ReadonlyArray<Reached>) => string, stamp: string, store: Store) =>
  Effect.gen(function* () {
    const lock = yield* Semaphore.make(1)
    /** Each live description `describe` wrote, newest last, with the tools it names. */
    const described = new Map<string, ReadonlyArray<Named>>()
    /** The entries read or written, so a request reads storage once per session. */
    const sessions = new Map<string, Frozen>()

    const load = (session: string): Effect.Effect<Frozen | undefined> => {
      const known = sessions.get(session)
      if (known !== undefined) return Effect.succeed(known)
      return store.get(FROZEN_PREFIX + session).pipe(
        Effect.map((value) => Option.getOrUndefined(decodeFrozen(value))),
        Effect.catchCause(() => Effect.succeed(undefined)),
      )
    }
    const save = (session: string, frozen: Frozen) =>
      Effect.sync(() => void sessions.set(session, frozen)).pipe(
        Effect.andThen(store.set(FROZEN_PREFIX + session, { stamp: frozen.stamp, description: frozen.description, names: [...frozen.names] })),
      )

    /** The runtime's `describe`: the live description, remembered with the tools it names. */
    const describe = (tools: ReadonlyArray<Reached>): string => {
      const text = write(tools)
      const named = reachable(tools)
        .map((tool): Named => ({ name: tool.name, summary: firstSentence(tool.description) }))
        .sort((left, right) => byName(left.name, right.name))
      described.delete(text)
      described.set(text, named)
      while (described.size > REMEMBERED) described.delete(described.keys().next().value!)
      return text
    }

    /**
     * What `session`'s request offers for the `live` description the runtime
     * wrote for it. The first request freezes `live`; a later one offers the
     * frozen text, and when the live tools differ from those the session was
     * last told of, the change, once. A `live` text `describe` did not write
     * (or no longer remembers) changes nothing.
     */
    const offer = (session: string, live: string): Effect.Effect<Offer> =>
      lock.withPermits(1)(
        Effect.gen(function* () {
          const tools = described.get(live)
          const frozen = yield* load(session)
          if (tools === undefined) return { description: frozen?.stamp === stamp ? frozen.description : live }
          const names = tools.map((tool) => tool.name)
          if (frozen === undefined || frozen.stamp !== stamp) {
            yield* save(session, { stamp, description: live, names })
            return { description: live }
          }
          const told = new Set(frozen.names)
          const now = new Set(names)
          const added = tools.filter((tool) => !told.has(tool.name))
          const removed = frozen.names.filter((name) => !now.has(name))
          if (added.length === 0 && removed.length === 0) return { description: frozen.description }
          yield* save(session, { ...frozen, names })
          return { description: frozen.description, change: { added, removed } }
        }),
      )

    /** Drops a deleted session's entry. */
    const forget = (session: string) =>
      Effect.sync(() => void sessions.delete(session)).pipe(Effect.andThen(store.remove(FROZEN_PREFIX + session)))

    return { describe, offer, forget }
  })

export type Catalogs = Effect.Success<ReturnType<typeof make>>
