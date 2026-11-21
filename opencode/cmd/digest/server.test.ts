// The plugin's place on disk, and its reach: the file log is under the state directory in force (a scratch one in a
// test), and no simulation can reach the host's real log. The RPC itself is checked on the world
// (digest.sim.test.ts).
import { describe, expect, test } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { ConfigProvider, Effect, Exit, Option, Path, Schema } from "effect"
import * as TuiDirs from "@dotfiles/decider/tui-dirs"
import { DigestEvent, encodeLine, VERSION } from "@dotfiles/opencode-digest/event"
import * as FileLog from "@dotfiles/opencode-digest/filestore/log"
import { markOf } from "@dotfiles/opencode-digest/marks"
import { scratch } from "../../tests/scratch.ts"
import { dirOf, handlersOf, Options, zoneOf } from "./server.ts"

/** sim/, from this file's URL (opencode/cmd/digest). */
const SIM = Effect.runSync(Effect.flatMap(Path.Path, (path) => path.fromFileUrl(new URL("../../sim", import.meta.url))).pipe(Effect.provide(Path.layer), Effect.orDie))

/** `body` with `env` as the state directories' source, the one before it put back after. */
const underEnv = <A>(env: Record<string, string>, body: () => A): A =>
  Effect.runSync(
    Effect.acquireUseRelease(
      Effect.sync(() => TuiDirs.install(ConfigProvider.fromEnv({ env }))),
      () => Effect.sync(body),
      (restore) => Effect.sync(restore),
    ),
  )

describe("the digest plugin", () => {
  test("the file log is under the state directory in force, or the `dir` option", () => {
    expect(underEnv({ HOME: "/nonexistent/home", XDG_STATE_HOME: "/nonexistent/state" }, () => dirOf({}))).toBe("/nonexistent/state/opencode-digest")
    expect(underEnv({ HOME: "/nonexistent/home" }, () => dirOf({}))).toBe("/nonexistent/home/.local/state/opencode-digest")
    expect(dirOf({ dir: "/nonexistent/digest" })).toBe("/nonexistent/digest")
  })

  test("digest.timezone: a zone it names (an alias too), the host's by default, and a malformed one refused", () => {
    const decode = Schema.decodeUnknownExit(Options)
    expect(zoneOf({ timezone: "America/Montreal" })).toBe("America/Montreal")
    expect(zoneOf({})).toBe(new Intl.DateTimeFormat().resolvedOptions().timeZone)
    expect([Exit.isSuccess(decode({ timezone: "UTC" })), Exit.isSuccess(decode({ timezone: "Mars/Olympus" })), Exit.isSuccess(decode({ port: 70_000 }))]).toEqual([true, false, false])
  })

  test("the page's view is folded from the log and the marks beside it; a mark written shows at the next read", async () => {
    using held = scratch("digest-server-")
    const options = { dir: join(held.path, "digest"), timezone: "UTC" }
    const t = Date.parse("2026-11-20T12:00:00Z")
    const log = FileLog.make(options.dir)
    const run = DigestEvent.cases.Run.make({ v: VERSION, t, root: "r", host: "mac", repo: "harbor", dir: Option.none(), name: Option.some("harbor") })
    const item = DigestEvent.cases.Item.make({ answer: Option.none(), choices: Option.none(), v: VERSION, t, root: "r", id: "a", text: "Billing ships.", state: "done", owner: "mine", who: Option.none(), level: Option.none(), unit: Option.none() })
    await Effect.runPromise(Effect.forEach([run, item], (event) => log.append(encodeLine(event), event.t), { discard: true }))
    const handlers = handlersOf(options, log, { question: () => Effect.die("no answer here"), item: () => Effect.die("no answer here") })
    const unread = () => Effect.runPromise(Effect.map(handlers.view, (json) => JSON.parse(json).projects.map((project: { readonly unread: number }) => project.unread)))
    expect(await unread()).toEqual([1])
    await Effect.runPromise(handlers.write(markOf("item:r:a", t + 1, "read")))
    expect(await unread()).toEqual([0])
  })

  test("no simulation loads the file log: sim/ reaches the digest only through its memory log", () => {
    // The file log itself, or the plugin's default export (which is on it), imported by a simulation.
    const reaches = /@dotfiles\/opencode-digest\/filestore\/log|import\s+\w+\s*(,\s*\{[^}]*\}\s*)?from\s*["']@dotfiles\/opencode-cmd-digest\/server["']/
    expect(reaches.test('import Digest from "@dotfiles/opencode-cmd-digest/server"')).toBe(true)
    expect(reaches.test('import { make as makeDigest } from "@dotfiles/opencode-cmd-digest/server"')).toBe(false)
    const reaching = readdirSync(SIM)
      .filter((name) => name.endsWith(".ts"))
      .filter((name) => reaches.test(readFileSync(join(SIM, name), "utf8")))
    expect(reaching).toEqual([])
  })
})
