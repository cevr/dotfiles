/**
 * `digest export`: the prototype page's data (`data.js`, r3's `window.DIGEST3`) from this host's digest log, written
 * by rename so the open page never reads half of it.
 *
 *   bun cmd/digest/export.ts --out <data.js> [--dir <log dir>] [--frozen <day dir>]
 *
 * `--dir` is the log's directory (default `$XDG_STATE_HOME/opencode-digest`, the digest plugin's); `--frozen` adds a
 * frozen day's old stores, read by the backfill, before the log's own lines. Read state is the page's (unit 2), so
 * `lastRead` is 0: every message reads as new until the page marks it.
 */
import { parseArgs } from "node:util"
import { Clock, DateTime, Effect, Option, Schema } from "effect"
import * as TuiDirs from "@dotfiles/decider/tui-dirs"
import { backfill } from "@dotfiles/opencode-digest/backfill"
import { decodeLines, type DigestEvent } from "@dotfiles/opencode-digest/event"
import * as FileLog from "@dotfiles/opencode-digest/filestore/log"
import { dataJs, writeByRename } from "@dotfiles/opencode-digest/filestore/page"
import { readStores } from "@dotfiles/opencode-digest/filestore/stores"
import { EMPTY, fold } from "@dotfiles/opencode-digest/fold"
import { pageOf, Project } from "@dotfiles/opencode-digest/messages"

/** The page's data, as r3's page reads it. */
const PageData = Schema.Struct({ note: Schema.String, now: Schema.Finite, lastRead: Schema.Finite, projects: Schema.Array(Project) })
const encodeData = Schema.encodeEffect(Schema.fromJsonString(PageData))

/** The page's data over `events`, at `now`. */
export const dataOf = (events: ReadonlyArray<DigestEvent>, now: number) =>
  encodeData({ note: `From the digest log, ${DateTime.formatIso(DateTime.makeUnsafe(now))}.`, now, lastRead: 0, projects: pageOf(fold(EMPTY, events), { names: new Map() }).projects })

/** What one export reads and writes. */
export interface Paths {
  readonly out: string
  readonly dir: string
  readonly frozen: Option.Option<string>
}

/** One export: the frozen day's events (if any), then the log's, folded and written to `out`; the events and bad lines counted. */
export const exportPage = (paths: Paths) =>
  Effect.gen(function* () {
    const log = decodeLines(yield* FileLog.make(paths.dir).read)
    const old = Option.match(paths.frozen, { onNone: () => [], onSome: (dir) => backfill(readStores(dir)) })
    const events = [...old, ...log.events]
    const now = yield* Clock.currentTimeMillis
    yield* writeByRename(paths.out, dataJs(yield* dataOf(events, now)))
    return { events: events.length, bad: log.bad }
  })

/** The paths the arguments name; `--out` is required. */
export const pathsOf = (args: ReadonlyArray<string>): Option.Option<Paths> => {
  const { values } = parseArgs({ args: [...args], options: { out: { type: "string" }, dir: { type: "string" }, frozen: { type: "string" } }, strict: true })
  return Option.map(Option.fromUndefinedOr(values.out), (out) => ({
    out,
    dir: Option.getOrElse(Option.fromUndefinedOr(values.dir), () => `${TuiDirs.dirs().state}/opencode-digest`),
    frozen: Option.fromUndefinedOr(values.frozen),
  }))
}

/** Arguments without `--out`. */
class Usage extends Schema.TaggedError<Usage>()("Usage", { message: Schema.String }) {}

/** The export the arguments ask for; its exit code, 0 once written. */
export const main = (args: ReadonlyArray<string>) =>
  Effect.fromOption(pathsOf(args)).pipe(
    Effect.mapError(() => new Usage({ message: "usage: bun cmd/digest/export.ts --out <data.js> [--dir <log dir>] [--frozen <day dir>]" })),
    Effect.flatMap(exportPage),
    Effect.flatMap((done) => Effect.as(Effect.log(`digest export: ${done.events} events, ${done.bad} bad lines skipped`), 0)),
    Effect.catch((error) => Effect.as(Effect.logError(`digest export: ${error.message}`), 1)),
  )

if (import.meta.main) Effect.runFork(Effect.tap(main(Bun.argv.slice(2)), (code) => Effect.sync(() => void (process.exitCode = code))))
