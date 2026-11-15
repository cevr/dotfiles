// A headless Chrome or Chromium on this host, as the Browser: each shot asks
// the page first (so a page that does not answer is an error line, not
// Chrome's own error page), then runs the browser once with a fresh profile
// in a temporary folder (never the owner's), `--screenshot` at the
// viewport's size, and removes the folder after. The browser is the one
// `$REX_SHOW_CHROME` names, else the first found of: Google Chrome or
// Chromium installed on a Mac, Playwright's headless shell or Chromium
// (its cache, newest first: what the workbox has), then `chromium` or
// `google-chrome` on PATH. A live tab (`open`) runs the same browser,
// headless with a fresh profile, kept running with its debugger on a port
// of its own on loopback, for as long as the tab's scope lasts.
import { existsSync, readdirSync } from "node:fs"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Array as Arr, Effect, Layer, Option, Schedule, Schema } from "effect"
import { isPng } from "../graphics.ts"
import { Browser, type Command, type Shot, ShotFailed } from "../service.ts"
import { connect } from "./cdp.ts"
import { keepGroup, lastLine, runGroup } from "./group.ts"

/** How long the page has to answer before it is taken as unreachable. */
const REACH_MS = 5_000

/** How long one browser run may take before it is killed. */
const SHOT_MS = 30_000

/** How long a live browser has to open its debugger. */
const DEBUGGER_MS = 15_000

/** Where to look for a browser: the environment's choice, the host, and its home. */
export interface Places {
  readonly chosen: Option.Option<string>
  readonly platform: string
  readonly home: string
  readonly playwright: Option.Option<string>
}

/** The Mac's installed browsers, in the order they are tried. */
const MAC_APPS = ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Chromium.app/Contents/MacOS/Chromium"]

/** The programs on PATH tried last. */
const ON_PATH = ["chromium", "chromium-browser", "google-chrome", "google-chrome-stable"]

/** Playwright's browser cache: `$PLAYWRIGHT_BROWSERS_PATH`, else its default for the host. */
const playwrightCache = (places: Places) =>
  Option.getOrElse(places.playwright, () =>
    join(places.home, ...Option.match(Option.liftPredicate(places.platform, (name) => name === "darwin"), { onSome: () => ["Library", "Caches"], onNone: () => [".cache"] }), "ms-playwright"),
  )

const entries = (dir: string): ReadonlyArray<string> => Option.getOrElse(Option.liftThrowable(() => readdirSync(dir))(), () => [])

/** The browser programs in Playwright's cache, newest revision first, the headless shell before full Chromium. */
const fromPlaywright = (cache: string): ReadonlyArray<string> => {
  const revisions = (prefix: string) =>
    entries(cache)
      .filter((name) => name.startsWith(prefix))
      .toSorted((left, right) => Number(right.slice(prefix.length)) - Number(left.slice(prefix.length)))
  const shells = revisions("chromium_headless_shell-").flatMap((revision) =>
    entries(join(cache, revision)).map((build) => join(cache, revision, build, "chrome-headless-shell")),
  )
  const chromiums = revisions("chromium-").flatMap((revision) =>
    entries(join(cache, revision)).flatMap((build) => [join(cache, revision, build, "chrome"), join(cache, revision, build, "Chromium.app", "Contents", "MacOS", "Chromium")]),
  )
  return [...shells, ...chromiums]
}

/** The browser to run, as `places` finds it: the chosen one, else the first that exists; none when there is none. */
export const findBrowser = (places: Places): Option.Option<string> =>
  Option.orElse(places.chosen, () =>
    Option.orElse(
      Arr.findFirst(
        [...Option.match(Option.liftPredicate(places.platform, (name) => name === "darwin"), { onSome: () => MAC_APPS, onNone: () => [] }), ...fromPlaywright(playwrightCache(places))],
        (path) => existsSync(path),
      ),
      () => Arr.findFirst(ON_PATH.map((name) => Option.fromNullishOr(Bun.which(name))), Option.isSome).pipe(Option.flatten),
    ),
  )

/** The browser's arguments for one shot of `shot` into `folder`: headless, a profile of its own, no first-run pages, and the page's scripts given `settle` ms of its own time when asked. */
export const browserArgs = (shot: Shot, folder: string): ReadonlyArray<string> => [
  "--headless",
  "--hide-scrollbars",
  "--no-first-run",
  "--no-default-browser-check",
  "--disable-gpu",
  "--mute-audio",
  `--user-data-dir=${join(folder, "profile")}`,
  `--window-size=${shot.width},${shot.height}`,
  `--screenshot=${join(folder, "shot.png")}`,
  ...Option.match(Option.fromUndefinedOr(shot.settle), { onNone: () => [], onSome: (ms) => [`--virtual-time-budget=${ms}`] }),
  shot.url,
]

/** The browser's arguments for a live tab kept in `folder`: headless, a profile of its own, no first-run pages, its debugger on a free port on loopback, a blank page until the tab is set up. */
export const liveArgs = (folder: string): ReadonlyArray<string> => [
  "--headless",
  "--hide-scrollbars",
  "--no-first-run",
  "--no-default-browser-check",
  "--disable-gpu",
  "--mute-audio",
  `--user-data-dir=${join(folder, "profile")}`,
  "--remote-debugging-address=127.0.0.1",
  "--remote-debugging-port=0",
  "about:blank",
]

const Targets = Schema.fromJsonString(Schema.Array(Schema.Struct({ type: Schema.String, webSocketDebuggerUrl: Schema.optional(Schema.String) })))
const decodeTargets = Schema.decodeUnknownOption(Targets)

/** The debugger socket of the browser's page, once the browser wrote its port to `DevToolsActivePort` in its profile and lists the page. */
const pageSocket = (folder: string, failed: (message: string) => ShotFailed) =>
  Effect.gen(function* () {
    const port = yield* Effect.tryPromise({ try: () => readFile(join(folder, "profile", "DevToolsActivePort"), "utf8"), catch: () => failed("no debugger port yet") }).pipe(
      Effect.map((written) => written.split("\n")[0].trim()),
      Effect.filterOrFail((found) => /^\d+$/.test(found), () => failed("no debugger port yet")),
    )
    const listed = yield* Effect.tryPromise({
      try: () => fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(REACH_MS) }).then((answer) => answer.text()),
      catch: (cause) => failed(`cannot list the browser's pages: ${why(cause)}`),
    })
    return yield* Option.match(
      Option.flatMap(decodeTargets(listed), (targets) => Arr.findFirst(targets, (target) => target.type === "page").pipe(Option.flatMap((page) => Option.fromUndefinedOr(page.webSocketDebuggerUrl)))),
      { onNone: () => Effect.fail(failed("the browser lists no page yet")), onSome: Effect.succeed },
    )
  }).pipe(Effect.retry({ schedule: Schedule.spaced("100 millis"), times: DEBUGGER_MS / 100 }))

/** A failed request's error code, as Bun's fetch gives it (ECONNREFUSED, ConnectionRefused, TimeoutError…). */
const decodeCode = Schema.decodeUnknownOption(Schema.Struct({ code: Schema.String }))

/** Why a request failed, in a few words: its error code when it has one, else its message. */
const why = (cause: unknown) =>
  Option.match(decodeCode(cause), {
    onNone: () => String(cause),
    onSome: (failure) => failure.code,
  })

/** Asks `url` (http or https only) whether it answers at all; any status counts, a refused or timed-out request does not. */
const reach = Effect.fn("ProcessBrowser.reach")(function* (url: string) {
  if (!/^https?:/i.test(url)) return
  const answer = yield* Effect.tryPromise({
    try: () => fetch(url, { redirect: "follow", signal: AbortSignal.timeout(REACH_MS) }),
    catch: (cause) => new ShotFailed({ url, message: `cannot reach ${url}: ${why(cause)}` }),
  })
  // Only whether it answers matters: the body is left unread.
  yield* Option.match(Option.fromNullishOr(answer.body), {
    onNone: () => Effect.void,
    onSome: (body) => Effect.promise(() => body.cancel()),
  })
})

/** The browser on this host as the Browser, found in `places` once. */
export const layer = (places: Places) =>
  Layer.sync(Browser, () => {
    const found = findBrowser(places)
    const shoot = Effect.fn("ProcessBrowser.shoot")(function* (shot: Shot) {
      const failed = (message: string) => new ShotFailed({ url: shot.url, message })
      const browser = yield* Option.match(found, {
        onNone: () => Effect.fail(failed("no Chrome or Chromium on this host: install one, or set REX_SHOW_CHROME")),
        onSome: Effect.succeed,
      })
      yield* reach(shot.url)
      return yield* Effect.acquireUseRelease(
        Effect.tryPromise({ try: () => mkdtemp(join(tmpdir(), "rex-show-chrome-")), catch: (cause) => failed(`no scratch folder: ${String(cause)}`) }),
        (folder) =>
          Effect.gen(function* () {
            // Chrome starts helpers: its whole group goes if the shot is interrupted.
            const ran = yield* runGroup([browser, ...browserArgs(shot, folder)], SHOT_MS).pipe(Effect.mapError((why) => failed(`cannot start ${browser}: ${why}`)))
            const code = Option.match(ran.code, { onNone: () => "killed", onSome: String })
            const bytes = yield* Effect.tryPromise({
              try: () => readFile(join(folder, "shot.png")),
              catch: () => failed(`the browser made no shot (exit ${code}): ${lastLine(ran.err)}`),
            })
            if (!isPng(bytes)) return yield* failed("the browser's shot is not a PNG")
            return new Uint8Array(bytes)
          }),
        (folder) => Effect.promise(() => rm(folder, { recursive: true, force: true })),
      )
    })
    const open = Effect.fn("ProcessBrowser.open")(function* (url: string, setup: ReadonlyArray<Command>) {
      const failed = (message: string) => new ShotFailed({ url, message })
      const browser = yield* Option.match(found, {
        onNone: () => Effect.fail(failed("no Chrome or Chromium on this host: install one, or set REX_SHOW_CHROME")),
        onSome: Effect.succeed,
      })
      yield* reach(url)
      const folder = yield* Effect.acquireRelease(
        Effect.tryPromise({ try: () => mkdtemp(join(tmpdir(), "rex-show-live-")), catch: (cause) => failed(`no scratch folder: ${String(cause)}`) }),
        (made) => Effect.promise(() => rm(made, { recursive: true, force: true })),
      )
      // Chrome starts helpers: its whole group goes when the tab's scope closes.
      yield* keepGroup([browser, ...liveArgs(folder)]).pipe(Effect.mapError((why) => failed(`cannot start ${browser}: ${why}`)))
      const tab = yield* connect(yield* pageSocket(folder, failed), url)
      yield* tab.send([{ method: "Page.enable", params: {} }, ...setup, { method: "Page.navigate", params: { url } }])
      return tab
    })
    return Browser.of({ shoot, open })
  })
