// The audit: what the notes on one host look like to a reviewer (the weekly
// dream): each note's readings and age, the notes nobody has used in a while,
// the pairs alike enough to merge, and how each project's digest fills its
// budget. Pure: the CLI reads the notes and prints this.
import { digestOf, LIMITS, type Limits } from "./digest.ts"
import { type Note, similarity } from "./note.ts"

const DAY = 86_400_000
/** Two notes of one bucket at least this alike are listed as a pair to merge or tell apart; below `DUPLICATE`, which merges on save. */
export const NEAR = 0.4
/** Days without a use (or since it was saved, if never used) after which a note is stale. */
export const STALE_DAYS = 30

export interface NoteStat {
  readonly id: number
  readonly scope: Note["scope"]
  readonly project: string
  readonly text: string
  readonly tags: ReadonlyArray<string>
  readonly uses: number
  readonly shown: number
  readonly created: string
  readonly updated: string
  /** When last found or shown; null when never. */
  readonly used: string | null
  /** Whole days since it was last used, or since it was saved if never. */
  readonly idleDays: number
}

export interface Pair {
  readonly a: number
  readonly b: number
  readonly similarity: number
}

export interface DigestFill {
  /** The project, or "" for a session in no project with notes of its own. */
  readonly project: string
  /** Notes the project's sessions see (its own and the global ones). */
  readonly visible: number
  /** Notes its digest holds now. */
  readonly holds: number
  /** The digest's characters now, heading included. */
  readonly chars: number
  readonly limits: Limits
}

export interface Audit {
  readonly total: number
  readonly global: number
  readonly projects: Readonly<Record<string, number>>
  readonly notes: ReadonlyArray<NoteStat>
  /** Ids of the notes idle `staleDays` or more, the longest idle first. */
  readonly stale: ReadonlyArray<number>
  readonly staleDays: number
  /** Pairs at or above `NEAR` in one bucket, the most alike first. */
  readonly near: ReadonlyArray<Pair>
  readonly digests: ReadonlyArray<DigestFill>
}

const iso = (ms: number) => new Date(ms).toISOString()

export const statOf = (note: Note, now: number): NoteStat => ({
  id: note.id,
  scope: note.scope,
  project: note.project,
  text: note.text,
  tags: note.tags,
  uses: note.uses,
  shown: note.shown,
  created: iso(note.created),
  updated: iso(note.updated),
  used: note.used === 0 ? null : iso(note.used),
  idleDays: Math.floor(Math.max(0, now - (note.used === 0 ? note.created : note.used)) / DAY),
})

/** Pairs of notes in one bucket at least `near` alike. */
export const nearPairs = (notes: ReadonlyArray<Note>, near = NEAR): ReadonlyArray<Pair> => {
  const pairs: Array<Pair> = []
  for (let i = 0; i < notes.length; i += 1)
    for (let j = i + 1; j < notes.length; j += 1) {
      const a = notes[i]!
      const b = notes[j]!
      if (a.scope !== b.scope || a.project !== b.project) continue
      const score = similarity(a.text, b.text)
      if (score >= near) {
        const [low, high] = a.id < b.id ? [a, b] : [b, a]
        pairs.push({ a: low.id, b: high.id, similarity: Math.round(score * 100) / 100 })
      }
    }
  return pairs.sort((x, y) => y.similarity - x.similarity || x.a - y.a || x.b - y.b)
}

export const auditOf = (notes: ReadonlyArray<Note>, now: number, options: { readonly staleDays?: number; readonly limits?: Limits } = {}): Audit => {
  const staleDays = options.staleDays ?? STALE_DAYS
  const limits = options.limits ?? LIMITS
  const stats = [...notes].sort((a, b) => a.id - b.id).map((note) => statOf(note, now))
  const projects: Record<string, number> = {}
  for (const note of notes) if (note.scope === "project") projects[note.project] = (projects[note.project] ?? 0) + 1
  const global = notes.filter((note) => note.scope === "global")
  const fill = (project: string): DigestFill => {
    const seen = [...global, ...notes.filter((note) => note.scope === "project" && note.project === project)]
    const digest = digestOf(seen, now, limits)
    return { project, visible: seen.length, holds: digest.ids.length, chars: digest.text.length, limits }
  }
  return {
    total: notes.length,
    global: global.length,
    projects,
    notes: stats,
    stale: stats
      .filter((stat) => stat.idleDays >= staleDays)
      .sort((a, b) => b.idleDays - a.idleDays || a.id - b.id)
      .map((stat) => stat.id),
    staleDays,
    near: nearPairs(notes),
    digests: Object.keys(projects).length === 0 ? (global.length === 0 ? [] : [fill("")]) : Object.keys(projects).sort().map(fill),
  }
}
