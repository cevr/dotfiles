// `digest export` over a synthetic log in a scratch folder: it writes the page's data.js by rename, as r3's page reads
// it (`window.DIGEST3` with its projects), skips a bad line, and refuses arguments without `--out`.
import { describe, expect, test } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { Effect, Option, Schema } from "effect"
import { scratch } from "../../tests/scratch.ts"
import { DigestEvent, encodeLine, VERSION } from "@dotfiles/opencode-digest/event"
import * as FileLog from "@dotfiles/opencode-digest/filestore/log"
import { Project } from "@dotfiles/opencode-digest/messages"
import { main } from "./export.ts"

const T = Date.parse("2026-11-20T12:00:00Z")
const base = { v: VERSION, root: "ses_root" } as const
const EVENTS = [
  DigestEvent.cases.Run.make({ ...base, t: T, host: "mac", repo: "demo", dir: Option.some("/nonexistent/run-1"), name: Option.some("run-1") }),
  DigestEvent.cases.Item.make({ ...base, t: T + 1, id: "pay", text: "Pick the billing day.", state: "needs-you", owner: "mine", who: Option.none(), level: Option.some("red"), unit: Option.none() }),
]

/** data.js's global, read back as the page reads it. */
const PageData = Schema.Struct({ now: Schema.Finite, lastRead: Schema.Finite, projects: Schema.Array(Project) })
const readData = (text: string) => Schema.decodeUnknownSync(Schema.fromJsonString(PageData))(text.replace(/^[^\n]*\nwindow\.DIGEST3 = /, "").trim())

describe("digest export", () => {
  test("writes data.js from the log by rename, its projects as r3 reads them, a bad line skipped", async () => {
    using held = scratch("digest-export-")
    const dir = join(held.path, "log")
    const log = FileLog.make(dir)
    await Effect.runPromise(Effect.forEach([...EVENTS.map(encodeLine), "not json"], (line) => log.append(line, T), { discard: true }))
    const out = join(held.path, "data.js")
    expect(await Effect.runPromise(main(["--out", out, "--dir", dir]))).toBe(0)
    expect(readdirSync(held.path).toSorted()).toEqual(["data.js", "log"])
    const text = readFileSync(out, "utf8")
    expect(text.split("\n")[1]?.startsWith("window.DIGEST3 = {")).toBe(true)
    const data = readData(text)
    expect(data.lastRead).toBe(0)
    expect(data.projects.map((project) => [project.repo, project.messages.map((message) => message.src)])).toEqual([["demo", ["item:pay"]]])
  })

  test("arguments without --out write nothing and exit 1", async () => {
    using held = scratch("digest-export-")
    expect(await Effect.runPromise(main(["--dir", held.path]))).toBe(1)
    expect(readdirSync(held.path)).toEqual([])
  })
})
