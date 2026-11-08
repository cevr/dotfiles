// The memory CLI on a scratch file: each command as a reviewer runs it, its
// human and --json output, its exit codes, and that reading never counts a use.
import { afterAll, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"
import { NoteStore } from "@dotfiles/opencode-memory/service"
import * as SqliteStore from "@dotfiles/opencode-memory/sqlite/store"
import { main } from "./cli.ts"

const DAY = 86_400_000
const NOW = 1_000 * DAY
const scratch = mkdtempSync(join(tmpdir(), "memory-cli-"))
afterAll(() => rmSync(scratch, { recursive: true, force: true }))

let files = 0
/** A fresh file with the notes a plugin saved: a global preference, two near-identical project notes and an old one. */
const seeded = async () => {
  const db = join(scratch, `memory-${(files += 1)}.db`)
  const base = { tags: [], shown: 0, session: "ses_1", place: "/work/repo" }
  await Effect.runPromise(
    Effect.gen(function* () {
      const store = yield* NoteStore
      yield* store.add({ ...base, scope: "global", project: "", text: "The user prefers bun over npm", created: NOW - DAY, updated: NOW - DAY, uses: 3, used: NOW - DAY })
      yield* store.add({ ...base, scope: "project", project: "prj", text: "Run the gate before every push to main", created: NOW - 2 * DAY, updated: NOW - 2 * DAY, uses: 1, used: 0 })
      yield* store.add({ ...base, scope: "project", project: "prj", text: "Run the gate before a push to main", created: NOW - 2 * DAY, updated: NOW - 2 * DAY, uses: 0, used: 0 })
      yield* store.add({ ...base, scope: "project", project: "prj", text: "Deploys go through alchemy", created: NOW - 90 * DAY, updated: NOW - 90 * DAY, uses: 0, used: 0 })
    }).pipe(Effect.provide(SqliteStore.layer(db))),
  )
  const cli = (...argv: Array<string>) => main(argv, { db, now: NOW })
  const json = async (...argv: Array<string>) => {
    const outcome = await cli(...argv, "--json")
    expect(outcome.code).toBe(0)
    return JSON.parse(outcome.out)
  }
  return { cli, json }
}

describe("the memory CLI", () => {
  test("list shows every note, newest first, or one bucket's; --json carries each note's readings and dates", async () => {
    const { cli, json } = await seeded()
    const listed = await cli("list")
    expect(listed.code).toBe(0)
    expect(listed.out.split("\n")[0]).toBe("#1 [global] The user prefers bun over npm · uses 3 · shown 0")
    expect((await json("list", "--scope", "global")).map((note: { id: number }) => note.id)).toEqual([1])
    expect((await json("list", "--project", "prj", "--limit", "2")).map((note: { id: number }) => note.id)).toEqual([1, 3])
    expect((await json("list", "--scope", "project", "--project", "prj"))[2]).toMatchObject({
      id: 4,
      uses: 0,
      used: null,
      idleDays: 90,
      created: new Date(NOW - 90 * DAY).toISOString(),
    })
  })

  test("search finds across every project, or one project's and the global ones; it counts no use", async () => {
    const { cli, json } = await seeded()
    expect((await json("search", "gate", "push")).map((note: { id: number }) => note.id).sort()).toEqual([2, 3])
    expect((await json("search", "bun", "--project", "other")).map((note: { id: number }) => note.id)).toEqual([1])
    expect(await cli("search", "zebra")).toEqual({ code: 0, out: "no note matches" })
    expect((await json("show", "2")).uses).toBe(1)
  })

  test("show gives one note's dates, saver and directory", async () => {
    const { cli, json } = await seeded()
    expect((await cli("show", "1")).out).toContain("saved by ses_1 in /work/repo")
    expect(await json("show", "1")).toMatchObject({ id: 1, scope: "global", uses: 3, used: new Date(NOW - DAY).toISOString(), place: "/work/repo" })
    expect(await cli("show", "9")).toEqual({ code: 1, out: "no note #9" })
  })

  test("add, edit and forget change the file the plugin reads", async () => {
    const { cli, json } = await seeded()
    const added = await json("add", "Answer", "in", "plain", "English", "--scope", "global", "--tags", "style,Voice")
    expect(added).toMatchObject({ id: 5, scope: "global", text: "Answer in plain English", tags: ["style", "voice"], uses: 0 })
    expect((await json("show", "5")).session).toBe("cli")
    const edited = await json("edit", "4", "--text", "Deploys go through railway", "--scope", "global")
    expect(edited.now).toMatchObject({ id: 4, scope: "global", project: "", text: "Deploys go through railway", updated: new Date(NOW).toISOString() })
    expect(edited.was.text).toBe("Deploys go through alchemy")
    expect((await cli("forget", "4")).out).toStartWith("forgot #4")
    expect((await cli("show", "4")).code).toBe(1)
  })

  test("merge keeps one note with both notes' readings and tags, and drops the other", async () => {
    const { cli, json } = await seeded()
    const merged = await json("merge", "2", "3", "--text", "Run the gate before a push to main")
    expect(merged.kept).toMatchObject({ id: 2, text: "Run the gate before a push to main", uses: 1 })
    expect((await cli("show", "3")).code).toBe(1)
    expect((await cli("merge", "2", "2")).code).toBe(2)
  })

  test("projects lists each project's notes and where they were saved", async () => {
    const { cli, json } = await seeded()
    expect(await json("projects")).toEqual({
      global: 1,
      projects: [{ project: "prj", notes: 3, places: ["/work/repo"], updated: new Date(NOW - 2 * DAY).toISOString() }],
    })
    expect((await cli("projects")).out).toBe("global: 1 notes\nprj: 3 notes · /work/repo")
  })

  test("stats gives the stale notes, the near pairs and each digest's fill", async () => {
    const { cli, json } = await seeded()
    const audit = await json("stats")
    expect(audit.total).toBe(4)
    expect(audit.stale).toEqual([4])
    expect(audit.near).toEqual([{ a: 2, b: 3, similarity: 0.78 }])
    expect(audit.digests).toEqual([{ project: "prj", visible: 4, holds: 4, chars: expect.any(Number), limits: { notes: 30, chars: 4_000 } }])
    expect((await json("stats", "--stale-days", "1")).stale).toEqual([4, 2, 3, 1])
    const human = (await cli("stats")).out
    expect(human).toContain("stale (idle 30+ days): #4")
    expect(human).toContain("near pairs: #2~#3 0.78")
  })

  test("a usage error exits 2 with the usage; a refused value exits 1", async () => {
    const { cli } = await seeded()
    for (const argv of [[], ["fly"], ["show"], ["show", "x"], ["list", "--scope", "team"], ["add", "a fact"], ["add", "a fact", "--scope", "project"], ["list", "--bogus"]]) {
      const outcome = await cli(...argv)
      expect(outcome.code).toBe(2)
      expect(outcome.out).toContain("usage: bun opencode/cmd/memory/cli.ts")
    }
    expect(await cli("add", " ", "--scope", "global")).toEqual({ code: 1, out: "the note is empty" })
  })

  test("a missing or unknown command never creates the file", async () => {
    const db = join(scratch, "never.db")
    expect((await main([], { db, now: NOW })).code).toBe(2)
    expect((await main(["fly"], { db, now: NOW })).code).toBe(2)
    expect(existsSync(db)).toBe(false)
  })
})
