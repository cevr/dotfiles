// The sheets in the plugin's storage, one key per session: `session:<id>`.
// `layer` reads them through a plain view of the storage, so the laws run it
// over a stand-in; `fromContext` takes the view from the plugin context.
//
// Where it lives, in the fork: `ctx.storage` (packages/plugin/src/effect/storage.ts)
// is the global database's key-value table under a namespace made from the
// plugin id (packages/core/src/plugin/host.ts:688 `storage`), so the sheets
// outlive a restart and every directory's server reads the same ones. Its
// get, setIf, remove and scan never fail; `scan` pages by `next`. A sheet is
// written only through `setIf` (the fork's KV.setIf: one statement, atomic
// across connections and server processes), keyed on the `rev` kept in the
// sheet, so the tray's copy and the page's, or two servers on one host, never
// both close a question. A fork without `setIf` cannot run this plugin: its
// start fails and says so, rather than write racily.
import type { Plugin } from "@opencode/plugin/effect"
import { Effect, Layer, Option, Predicate, Schema } from "effect"
import { EMPTY, type Row, Sheet } from "../question.ts"
import { QuestionStore, QuestionsUnreadable } from "../service.ts"

/** The plugin's storage, as the plugin context provides it. */
export interface Storage {
  readonly get: (key: string) => Effect.Effect<unknown>
  readonly setIf: (key: string, value: Schema.Json, rev?: number) => Effect.Effect<boolean>
  readonly remove: (key: string) => Effect.Effect<void>
  readonly scan: (options: {
    readonly prefix: string
    readonly after?: string
    readonly limit?: number
  }) => Effect.Effect<{ readonly entries: ReadonlyArray<{ readonly key: string }>; readonly next?: string }>
}

export const PREFIX = "session:"
/** How many keys one scan asks for. */
export const PAGE = 200

export const keyOf = (sessionID: string) => `${PREFIX}${sessionID}`

const decode = Schema.decodeUnknownEffect(Sheet)

/** The JSON a row is stored as: its fields, with no `undefined` left in. */
const rowJson = (row: Row): Schema.Json => {
  const json: Record<string, Schema.Json> = { id: row.id, sessionID: row.sessionID, question: row.question, assume: row.assume, askedAt: row.askedAt }
  if (row.header !== undefined) json.header = row.header
  if (row.options !== undefined)
    json.options = row.options.map((option): Schema.Json =>
      option.description === undefined ? { label: option.label } : { label: option.label, description: option.description },
    )
  if (row.from !== undefined) json.from = { plugin: row.from.plugin, key: row.from.key }
  if (row.answered !== undefined) {
    // A question dismissed beside answers keeps its mark, so its message names it as dismissed, not answered.
    const { dismissed, ...kept } = row.answered
    json.answered = Option.match(Option.fromNullishOr(dismissed), { onNone: () => kept, onSome: (mark) => ({ ...kept, dismissed: mark }) })
  }
  // A question put to a session keeps whom, and its letter.
  Option.map(Option.fromNullishOr(row.to), (to) => (json.to = to))
  Option.map(Option.fromNullishOr(row.letter), (letter) => (json.letter = { delivery: letter.delivery, sent: letter.sent, nudge: letter.nudge }))
  return json
}

const jsonOf = (sheet: Sheet, rev: number): Schema.Json => ({ next: sheet.next, rows: sheet.rows.map(rowJson), rev })

export const layer = (storage: Storage) =>
  Layer.succeed(QuestionStore, {
    read: (sessionID) =>
      storage.get(keyOf(sessionID)).pipe(
        Effect.flatMap((value) =>
          value === undefined
            ? Effect.succeed(EMPTY)
            : decode(value).pipe(
                Effect.map((sheet) => ({ ...sheet, rev: Option.getOrElse(Option.fromUndefinedOr(sheet.rev), () => 0) })),
                Effect.mapError((error) => new QuestionsUnreadable({ message: `the questions of ${sessionID} do not read: ${error.message}` }))),
        ),
      ),
    writeIf: (sessionID, sheet, rev) =>
      Option.match(rev, {
        onNone: () => storage.setIf(keyOf(sessionID), jsonOf(sheet, 1)),
        onSome: (read) => storage.setIf(keyOf(sessionID), jsonOf(sheet, read + 1), read),
      }),
    remove: (sessionID) => storage.remove(keyOf(sessionID)),
    sessions: Effect.gen(function* () {
      const found: Array<string> = []
      let after: string | undefined
      do {
        const page = yield* storage.scan({ prefix: PREFIX, ...(after === undefined ? {} : { after }), limit: PAGE })
        for (const entry of page.entries) found.push(entry.key.slice(PREFIX.length))
        after = page.next
      } while (after !== undefined)
      return found
    }),
  })

/** A fork whose storage has no `setIf` (older than this plugin): the plugin does not start, and says why. */
export class NoConditionalWrite extends Schema.TaggedError<NoConditionalWrite>()("NoConditionalWrite", { message: Schema.String }) {}

/** The sheets in the plugin context's storage; a fork without `storage.setIf` fails the plugin's start. */
export const fromContext = (ctx: Plugin.Context): Layer.Layer<QuestionStore, NoConditionalWrite> =>
  // The types say it is there; an older fork's storage, loaded under them, has none.
  Option.match(Option.liftPredicate(ctx.storage, (storage) => Predicate.isFunction(storage.setIf)), {
    onSome: layer,
    onNone: () =>
      Layer.effect(
        QuestionStore,
        Effect.fail(new NoConditionalWrite({ message: "questions: this OpenCode build has no storage.setIf, so an answer cannot close its question once; install the fork built with the dotfiles that need it" })),
      ),
  })
