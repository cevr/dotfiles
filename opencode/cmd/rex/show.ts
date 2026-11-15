#!/usr/bin/env bun
/**
 * rex-show: show work in a pane beside you in Rex. Run it from a terminal
 * Rex opened (an OpenCode tool shell carries its TUI's pane): it finds the
 * pane labeled `showcase` in your session, or splits one off beside your
 * pane, and draws there.
 *
 *   rex-show image FILE                 a PNG, as large as the pane allows
 *   rex-show md FILE                    a Markdown file, as styled text
 *   rex-show url URL [--every S] [--width PX]
 *                                       a web page, shot by a headless Chrome
 *                                       on this host every S seconds (5) at
 *                                       PX pixels wide (1280), redrawn when
 *                                       the shot changes; a page that does
 *                                       not answer shows as an error line
 *   rex-show tally TEXT [--progress N] [--state working|done|blocked|error|idle]
 *                                       a line in the pane and in Rex's tab
 *                                       header (OSC 7501, record `tally`)
 *   rex-show view --session ID [--spool DIR]
 *                                       the showcase pane's own program
 *
 * It prints the showcase's block id. Exit 2: not in a Rex pane
 * (REX_SESSION and REX_BLOCK unset), or a usage error; exit 1: Rex or the
 * spool failed (a page that does not answer is the pane's to show, not an
 * exit). The spool is `$XDG_STATE_HOME/rex-show/<session>/`, and the
 * viewer is told it; the viewer is started as this same program (Bun and
 * this script, so a PATH without rex-show still finds it), or as
 * `$REX_SHOW_BIN view …` when that is set; Rex's tool as
 * `$REX_BIN_DIR/rex` when Rex set it, else `rex`.
 */
import { readFile } from "node:fs/promises"
import { basename, resolve } from "node:path"
import * as TuiDirs from "@dotfiles/decider/tui-dirs"
import * as FileSpool from "@dotfiles/opencode-rex/filestore/spool"
import { Content, frame, roomOf } from "@dotfiles/opencode-rex/frame"
import { type Cells, type CellPixels, DEFAULT_CELL } from "@dotfiles/opencode-rex/graphics"
import { setTally, showFile, showUrl } from "@dotfiles/opencode-rex/model"
import { type Pane, paneOf } from "@dotfiles/opencode-rex/pane"
import * as ProcessBrowser from "@dotfiles/opencode-rex/process/browser"
import * as ProcessRex from "@dotfiles/opencode-rex/process/rex"
import { Browser, Spool } from "@dotfiles/opencode-rex/service"
import { DEFAULT_EVERY, DEFAULT_WIDTH, due, fingerprint, nameOf, type Taken, viewport } from "@dotfiles/opencode-rex/shots"
import { empty, Page, Picture, Shown, Url } from "@dotfiles/opencode-rex/spool"
import { TallyState } from "@dotfiles/opencode-rex/status"
import { answered, CELL_QUERIES, cellOf } from "@dotfiles/opencode-rex/terminal"
import { Array as Arr, Clock, Config, Console, Data, Effect, Exit, Layer, Option, Schema } from "effect"

/** A refusal with its exit code: 2 for a usage error or no pane, 1 for a failed call. */
export class Refused extends Schema.TaggedError<Refused>()("Refused", { message: Schema.String, code: Schema.Int }) {}

export const USAGE = [
  "usage: rex-show image FILE",
  "       rex-show md FILE",
  "       rex-show url URL [--every SECONDS] [--width PX]",
  "       rex-show tally TEXT [--progress N] [--state working|done|blocked|error|idle]",
].join("\n")

const usage = (why: string) => new Refused({ message: `rex-show: ${why}\n${USAGE}`, code: 2 })

/** How often the viewer looks at the spool and the pane's size. */
const LOOK_EVERY = "250 millis"

/** This process as it was started: Bun and the script, before the arguments; the showcase's viewer is started the same way. */
const SELF = process.argv.slice(0, 2)

/** A request rex-show understood. */
export type Request = Data.TaggedEnum<{
  Show: { readonly shown: Picture | Page }
  Visit: { readonly page: Url }
  Tally: { readonly msg: string; readonly progress: Option.Option<number>; readonly state: TallyState }
  View: { readonly session: string; readonly spool: Option.Option<string> }
}>
export const Request = Data.taggedEnum<Request>()

const flag = (args: ReadonlyArray<string>, name: string): Option.Option<string> =>
  Option.flatMap(
    Option.filter(Option.some(args.indexOf(name)), (at) => at >= 0),
    (at) => Arr.get(args, at + 1),
  )

const positional = (args: ReadonlyArray<string>, flags: ReadonlyArray<string>) =>
  args.filter((arg, at) => !flags.includes(arg) && !(at > 0 && flags.includes(args[at - 1])))

/** The one positional argument, or a usage refusal naming what `command` takes. */
const single = (args: ReadonlyArray<string>, command: string, what: string) =>
  Option.match(Option.liftPredicate(args, (all) => all.length === 1), {
    onNone: () => Effect.fail(usage(`${command} takes one ${what}`)),
    onSome: ([only]) => Effect.succeed(only),
  })

const decodeState = Schema.decodeUnknownOption(TallyState)
const decodePercent = Schema.decodeUnknownOption(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 100 })))

/** A flag's value decoded, none when the flag is absent, and a usage refusal when it is there but does not decode. */
const decoded = <A>(args: ReadonlyArray<string>, name: string, decode: (text: string) => Option.Option<A>, why: string) =>
  Option.match(flag(args, name), {
    onNone: () => Effect.succeed(Option.none<A>()),
    onSome: (text) =>
      Option.match(decode(text), { onNone: () => Effect.fail(usage(`${name} ${why}`)), onSome: (value) => Effect.succeed(Option.some(value)) }),
  })

const tally = Effect.fn("RexShow.tally")(function* (rest: ReadonlyArray<string>) {
  const msg = yield* single(positional(rest, ["--progress", "--state"]), "tally", "TEXT")
  const progress = yield* decoded(rest, "--progress", (text) => decodePercent(Number(text)), "takes a whole number from 0 to 100")
  const state = yield* decoded(rest, "--state", decodeState, "takes working, done, blocked, error or idle")
  return Request.Tally({ msg, progress, state: Option.getOrElse(state, (): TallyState => "working") })
})

const show = Effect.fn("RexShow.show")(function* (command: "image" | "md", rest: ReadonlyArray<string>) {
  const file = yield* single(rest, command, "FILE")
  const fields = { file: resolve(file), name: basename(file) }
  return Request.Show({ shown: Option.match(Option.liftPredicate(command, (name) => name === "image"), { onSome: () => Picture.make(fields), onNone: () => Page.make(fields) }) })
})

const decodeEvery = Schema.decodeUnknownOption(Schema.Number.check(Schema.isBetween({ minimum: 1, maximum: 3600 })))
const decodeWidth = Schema.decodeUnknownOption(Schema.Int.check(Schema.isBetween({ minimum: 200, maximum: 4096 })))

/** `text` as an http or https URL; none for anything else. */
const webUrl = (text: string) =>
  Option.filter(Option.liftThrowable(() => new URL(text))(), (url) => url.protocol === "http:" || url.protocol === "https:")

const visit = Effect.fn("RexShow.visit")(function* (rest: ReadonlyArray<string>) {
  const text = yield* single(positional(rest, ["--every", "--width"]), "url", "URL")
  const url = yield* Option.match(webUrl(text), { onNone: () => Effect.fail(usage(`url takes an http or https URL, not ${text}`)), onSome: Effect.succeed })
  const every = yield* decoded(rest, "--every", (value) => decodeEvery(Number(value)), "takes seconds from 1 to 3600")
  const width = yield* decoded(rest, "--width", (value) => decodeWidth(Number(value)), "takes a whole number of pixels from 200 to 4096")
  return Request.Visit({
    page: Url.make({ url: url.href, name: nameOf(url), every: Option.getOrElse(every, () => DEFAULT_EVERY), width: Option.getOrElse(width, () => DEFAULT_WIDTH) }),
  })
})

const view = Effect.fn("RexShow.viewRequest")(function* (rest: ReadonlyArray<string>) {
  const session = yield* Option.match(flag(rest, "--session"), { onNone: () => Effect.fail(usage("view takes --session ID")), onSome: Effect.succeed })
  return Request.View({ session, spool: flag(rest, "--spool") })
})

/** The request `args` make, or a usage refusal. */
export const parse = Effect.fn("RexShow.parse")(function* (args: ReadonlyArray<string>) {
  const [command, ...rest] = args
  if (command === "image" || command === "md") return yield* show(command, rest)
  if (command === "url") return yield* visit(rest)
  if (command === "tally") return yield* tally(rest)
  if (command === "view") return yield* view(rest)
  return yield* usage(Option.match(Arr.head(args), { onNone: () => "no command", onSome: (name) => `unknown command ${name}` }))
})

const optional = (name: string) => Config.option(Config.String(name)).pipe(Config.map(Option.filter((value) => value !== "")))

/** The caller's pane, from the variables Rex gives a terminal's programs; refused (exit 2) outside one. */
const callerPane = Effect.gen(function* () {
  const session = yield* optional("REX_SESSION")
  const block = yield* optional("REX_BLOCK")
  return yield* Option.match(paneOf({ REX_SESSION: Option.getOrUndefined(session), REX_BLOCK: Option.getOrUndefined(block) }), {
    onNone: () =>
      Effect.fail(
        new Refused({ message: "rex-show: not in a Rex pane (REX_SESSION and REX_BLOCK are unset); run it from a terminal Rex opened", code: 2 }),
      ),
    onSome: (pane: Pane) => Effect.succeed(pane),
  })
})

const failed = (error: { readonly message: string }) => new Refused({ message: `rex-show: ${error.message}`, code: 1 })

/** What the shown file holds, read for a frame; a file that cannot be read says why. */
const contentOf = (shown: Picture | Page) =>
  Effect.tryPromise({ try: () => readFile(shown.file), catch: (cause) => String(cause) }).pipe(
    Effect.match({
      onSuccess: (bytes) => Content.Bytes({ bytes }),
      onFailure: (reason) => Content.Unreadable({ reason: `cannot read ${shown.name}: ${reason}` }),
    }),
  )

/** The pane the viewer draws in: its size, its cells' size in pixels (asked when its size changes), and the text it writes. */
export interface Screen {
  readonly size: Effect.Effect<Cells>
  readonly cell: (size: Cells) => Effect.Effect<CellPixels>
  readonly display: (text: string) => Effect.Effect<void>
}

/** What a shot of the page holds: its PNG, or the error line, and its fingerprint. */
const shotOf = (result: Exit.Exit<Uint8Array, { readonly message: string }>) =>
  Exit.match(result, {
    onSuccess: (bytes) => ({ content: Content.Bytes({ bytes }), print: fingerprint(bytes) }),
    onFailure: (cause) => {
      const reason = Option.match(Exit.findErrorOption(result), { onNone: () => String(cause), onSome: (error) => error.message })
      return { content: Content.Unreadable({ reason }), print: fingerprint(new TextEncoder().encode(reason)) }
    },
  })

/**
 * The showcase pane's program: draws the session's spool again whenever it
 * or the pane's size changes; a web page it shoots again when due, and
 * draws again only when the shot differs from the last.
 */
export const viewer = Effect.fn("RexShow.view")(function* (session: string, screen: Screen) {
  const spool = yield* Spool
  const browser = yield* Browser
  const drawn = { key: "", sized: "", cell: DEFAULT_CELL, taken: Option.none<Taken>(), shot: Option.none<Content>() }
  /** The page shot again when it is due, its content and fingerprint kept. */
  const shoot = Effect.fn("RexShow.shoot")(function* (page: Url, seq: number, room: Cells) {
    const now = yield* Clock.currentTimeMillis
    if (!due(drawn.taken, seq, drawn.sized, now, page.every * 1000)) return
    const taken = shotOf(yield* Effect.exit(browser.shoot({ url: page.url, ...viewport(page.width, room, drawn.cell) })))
    drawn.taken = Option.some({ seq, sized: drawn.sized, at: now, print: taken.print })
    drawn.shot = Option.some(taken.content)
  })
  const look = Effect.gen(function* () {
    // A spool not written yet, or unreadable for a moment, is drawn as nothing shown; the next look reads it again.
    const spooled = yield* spool.read(session).pipe(Effect.catchTag("SpoolFailed", () => Effect.succeed(empty)))
    const size = yield* screen.size
    const sized = `${size.cols}x${size.rows}`
    if (sized !== drawn.sized) {
      drawn.sized = sized
      drawn.cell = yield* screen.cell(size)
    }
    const shown = Option.fromUndefinedOr(spooled.shown)
    const page = Option.filter(shown, Shown.guards.Url)
    yield* Option.match(page, { onNone: () => Effect.void, onSome: (url) => shoot(url, spooled.seq, roomOf(spooled, size)) })
    const print = Option.match(Option.flatMap(page, () => drawn.taken), { onNone: () => "", onSome: (taken) => `:${taken.print}` })
    const key = `${spooled.seq}:${sized}${print}`
    if (key === drawn.key) return
    drawn.key = key
    const content = yield* Option.match(shown, {
      onNone: () => Effect.succeed(Option.none<Content>()),
      onSome: (item) =>
        Shown.match(item, {
          Url: () => Effect.succeed(drawn.shot),
          Picture: (picture) => Effect.map(contentOf(picture), Option.some),
          Page: (text) => Effect.map(contentOf(text), Option.some),
        }),
    })
    yield* screen.display(frame(spooled, content, size, drawn.cell))
  })
  return yield* Effect.forever(Effect.andThen(look, Effect.sleep(LOOK_EVERY)))
})

/** Where a run finds Rex's tool and keeps the spool (unless the viewer is told its spool), and how it starts itself again as the viewer. */
export interface Settings {
  readonly rex: string
  readonly spool: string
  readonly self: ReadonlyArray<string>
}

/** The spool a request uses: the viewer's own when it was told one, else the settings'. */
export const spoolOf = (request: Request, settings: Settings): string =>
  Request.$match(request, {
    View: (asked) => Option.getOrElse(asked.spool, () => settings.spool),
    Show: () => settings.spool,
    Visit: () => settings.spool,
    Tally: () => settings.spool,
  })

/**
 * `request` with `settings`, drawing on `screen` when it is the viewer; the
 * showcase's block id for a call. The viewer is started with the spool this
 * call writes, so the two agree whatever the pane's environment.
 */
export const run = Effect.fn("RexShow.run")(
  function* (request: Request, screen: Screen, settings: Settings) {
    if (request._tag === "View") return yield* viewer(request.session, screen)
    const pane = yield* callerPane
    const bin = yield* optional("REX_SHOW_BIN")
    const start = Option.match(bin, { onNone: () => settings.self, onSome: (path) => [path] })
    const program = [...start, "view", "--session", pane.session, "--spool", settings.spool]
    if (request._tag === "Show") return yield* showFile(pane, request.shown, program)
    if (request._tag === "Visit") return yield* showUrl(pane, request.page, program)
    return yield* setTally(pane, { msg: request.msg, state: request.state, progress: Option.getOrUndefined(request.progress) }, program)
  },
  Effect.catchTags({ RexFailed: (error) => Effect.fail(failed(error)), SpoolFailed: (error) => Effect.fail(failed(error)) }),
)

/**
 * The settings from the environment: Rex's tool beside the Rex that opened
 * this terminal (else `rex` on PATH), the spool under the state directory,
 * and `self`, how this process was started.
 */
export const settingsOf = (self: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const dir = yield* optional("REX_BIN_DIR")
    return {
      rex: Option.match(dir, { onNone: () => "rex", onSome: (path) => `${path}/rex` }),
      spool: `${TuiDirs.dirs().state}/rex-show`,
      self,
    } satisfies Settings
  })

/** The settings `args` run with: the environment's, the spool the viewer was told in place of its own. */
const settingsFor = Effect.fn("RexShow.settingsFor")(function* (args: ReadonlyArray<string>) {
  const settings = yield* settingsOf(SELF)
  const request = yield* parse(args)
  return { ...settings, spool: spoolOf(request, settings) } satisfies Settings
})

/** Where this host's headless browser is looked for: `$REX_SHOW_CHROME`, the host, the home folder and `$PLAYWRIGHT_BROWSERS_PATH`. */
const placesOf = Effect.gen(function* () {
  return {
    chosen: yield* optional("REX_SHOW_CHROME"),
    platform: process.platform,
    home: TuiDirs.dirs().home,
    playwright: yield* optional("PLAYWRIGHT_BROWSERS_PATH"),
  } satisfies ProcessBrowser.Places
})

/** The live systems `args` run on: Rex's tool, the spool and the browser, as `settingsFor` and `placesOf` find them. */
export const live = (args: ReadonlyArray<string>) =>
  Layer.unwrap(
    Effect.gen(function* () {
      const settings = yield* settingsFor(args)
      return Layer.mergeAll(ProcessRex.layer(settings.rex), FileSpool.layer(settings.spool), ProcessBrowser.layer(yield* placesOf))
    }),
  )

/** rex-show on `args`, needing Rex and the spool. */
export const main = Effect.fn("RexShow.main")(function* (args: ReadonlyArray<string>, screen: Screen) {
  return yield* run(yield* parse(args), screen, yield* settingsFor(args))
})

/** The exit code of a finished run: 0 with the block id printed, else the refusal's after its words. */
export const finish = (exit: Exit.Exit<string, unknown>): Effect.Effect<number> =>
  Exit.match(exit, {
    onSuccess: (block) => Effect.as(Console.log(block), 0),
    onFailure: (cause) =>
      Option.match(Option.filter(Exit.findErrorOption(exit), Schema.is(Refused)), {
        onNone: () => Effect.as(Console.error(`rex-show: ${String(cause)}`), 1),
        onSome: (refused) => Effect.as(Console.error(refused.message), refused.code),
      }),
  })

/** How long the viewer waits for its terminal to say its cells' size. */
const CELL_WAIT_MS = 500

/**
 * This terminal's cell size: the queries written, the replies read from
 * input in raw mode until they are in or the wait is over; the default cell
 * when input is no terminal or nothing came.
 */
const askCell = (size: Cells) =>
  Effect.callback<CellPixels>((resume) => {
    const input = process.stdin
    if (!input.isTTY) return resume(Effect.succeed(DEFAULT_CELL))
    const heard = { text: "", done: false }
    const finish = () => {
      if (heard.done) return
      heard.done = true
      clearTimeout(timer)
      input.off("data", onData)
      input.setRawMode(false)
      input.pause()
      resume(Effect.succeed(Option.getOrElse(cellOf(heard.text, size), () => DEFAULT_CELL)))
    }
    const onData = (chunk: Buffer) => {
      heard.text += chunk.toString("latin1")
      if (answered(heard.text)) finish()
    }
    const timer = setTimeout(finish, CELL_WAIT_MS)
    input.setRawMode(true)
    input.resume()
    input.on("data", onData)
    process.stdout.write(CELL_QUERIES)
  })

/** This process's terminal as the viewer's screen. */
const terminal: Screen = {
  size: Effect.sync(() => ({ cols: process.stdout.columns || 80, rows: process.stdout.rows || 24 })),
  cell: askCell,
  display: (text) => Effect.sync(() => void process.stdout.write(text)),
}

const ARGS = process.argv.slice(2)

if (import.meta.main) process.exitCode = await Effect.runPromise(main(ARGS, terminal).pipe(Effect.provide(live(ARGS)), Effect.exit, Effect.flatMap(finish)))
