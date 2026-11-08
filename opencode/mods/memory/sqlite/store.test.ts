import { expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"
import { noteStoreLaws } from "../laws.ts"
import { NoteStore } from "../service.ts"
import { defaultPath, layer } from "./store.ts"

noteStoreLaws("the SQLite store", () => layer(":memory:"))

test("the default file is under XDG_STATE_HOME, else ~/.local/state", () => {
  expect(defaultPath({ XDG_STATE_HOME: "/state" })).toBe("/state/opencode-memory/memory.db")
  expect(defaultPath({})).toEndWith("/.local/state/opencode-memory/memory.db")
})

test("two stores on one file see each other's notes and digests, as two servers and the CLI on one host do", async () => {
  const dir = mkdtempSync(join(tmpdir(), "memory-store-"))
  try {
    const path = join(dir, "nested", "memory.db")
    const written = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const store = yield* NoteStore
          yield* store.keepDigest("ses_1", "kept", 1_000)
          return yield* store.add({ scope: "global", project: "", text: "shared", tags: [], created: 1, updated: 1, uses: 0, shown: 0, used: 0, session: "s", place: "/w" })
        }).pipe(Effect.provide(layer(path))),
      ),
    )
    const [read, digest] = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const store = yield* NoteStore
          return [yield* store.get(written.id), yield* store.keepDigest("ses_1", "other", 2_000)] as const
        }).pipe(Effect.provide(layer(path))),
      ),
    )
    expect(read?.text).toBe("shared")
    expect(digest).toEqual({ text: "kept", fresh: false })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
