// The in-memory kept sections keep the ReplyStyles laws, and the decision
// over them (sectionOf): the first request keeps its section and every later
// one sends the kept bytes; a session first seen answered keeps none; a
// sighting that fails keeps nothing.
import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { effectTest } from "../../../sim-tui/effect-test.ts"
import { guidance } from "../emphasis.ts"
import { type ReplyStyles, sectionOf, type Sighting } from "../reply-style.ts"
import * as MemoryReplyStyles from "./reply-style.ts"
import { replyStylesLaws } from "./reply-style.laws.ts"

/** Hang guard for the test runner. */
const HANG_GUARD_MS = 30_000

replyStylesLaws("the in-memory store", () => MemoryReplyStyles.layer)

const ROOT: Sighting = { child: false, answered: false }

describe("sectionOf", () => {
  const run = (title: string, body: Effect.Effect<void, string, ReplyStyles>) => effectTest(title, body.pipe(Effect.provide(MemoryReplyStyles.layer)), HANG_GUARD_MS)

  run(
    "the first request keeps the section; later ones send the kept bytes without reading the session again, even after the words change",
    Effect.gen(function* () {
      const sightings = { count: 0 }
      const sight = Effect.sync(() => {
        sightings.count += 1
        return ROOT
      })
      expect(yield* sectionOf("ses_root", sight, guidance())).toBe(guidance())
      expect(yield* sectionOf("ses_root", sight, "changed words")).toBe(guidance())
      expect(sightings.count).toBe(1)
    }),
  )

  run(
    "a session first seen answered keeps none for good, after a compaction too",
    Effect.gen(function* () {
      expect(yield* sectionOf("ses_old", Effect.succeed({ child: false, answered: true }), "S")).toBe("")
      expect(yield* sectionOf("ses_old", Effect.succeed(ROOT), "S")).toBe("")
    }),
  )

  run(
    "a subagent keeps none",
    Effect.gen(function* () {
      expect(yield* sectionOf("ses_child", Effect.succeed({ child: true, answered: false }), "S")).toBe("")
    }),
  )

  run(
    "a sighting that fails keeps nothing: the request fails and the next one decides",
    Effect.gen(function* () {
      expect(yield* Effect.flip(sectionOf("ses_root", Effect.fail("unreadable"), "S"))).toBe("unreadable")
      expect(yield* sectionOf("ses_root", Effect.succeed(ROOT), "S")).toBe("S")
    }),
  )
})
