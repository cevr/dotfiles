// The digest: the small block of notes a session starts with, the top of the
// memory hierarchy (Anthropic's "injected context"). It is bounded, by a count
// and by characters, because every injected token is paid in every request and
// a long block is followed less. It is chosen once per session and then kept,
// so the system prompt, and the provider's cache of it, stays the same for the
// whole session: a note saved mid-session shows from the next session on.
import type { Note } from "./note.ts"

/** How long it takes a note nobody updates to rank half as high, in days. */
export const HALF_LIFE_DAYS = 60
const DAY = 86_400_000

export interface Limits {
  /** The most notes it holds. */
  readonly notes: number
  /** The most characters its note lines take together, newlines included; the heading is on top. */
  readonly chars: number
}

export const LIMITS: Limits = { notes: 30, chars: 4_000 }

/** How much a note earns its place: asked-for more is higher, older is lower. `shown` never counts. */
export const rank = (note: Note, now: number): number =>
  (1 + Math.log2(1 + note.uses)) * 0.5 ** (Math.max(0, now - note.updated) / DAY / HALF_LIFE_DAYS)

/** A note's line in the block. */
export const lineOf = (note: Note): string => `- #${note.id} ${note.text}${note.tags.length === 0 ? "" : ` [${note.tags.join(", ")}]`}`

export const HEADING = [
  "# Memory",
  "Notes earlier sessions saved with memory_save: durable facts about the user, their preferences and this project's conventions and fixes. Follow them unless the work in front of you shows one is wrong; then correct it with memory_save (its id) or drop it with memory_forget. memory_search finds notes not shown here.",
].join("\n")

export interface Digest {
  /** The block, empty when no note is kept. */
  readonly text: string
  /** The notes in it, in the block's order. */
  readonly ids: ReadonlyArray<number>
}

/**
 * The digest of `notes`: the highest-ranked that fit `limits`, then laid out global first, then the project's, each
 * oldest id first, so the same notes always give the same text.
 */
export const digestOf = (notes: ReadonlyArray<Note>, now: number, limits: Limits = LIMITS): Digest => {
  const ranked = [...notes].sort((a, b) => rank(b, now) - rank(a, now) || a.id - b.id)
  const chosen: Array<Note> = []
  let used = 0
  for (const note of ranked) {
    if (chosen.length >= limits.notes) break
    const cost = lineOf(note).length + 1
    if (used + cost > limits.chars) continue
    chosen.push(note)
    used += cost
  }
  if (chosen.length === 0) return { text: "", ids: [] }
  const global = chosen.filter((note) => note.scope === "global").sort((a, b) => a.id - b.id)
  const project = chosen.filter((note) => note.scope === "project").sort((a, b) => a.id - b.id)
  const sections = [
    ...(global.length === 0 ? [] : [["## About the user, in every project", ...global.map(lineOf)].join("\n")]),
    ...(project.length === 0 ? [] : [["## This project", ...project.map(lineOf)].join("\n")]),
  ]
  return { text: [HEADING, ...sections].join("\n\n"), ids: [...global, ...project].map((note) => note.id) }
}
