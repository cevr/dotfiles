// What every NoteStore owes, as a shared test suite. Each implementation's test
// beside it runs the suite over its Layer.
import { describe, expect, test } from "bun:test"
import { Effect, type Layer, Option } from "effect"
import { type Draft, matchQuery, visible } from "./note.ts"
import { NoteStore } from "./service.ts"

const draft = (fields: Partial<Draft> & Pick<Draft, "text">): Draft => ({
  scope: "project",
  project: "p1",
  tags: [],
  created: 1_000,
  updated: 1_000,
  uses: 0,
  shown: 0,
  used: 0,
  session: "ses_1",
  place: "/work",
  ...fields,
})

/** `fresh` gives a new, empty store for each case. */
export const noteStoreLaws = (name: string, fresh: () => Layer.Layer<NoteStore, unknown>) => {
  const check = <A, E>(body: Effect.Effect<A, E, NoteStore>) => Effect.runPromise(Effect.scoped(body.pipe(Effect.provide(fresh()))))
  describe(`${name} keeps the NoteStore laws`, () => {
    test("add gives rising ids and keeps every field; get reads it back; an unknown id reads as none", () =>
      check(
        Effect.gen(function* () {
          const store = yield* NoteStore
          const a = yield* store.add(draft({ text: "The user prefers bun over npm", tags: ["bun"], scope: "global", project: "" }))
          const b = yield* store.add(draft({ text: "Run the gate with bun run gate" }))
          expect(b.id).toBeGreaterThan(a.id)
          expect(yield* store.get(a.id)).toEqual({ ...draft({ text: "The user prefers bun over npm", tags: ["bun"], scope: "global", project: "" }), id: a.id })
          expect(yield* store.get(9_999)).toBeUndefined()
        }),
      ))

    test("match finds by text and by tag, stemmed, within the buckets asked, best match first", () =>
      check(
        Effect.gen(function* () {
          const store = yield* NoteStore
          const pref = yield* store.add(draft({ text: "The user prefers bun over npm", scope: "global", project: "" }))
          const gate = yield* store.add(draft({ text: "Run the gate with bun run gate before a push", tags: ["checks"] }))
          yield* store.add(draft({ text: "Bun is used in another project", project: "p2" }))
          const found = yield* store.match(matchQuery("bun gate"), visible("p1"), 10)
          expect(found.map((note) => note.id)).toEqual([gate.id, pref.id])
          expect((yield* store.match(matchQuery("prefer"), visible("p1"), 10)).map((note) => note.id)).toEqual([pref.id])
          expect((yield* store.match(matchQuery("checks"), visible("p1"), 10)).map((note) => note.id)).toEqual([gate.id])
          expect(yield* store.match(matchQuery("bun"), visible("p1"), 1)).toHaveLength(1)
          expect(yield* store.match(matchQuery("bun"), [], 10)).toEqual([])
        }),
      ))

    test("put replaces a note whole and the index follows its new text; remove drops it from get and match", () =>
      check(
        Effect.gen(function* () {
          const store = yield* NoteStore
          const note = yield* store.add(draft({ text: "Deploys go through alchemy" }))
          yield* store.put({ ...note, text: "Deploys go through railway", updated: 2_000, uses: 3 })
          expect((yield* store.get(note.id))?.text).toBe("Deploys go through railway")
          expect((yield* store.get(note.id))?.uses).toBe(3)
          expect(yield* store.match(matchQuery("alchemy"), visible("p1"), 10)).toEqual([])
          expect(yield* store.match(matchQuery("railway"), visible("p1"), 10)).toHaveLength(1)
          expect(yield* store.remove(note.id)).toBe(true)
          expect(yield* store.remove(note.id)).toBe(false)
          expect(yield* store.get(note.id)).toBeUndefined()
          expect(yield* store.match(matchQuery("railway"), visible("p1"), 10)).toEqual([])
        }),
      ))

    test("list answers the newest updated first, within the buckets when given, up to the limit", () =>
      check(
        Effect.gen(function* () {
          const store = yield* NoteStore
          const old = yield* store.add(draft({ text: "old", updated: 1_000 }))
          const recent = yield* store.add(draft({ text: "recent", updated: 3_000 }))
          const other = yield* store.add(draft({ text: "other", project: "p2", updated: 2_000 }))
          expect((yield* store.list({})).map((note) => note.id)).toEqual([recent.id, other.id, old.id])
          expect((yield* store.list({ within: visible("p1") })).map((note) => note.id)).toEqual([recent.id, old.id])
          expect((yield* store.list({ limit: 1 })).map((note) => note.id)).toEqual([recent.id])
          expect(yield* store.list({ within: [] })).toEqual([])
        }),
      ))

    test("read counts a use or a showing and sets when it was last used", () =>
      check(
        Effect.gen(function* () {
          const store = yield* NoteStore
          const a = yield* store.add(draft({ text: "a" }))
          const b = yield* store.add(draft({ text: "b" }))
          yield* store.read([a.id, b.id], "uses", 5_000)
          yield* store.read([a.id], "shown", 6_000)
          expect(yield* store.get(a.id)).toMatchObject({ uses: 1, shown: 1, used: 6_000 })
          expect(yield* store.get(b.id)).toMatchObject({ uses: 1, shown: 0, used: 5_000 })
          yield* store.read([], "uses", 7_000)
        }),
      ))

    test("keepDigest keeps the first digest of a session and answers it ever after", () =>
      check(
        Effect.gen(function* () {
          const store = yield* NoteStore
          expect(yield* store.keepDigest("ses_1", "first", 1_000)).toEqual({ text: "first", fresh: true })
          expect(yield* store.keepDigest("ses_1", "second", 2_000)).toEqual({ text: "first", fresh: false })
          expect(yield* store.keepDigest("ses_2", "", 2_000)).toEqual({ text: "", fresh: true })
          expect(yield* store.keepDigest("ses_2", "later", 3_000)).toEqual({ text: "", fresh: false })
        }),
      ))

    test("keptDigest answers a session's kept digest, none before it is kept", () =>
      check(
        Effect.gen(function* () {
          const store = yield* NoteStore
          expect(yield* store.keptDigest("ses_1")).toEqual(Option.none())
          yield* store.keepDigest("ses_1", "first", 1_000)
          expect(yield* store.keptDigest("ses_1")).toEqual(Option.some("first"))
          yield* store.keepDigest("ses_2", "", 1_000)
          expect(yield* store.keptDigest("ses_2")).toEqual(Option.some(""))
        }),
      ))
  })
}
