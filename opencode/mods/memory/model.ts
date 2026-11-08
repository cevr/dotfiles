// Memory's handlers: save, search and forget for the tools, and the digest a
// session starts with. They read the session's project and whether it is a
// subagent through `Sessions`, and keep everything in the `NoteStore`.
//
// - save: a note with an id corrects that note; one without is checked against
//   the notes of its bucket, and one that repeats a kept note (`duplicateOf`)
//   updates it instead of joining it.
// - search: the session's project's notes and the global ones, best match
//   first; each found note counts a use.
// - digest: chosen once per session (`digestOf`) and kept, so every request of
//   the session carries the same block; the notes it shows count `shown`.
import { Clock, Context, Effect, Layer } from "effect"
import { digestOf, LIMITS, type Limits } from "./digest.ts"
import { DEFAULT_RESULTS, type ForgetInput, MAX_RESULTS, type Saved, type SaveInput, type SearchInput } from "./notebook.ts"
import {
  bucketOf,
  duplicateOf,
  type EmptyNote,
  EmptyQuery,
  matchQuery,
  mergeTags,
  type Note,
  NoteNotFound,
  type NoteTooLong,
  SubagentWrite,
  tagsOf,
  textOf,
  visible,
} from "./note.ts"
import { type MemoryStoreFailed, NoteStore, Sessions, type SessionUnreadable } from "./service.ts"

/** How many notes of a session's buckets the digest chooses from: the most recently updated. */
const DIGEST_POOL = 500
/** How many notes of a bucket a save checks for a repeat. */
const REPEAT_POOL = 20

type Failure = MemoryStoreFailed | SessionUnreadable

export class MemoryModel extends Context.Service<
  MemoryModel,
  {
    readonly save: (sessionID: string, input: SaveInput) => Effect.Effect<Saved, EmptyNote | NoteTooLong | NoteNotFound | SubagentWrite | Failure>
    readonly search: (sessionID: string, input: SearchInput) => Effect.Effect<ReadonlyArray<Note>, EmptyQuery | Failure>
    readonly forget: (sessionID: string, input: ForgetInput) => Effect.Effect<Note, NoteNotFound | SubagentWrite | Failure>
    /** The session's digest, empty when it has none. The same text every time for one session. */
    readonly digest: (sessionID: string) => Effect.Effect<string, Failure>
  }
>()("dotfiles-opencode/memory/MemoryModel") {}

const sees = (project: string, note: Note) => note.scope === "global" || note.project === project

export const layer = (limits: Limits = LIMITS) =>
  Layer.effect(
    MemoryModel,
    Effect.gen(function* () {
      const store = yield* NoteStore
      const sessions = yield* Sessions

      /** The note `id` if this session's project sees it. */
      const visibleNote = Effect.fn("MemoryModel.visibleNote")(function* (project: string, id: number) {
        const note = yield* store.get(id)
        if (note === undefined || !sees(project, note)) return yield* new NoteNotFound({ id })
        return note
      })

      const save = Effect.fn("MemoryModel.save")(function* (sessionID: string, input: SaveInput) {
        const facts = yield* sessions.facts(sessionID)
        if (facts.child) return yield* new SubagentWrite({ sessionID })
        const text = textOf(input.text)
        if (typeof text !== "string") return yield* text
        const tags = tagsOf(input.tags ?? [])
        const now = yield* Clock.currentTimeMillis
        if (input.id !== undefined) {
          const note = yield* visibleNote(facts.project, input.id)
          const bucket = input.scope === undefined ? { scope: note.scope, project: note.project } : bucketOf(input.scope, facts.project)
          const corrected: Note = { ...note, ...bucket, text, tags: input.tags === undefined ? note.tags : tags, updated: now, session: sessionID, place: facts.directory }
          yield* store.put(corrected)
          return { kind: "corrected", note: corrected, was: note.text } satisfies Saved
        }
        const bucket = bucketOf(input.scope ?? "project", facts.project)
        const query = matchQuery(text)
        const candidates = query === "" ? [] : yield* store.match(query, [bucket], REPEAT_POOL)
        const repeat = duplicateOf(candidates, bucket, text)
        if (repeat !== undefined) {
          const merged: Note = { ...repeat, text, tags: mergeTags(tags, repeat.tags), updated: now, uses: repeat.uses + 1, used: now, session: sessionID, place: facts.directory }
          yield* store.put(merged)
          return { kind: "merged", note: merged, was: repeat.text } satisfies Saved
        }
        const note = yield* store.add({ ...bucket, text, tags, created: now, updated: now, uses: 0, shown: 0, used: 0, session: sessionID, place: facts.directory })
        return { kind: "added", note } satisfies Saved
      })

      const search = Effect.fn("MemoryModel.search")(function* (sessionID: string, input: SearchInput) {
        const query = matchQuery(input.query)
        if (query === "") return yield* new EmptyQuery({ query: input.query })
        const facts = yield* sessions.facts(sessionID)
        const limit = Math.max(1, Math.min(MAX_RESULTS, Math.floor(input.limit ?? DEFAULT_RESULTS)))
        const notes = yield* store.match(query, visible(facts.project), limit)
        if (notes.length > 0) yield* store.read(notes.map((note) => note.id), "uses", yield* Clock.currentTimeMillis)
        return notes
      })

      const forget = Effect.fn("MemoryModel.forget")(function* (sessionID: string, input: ForgetInput) {
        const facts = yield* sessions.facts(sessionID)
        if (facts.child) return yield* new SubagentWrite({ sessionID })
        const note = yield* visibleNote(facts.project, input.id)
        yield* store.remove(note.id)
        return note
      })

      const digest = Effect.fn("MemoryModel.digest")(function* (sessionID: string) {
        const facts = yield* sessions.facts(sessionID)
        const now = yield* Clock.currentTimeMillis
        const notes = yield* store.list({ within: visible(facts.project), limit: DIGEST_POOL })
        const chosen = digestOf(notes, now, limits)
        const kept = yield* store.keepDigest(sessionID, chosen.text, now)
        if (kept.fresh && chosen.ids.length > 0) yield* store.read(chosen.ids, "shown", now)
        return kept.text
      })

      return MemoryModel.of({ save, search, forget, digest })
    }),
  )

