// A memory note: one durable fact a session saved for later sessions, kept for
// every project (`global`) or for one (`project`, by OpenCode's project id, which
// every clone, worktree and Rift of a repository shares). The rules here are
// pure: what a note's text may be, when a new note repeats one already kept,
// and the full-text query a search sends.
import { Schema } from "effect"

export const Scope = Schema.Literals(["global", "project"])
export type Scope = typeof Scope.Type

/** The longest a note may be, in characters: one line, as OptMem keeps them, a little roomier for a fix's how. */
export const MAX_TEXT = 400
/** The most tags a note keeps. */
export const MAX_TAGS = 8
/** How alike two notes' words must be (Jaccard) for a new one to update the old one instead of joining it. */
export const DUPLICATE = 0.6

/** Where a note lives: every project, or one. A global note's project is empty. */
export interface Bucket {
  readonly scope: Scope
  readonly project: string
}

export interface Note extends Bucket {
  readonly id: number
  readonly text: string
  readonly tags: ReadonlyArray<string>
  /** Epoch ms. */
  readonly created: number
  readonly updated: number
  /** How often a search found it or a save repeated it: what was asked for, which ranks the digest. */
  readonly uses: number
  /** How many sessions started with it in their digest. Never ranks the digest, so the injected notes cannot keep themselves there. */
  readonly shown: number
  /** When a search found it or a digest showed it last, epoch ms; 0 when never. */
  readonly used: number
  /** The session that saved it last. */
  readonly session: string
  /** That session's directory: which checkout a project note came from, for a reader of the store. */
  readonly place: string
}

/** What a save stores, before the store gives it an id. */
export type Draft = Omit<Note, "id">

/** The global bucket and the session's project's: what a session sees. */
export const visible = (project: string): ReadonlyArray<Bucket> => [
  { scope: "global", project: "" },
  { scope: "project", project },
]

export const bucketOf = (scope: Scope, project: string): Bucket => ({ scope, project: scope === "global" ? "" : project })

export class EmptyNote extends Schema.TaggedError<EmptyNote>()("EmptyNote", {}) {}

export class NoteTooLong extends Schema.TaggedError<NoteTooLong>()("NoteTooLong", { length: Schema.Number, limit: Schema.Number }) {}

/** No note of that id, or one of another project. */
export class NoteNotFound extends Schema.TaggedError<NoteNotFound>()("NoteNotFound", { id: Schema.Number }) {}

/** A search with no words to look for. */
export class EmptyQuery extends Schema.TaggedError<EmptyQuery>()("EmptyQuery", { query: Schema.String }) {}

/** A subagent writes no memory: it cannot judge what is already known, so its notes would repeat (OptMem's rule). */
export class SubagentWrite extends Schema.TaggedError<SubagentWrite>()("SubagentWrite", { sessionID: Schema.String }) {}

/** One line: whitespace runs, newlines included, become one space. */
export const normalize = (text: string): string => text.replace(/\s+/g, " ").trim()

/** The note's text as stored, or why it cannot be. */
export const textOf = (raw: string): EmptyNote | NoteTooLong | string => {
  const text = normalize(raw)
  if (text.length === 0) return new EmptyNote()
  if (text.length > MAX_TEXT) return new NoteTooLong({ length: text.length, limit: MAX_TEXT })
  return text
}

/** Tags as stored: lower case, one word each, no repeats, at most `MAX_TAGS`. */
export const tagsOf = (tags: ReadonlyArray<string>): ReadonlyArray<string> => [
  ...new Set(tags.map((tag) => tag.toLowerCase().replace(/[^\p{L}\p{N}_-]+/gu, "")).filter((tag) => tag.length > 0)),
].slice(0, MAX_TAGS)

/** The words of a text, lower case, letters and digits only. */
export const words = (text: string): ReadonlyArray<string> => text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []

/** How alike two texts' words are: shared words over all words (Jaccard), 0 to 1. */
export const similarity = (a: string, b: string): number => {
  const left = new Set(words(a))
  const right = new Set(words(b))
  if (left.size === 0 || right.size === 0) return 0
  let shared = 0
  for (const word of left) if (right.has(word)) shared += 1
  return shared / (left.size + right.size - shared)
}

/** The kept note in `bucket` the new text repeats, the most alike at or above `DUPLICATE`; none when it says something new. */
export const duplicateOf = (candidates: ReadonlyArray<Note>, bucket: Bucket, text: string): Note | undefined => {
  let best: { readonly note: Note; readonly score: number } | undefined
  for (const note of candidates) {
    if (note.scope !== bucket.scope || note.project !== bucket.project) continue
    const score = similarity(note.text, text)
    if (score >= DUPLICATE && (best === undefined || score > best.score)) best = { note, score }
  }
  return best?.note
}

/**
 * The full-text query for free text: each distinct word quoted, any of them matching (SQLite FTS5 syntax), so the
 * text's punctuation never reads as query operators. Empty when the text has no words.
 */
export const matchQuery = (text: string): string => [...new Set(words(text))].map((word) => `"${word}"`).join(" OR ")

/** Tags merged: the new first, then the old, within `MAX_TAGS`. */
export const mergeTags = (fresh: ReadonlyArray<string>, kept: ReadonlyArray<string>): ReadonlyArray<string> => tagsOf([...fresh, ...kept])
