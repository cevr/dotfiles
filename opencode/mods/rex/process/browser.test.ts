// The headless browser adapter against a stand-in browser (fake-browser.sh)
// and a page served here: which browser it finds, the arguments of a shot
// (headless, a scratch profile, the viewport, the page last), the shot read
// back and its scratch folder removed, and each way a shot fails.
import { describe, expect } from "bun:test"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { Array as Arr, Context, Effect, Exit, Fiber, Layer, Option, Schedule } from "effect"
import { effectTest } from "../../../sim-tui/effect-test.ts"
import { Browser } from "../service.ts"
import * as ProcessBrowser from "./browser.ts"

const FAKE = fileURLToPath(new URL("./fake-browser.sh", import.meta.url))

/** A scratch folder for the test's files, removed when the test ends. */
const scratch = Effect.acquireRelease(
  Effect.sync(() => mkdtempSync(join(tmpdir(), "rex-browser-"))),
  (dir) => Effect.sync(() => rmSync(dir, { recursive: true, force: true })),
)

describe("which browser", () => {
  effectTest(
    "the one REX_SHOW_CHROME names, else Playwright's newest headless shell",
    Effect.scoped(
      Effect.gen(function* () {
        const home = yield* scratch
        const shell = (revision: number) => join(home, ".cache", "ms-playwright", `chromium_headless_shell-${revision}`, "chrome-headless-shell-linux64", "chrome-headless-shell")
        yield* Effect.sync(() =>
          [1223, 1248].forEach((revision) => {
            mkdirSync(join(shell(revision), ".."), { recursive: true })
            writeFileSync(shell(revision), "")
          }),
        )
        const places = { chosen: Option.none<string>(), platform: "linux", home, playwright: Option.none<string>() }
        expect(ProcessBrowser.findBrowser(places)).toEqual(Option.some(shell(1248)))
        expect(ProcessBrowser.findBrowser({ ...places, chosen: Option.some("/opt/chrome") })).toEqual(Option.some("/opt/chrome"))
      }),
    ),
    5_000,
  )
})

/** The stand-in browser in `mode` as the Browser, and its log. */
class Fake extends Context.Service<Fake, { readonly log: string }>()("test/FakeBrowser") {}

const fake = (mode: string) =>
  Layer.unwrap(
    Effect.map(scratch, (dir) => {
      const log = join(dir, "log")
      const tool = join(dir, "chrome")
      writeFileSync(log, "")
      writeFileSync(tool, `#!/bin/sh\nFAKE_BROWSER_LOG='${log}' FAKE_BROWSER_MODE='${mode}' exec '${FAKE}' "$@"\n`)
      chmodSync(tool, 0o755)
      const places = { chosen: Option.some(tool), platform: "linux", home: dir, playwright: Option.none<string>() }
      return Layer.merge(ProcessBrowser.layer(places), Layer.succeed(Fake, Fake.of({ log })))
    }),
  )

/** A page served on a free port for the test's span: its URL. */
const served = Effect.map(
  Effect.acquireRelease(
    Effect.sync(() => Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("<h1>hello</h1>", { headers: { "content-type": "text/html" } }) })),
    (server) => Effect.promise(() => server.stop(true)),
  ),
  (server) => `http://127.0.0.1:${server.port}/`,
)

/** A URL nothing listens on: a port served a moment, then closed. */
const closed = Effect.scoped(served)

const calls = Fake.use((held) => Effect.sync(() => readFileSync(held.log, "utf8").split("\n").filter((line) => line !== "")))

describe("a shot", () => {
  effectTest(
    "runs the browser headless with a scratch profile at the viewport's size, the page last, reads the PNG back, and removes its folder",
    Effect.scoped(
      Effect.gen(function* () {
        const url = yield* served
        const browser = yield* Browser
        const bytes = yield* browser.shoot({ url, width: 800, height: 600 })
        expect(Array.from(bytes.slice(1, 4), (code) => String.fromCharCode(code)).join("")).toBe("PNG")
        const [line] = yield* calls
        const profile = Option.getOrThrow(Option.fromNullishOr(/--user-data-dir=(\S+)/.exec(line)))[1]
        expect(line).toStartWith("--headless --hide-scrollbars --no-first-run --no-default-browser-check")
        expect(line).toContain("--window-size=800,600")
        expect(line).toEndWith(` ${url}`)
        expect(profile).toStartWith(join(tmpdir(), "rex-show-chrome-"))
        expect(existsSync(join(profile, ".."))).toBe(false)
      }),
    ).pipe(Effect.provide(fake("ok"))),
    10_000,
  )

  effectTest(
    "of a page that does not answer fails with why, and runs no browser",
    Effect.gen(function* () {
      const url = yield* closed
      const browser = yield* Browser
      const exit = yield* Effect.exit(browser.shoot({ url, width: 800, height: 600 }))
      expect(String(exit)).toContain(`cannot reach ${url}: ECONNREFUSED`)
      expect(yield* calls).toEqual([])
    }).pipe(Effect.provide(fake("ok"))),
    10_000,
  )

  effectTest(
    "that the browser does not write fails with its exit and last words",
    Effect.scoped(
      Effect.gen(function* () {
        const url = yield* served
        const browser = yield* Browser
        const exit = yield* Effect.exit(browser.shoot({ url, width: 800, height: 600 }))
        expect(Exit.isFailure(exit)).toBe(true)
        expect(String(exit)).toContain("the browser made no shot (exit 4): headless: page crashed")
      }),
    ).pipe(Effect.provide(fake("blank"))),
    10_000,
  )

  effectTest(
    "given a settle time lets the page's scripts run that long first",
    Effect.scoped(
      Effect.gen(function* () {
        const url = yield* served
        const browser = yield* Browser
        yield* browser.shoot({ url, width: 800, height: 600, settle: 5_000 })
        const [line] = yield* calls
        expect(line).toEndWith(` --virtual-time-budget=5000 ${url}`)
      }),
    ).pipe(Effect.provide(fake("ok"))),
    10_000,
  )

  effectTest(
    "interrupted, kills the browser and the helpers it started, leaving no process behind",
    Effect.scoped(
      Effect.gen(function* () {
        const url = yield* served
        const browser = yield* Browser
        const shooting = yield* Effect.forkChild(browser.shoot({ url, width: 800, height: 600 }))
        // The stand-in logs its own pid and its helper's once both run.
        const pids = yield* calls.pipe(
          Effect.map((lines) => Arr.findFirst(lines, (line) => line.startsWith("pids "))),
          Effect.flatMap(Effect.fromOption),
          Effect.retry({ schedule: Schedule.spaced("20 millis"), times: 250 }),
          Effect.map((line) => line.split(" ").slice(1).map(Number)),
        )
        yield* Fiber.interrupt(shooting)
        const alive = (pid: number) => Bun.spawnSync(["ps", "-o", "stat=", "-p", String(pid)], { stdout: "pipe" }).stdout.toString().trim().replace(/^Z.*/, "")
        const gone = yield* Effect.sync(() => pids.map(alive)).pipe(
          Effect.filterOrFail((states) => states.every((state) => state === "")),
          Effect.retry({ schedule: Schedule.spaced("50 millis"), times: 60 }),
          Effect.orElseSucceed(() => pids.map(alive)),
        )
        expect({ pids: pids.length, gone }).toEqual({ pids: 2, gone: ["", ""] })
      }),
    ).pipe(Effect.provide(fake("hang"))),
    10_000,
  )
})
