import { describe, expect, test } from "bun:test"
import { argv, Glob, spawnSync } from "bun"
import { INSTALL } from "../git/source.ts"

/** What OpenCode itself provides a plugin at load time (the fork's links), so the copy never installs it. */
const HOST = ["@opencode/*", "@opentui/*", "solid-js", "solid-js/*"]

/** The Bun running this test, which the host runs too. */
const BUN = argv[0]

/** One command's exit code and what it said. */
const sh = (command: ReadonlyArray<string>, cwd: string) => {
  const ran = spawnSync([...command], { cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe" })
  return { code: ran.exitCode, said: `${ran.stdout.toString()}${ran.stderr.toString()}`.trim() }
}

/** This checkout's `opencode/` directory (the tests run in the checkout), where the advance step installs. */
const OPENCODE = `${sh(["git", "rev-parse", "--show-toplevel"], ".").said}/opencode`

const scratch = sh(["mktemp", "-d", "-t", "update-advance"], OPENCODE).said
const copy = `${scratch}/opencode`

/** Bundles `entries` of the copy as the host loads them, every import resolved but the host's own. */
const load = (entries: ReadonlyArray<string>) =>
  sh([BUN, "build", "--target=bun", "--outdir", `${scratch}/out`, ...HOST.flatMap((name) => ["--external", name]), ...entries], copy)

/**
 * The plugins' entry files: every non-test file of `cmd/*`, server, TUI, handoff and job runner alike. A test file,
 * `.ts` or `.tsx` (a simulated TUI test, `*.sim.test.tsx`), is no entry: the host never loads it.
 */
const entries = () => [...new Glob("cmd/*/*.{ts,tsx}").scanSync(copy)].filter((path) => !/\.test\.tsx?$/.test(path)).sort()

/**
 * A fresh copy of the tree, as a host's checkout stands right after its fast-forward: no node_modules. The
 * advance step is `bun install --frozen-lockfile` alone; a plugin whose dependency the install does not bring
 * (the 02:47Z pool, which could not find @dotfiles/opencode-status) fails to load here.
 */
const AFTER_THE_INSTALL = "after the install alone, every cmd plugin loads from a fresh copy; before it, one does not"

describe("the update's advance step", () => {
  test(
    AFTER_THE_INSTALL,
    () => {
      const copied = sh(["sh", "-c", `mkdir -p '${copy}' && git ls-files -co --exclude-standard -z | tar --null -T - -cf - | tar -xf - -C '${copy}'`], OPENCODE)
      expect(copied).toEqual({ code: 0, said: "" })
      const all = entries()
      expect(all).toContain("cmd/pool/server.ts")
      expect(all).toContain("cmd/update/server.ts")
      expect(load(["cmd/pool/server.ts"]).code).not.toBe(0)
      const installed = sh([BUN, ...INSTALL], copy)
      expect([installed.code, installed.said.split("\n").slice(-3).join("\n")]).toEqual([0, expect.any(String)])
      const loaded = load(all)
      expect(loaded.code === 0 || loaded.said).toBe(true)
      spawnSync(["rm", "-rf", scratch])
    },
    { timeout: 300_000 },
  )
})
