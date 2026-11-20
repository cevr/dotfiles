// The plugin's place on disk, and its reach: the file log is under the state directory in force (a scratch one in a
// test), and no simulation can reach the host's real log. The RPC itself is checked on the world
// (digest.sim.test.ts).
import { describe, expect, test } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { ConfigProvider, Effect, Path } from "effect"
import * as TuiDirs from "@dotfiles/decider/tui-dirs"
import { dirOf } from "./server.ts"

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
