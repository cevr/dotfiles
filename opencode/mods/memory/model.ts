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
//   the session carries the same block; the notes it shows count `shown`. A
//   copy sends a session the digest it sent before, even when the store fails
//   a write (it keeps trying to keep it), and holds an unkept digest on the
//   session itself (`Sessions.hold`) for a copy that starts after a restart,
//   so a store fault never changes the cached prefix.
import { Clock, Context, Effect, Layer, Option } from "effect"
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

      /** Each session's digest once the store keeps it: later requests read it here, with no store call to fail. */
      const sent = new Map<string, string>()

      /**
       * Keeps `chosen` as the session's digest: the store's kept text (another copy's, if it kept one first), or none
       * when the store could not write. A digest kept fresh counts a showing of its notes; a showing the store could
       * not count is lost, never the digest.
       */
      const keep = (sessionID: string, chosen: { readonly text: string; readonly ids: ReadonlyArray<number> }, now: number) =>
        store.keepDigest(sessionID, chosen.text, now).pipe(
          Effect.tap((kept) =>
            Effect.when(
              store.read(chosen.ids, "shown", now).pipe(Effect.catch((failure) => Effect.logWarning("memory: the digest's showing was not counted", { sessionID, failure: failure.message }))),
              Effect.succeed(kept.fresh && chosen.ids.length > 0),
            ),
          ),
          Effect.map((kept) => Option.some(kept.text)),
          Effect.catch((failure) => Effect.logWarning("memory: the digest was not kept; the session holds it", { sessionID, failure: failure.message }).pipe(Effect.as(Option.none<string>()))),
        )

      /**
       * Holds `text` on the session itself when the store could not keep it, so this copy's next request and a copy
       * that starts after a restart send it too; a session the host cannot update is logged.
       */
      const hold = (sessionID: string, text: string) =>
        sessions.hold(sessionID, text).pipe(Effect.catch((failure) => Effect.logWarning("memory: the digest was not held on the session", { sessionID, failure: failure.message })))

      const digest = Effect.fn("MemoryModel.digest")(function* (sessionID: string) {
        const known = Option.fromNullishOr(sent.get(sessionID))
        if (Option.isSome(known)) return known.value
        const now = yield* Clock.currentTimeMillis
        // Kept by another copy or before a restart: a read, which needs no write.
        const stored = yield* store.keptDigest(sessionID).pipe(Effect.orElseSucceed(() => Option.none<string>()))
        if (Option.isSome(stored)) {
          sent.set(sessionID, stored.value)
          return stored.value
        }
        const facts = yield* sessions.facts(sessionID)
        // Sent before while the store could not keep it, and held on the session: kept now if the store can, and sent
        // whatever it answers.
        if (Option.isSome(facts.held)) {
          const held = facts.held.value
          if (Option.isSome(yield* keep(sessionID, { text: held, ids: [] }, now))) sent.set(sessionID, held)
          return held
        }
        const notes = yield* store.list({ within: visible(facts.project), limit: DIGEST_POOL })
        const chosen = digestOf(notes, now, limits)
        const kept = yield* keep(sessionID, chosen, now)
        if (Option.isNone(kept)) {
          yield* hold(sessionID, chosen.text)
          return chosen.text
        }
        sent.set(sessionID, kept.value)
        return kept.value
      })

      return MemoryModel.of({ save, search, forget, digest })
    }),
  )

