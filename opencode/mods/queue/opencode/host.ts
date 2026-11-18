// The host as the staleness sweep reads it, through OpenCode's plugin
// context. `layer` works through a plain view of the host, so its test runs
// it over a stand-in; `fromContext` takes the view from the plugin context.
//
// Where each fact comes from, in the fork (packages/schema/src, core/src):
// - roots: `session.list({ directory, archived: false })`, ordered by
//   `time.updated`, newest first (core session/store.ts `list`); a root has
//   no `parentID` (schema session.ts:34).
// - busy: `Session.Info.time.busy` is the start of the latest execution,
//   `time.idle` the end of the last completed one (schema session.ts:44-55);
//   it runs while busy is later than idle. `outcome` is the last run's.
// - gone: `session.get` fails with `Session.NotFoundError`.
// - wakes and questions: the wakes plugin's `pending({ sessionIDs })` RPC
//   (mods/wake/wake.ts `WAKES`, entries of kind alarm, monitor or latch) and
//   the questions plugin's `open({ sessionIDs })` (mods/questions/question.ts
//   `QUESTIONS`), through the context's `rpc(definition)` client; a plugin
//   not loaded fails the call.
// - the note: `session.synthetic` with `delivery: "steer"` admits it; with
//   `resume: true` it wakes an idle session, with `resume: false` it waits
//   for the next turn; its description is the TUI's `◈` notice row.
import type { Plugin } from "@opencode/plugin/effect"
import { SessionID } from "@opencode/schema/session-id"
import { Array as Arr, DateTime, Effect, Layer, Option, Schema } from "effect"
import { NoteRefused, QueueHost, type Root } from "../service.ts"
import type { Linked } from "../stale.ts"

/** A session as the host's `session.get` and `session.list` give it: the fields read here. */
export interface SessionRecord {
  readonly id: string
  readonly parentID?: string
  readonly outcome?: string
  readonly time: { readonly updated: DateTime.Utc; readonly busy?: DateTime.Utc; readonly idle?: DateTime.Utc }
}

/** The host, plainly. Each read fails with whatever the host fails with. */
export interface Host {
  /** This location's sessions, the most recently changed first. */
  readonly sessions: Effect.Effect<ReadonlyArray<SessionRecord>, unknown>
  readonly get: (sessionID: string) => Effect.Effect<SessionRecord, unknown>
  /** The wakes plugin's `pending({ sessionIDs })` answer, undecoded. */
  readonly pending: (sessionIDs: ReadonlyArray<string>) => Effect.Effect<unknown, unknown>
  /** The questions plugin's `open({ sessionIDs })` answer, undecoded. */
  readonly open: (sessionIDs: ReadonlyArray<string>) => Effect.Effect<unknown, unknown>
  readonly synthetic: (input: { readonly sessionID: string; readonly text: string; readonly description: string; readonly resume: boolean }) => Effect.Effect<unknown, unknown>
}

const BY_SESSIONS = { type: "object", properties: { sessionIDs: { type: "array", items: { type: "string" } } }, required: ["sessionIDs"] } as const

/** The one method of each neighbour's RPC the sweep calls, as it defines it (ids kept in step with `WAKES` and `QUESTIONS`). */
export const WAKES_PENDING = { id: "dotfiles-opencode.wake", methods: { pending: { input: BY_SESSIONS, output: { type: "object" } } }, events: {} } as const
export const QUESTIONS_OPEN = { id: "dotfiles-opencode.questions", methods: { open: { input: BY_SESSIONS, output: { type: "object" } } }, events: {} } as const

/** How many of the location's newest root sessions a pass looks at, out of how many sessions read. */
export const ROOTS = 40
export const READ = 400

const Pending = Schema.Struct({ entries: Schema.Array(Schema.Struct({ id: Schema.String, kind: Schema.String, sessionID: Schema.String })) })
const Open = Schema.Struct({ questions: Schema.Array(Schema.Struct({ sessionID: Schema.String })) })
const NotFound = Schema.Struct({ _tag: Schema.Literal("Session.NotFoundError") })
const Said = Schema.Struct({ message: Schema.String })

const millis = (time?: DateTime.Utc): Option.Option<number> => Option.map(Option.fromNullishOr(time), DateTime.toEpochMillis)

/** When the session's last run ended, while none runs now. */
const endOf = (session: SessionRecord): Option.Option<number> => {
  const busy = millis(session.time.busy)
  const idle = millis(session.time.idle)
  if (Option.isNone(busy)) return Option.some(Option.getOrElse(idle, () => DateTime.toEpochMillis(session.time.updated)))
  return Option.filter(idle, (end) => end >= busy.value)
}

const rootOf = (session: SessionRecord): Root => ({ id: session.id, busy: Option.isNone(endOf(session)), updated: DateTime.toEpochMillis(session.time.updated) })

const linkedOf = (session: SessionRecord): Linked =>
  Option.match(endOf(session), {
    onNone: (): Linked => ({ state: "busy" }),
    onSome: (since): Linked => ({ state: "idle", since, outcome: Option.fromNullishOr(session.outcome) }),
  })

const notFound = Schema.is(NotFound)

const messageOf = (cause: unknown): string => {
  if (notFound(cause)) return "no such session"
  if (Schema.is(Said)(cause)) return cause.message
  return "the host refused it"
}

const perSession = <A>(sessionIDs: ReadonlyArray<string>, rows: ReadonlyArray<A>, sessionOf: (row: A) => string) =>
  new Map(sessionIDs.map((sessionID) => [sessionID, rows.filter((row) => sessionOf(row) === sessionID)]))

export const layer = (host: Host) =>
  Layer.succeed(
    QueueHost,
    QueueHost.of({
      roots: host.sessions.pipe(
        Effect.map((sessions) => Arr.take(Arr.filter(sessions, (session) => Option.isNone(Option.fromNullishOr(session.parentID))).map(rootOf), ROOTS)),
        Effect.orElseSucceed(Arr.empty),
      ),
      linked: (sessionID) =>
        host.get(sessionID).pipe(
          Effect.map((session) => Option.some(linkedOf(session))),
          Effect.catch((cause) => Effect.succeed(Option.liftPredicate<Linked>({ state: "gone" }, () => notFound(cause)))),
        ),
      wakes: (sessionIDs) =>
        host.pending(sessionIDs).pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(Pending)),
          Effect.map(
            (pending): ReadonlyMap<string, ReadonlyArray<string>> =>
              new Map(
                Arr.map([...perSession(sessionIDs, pending.entries, (entry) => entry.sessionID)], ([sessionID, entries]) => [
                  sessionID,
                  entries.filter((entry) => entry.kind === "alarm" || entry.kind === "monitor").map((entry) => entry.id),
                ]),
              ),
          ),
          Effect.option,
        ),
      questions: (sessionIDs) =>
        host.open(sessionIDs).pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(Open)),
          Effect.map(
            (open): ReadonlyMap<string, number> =>
              new Map(Arr.map([...perSession(sessionIDs, open.questions, (question) => question.sessionID)], ([sessionID, rows]) => [sessionID, rows.length])),
          ),
          Effect.option,
        ),
      note: (sessionID, text, description, wake) =>
        host.synthetic({ sessionID, text, description, resume: wake }).pipe(
          Effect.asVoid,
          Effect.mapError((cause) => new NoteRefused({ sessionID, message: messageOf(cause) })),
        ),
    }),
  )

/** The host through the plugin context, read lazily: nothing of the context is touched until a pass runs. */
export const fromContext = (ctx: Plugin.Context) =>
  layer({
    sessions: Effect.suspend(() => ctx.session.list({ directory: ctx.location.directory, archived: false, order: "desc", limit: READ })).pipe(
      Effect.map((page) => page.data),
    ),
    get: (sessionID) => Effect.suspend(() => ctx.session.get({ sessionID: SessionID.make(sessionID) })),
    pending: (ids) => Effect.suspend(() => ctx.rpc(WAKES_PENDING).pending({ sessionIDs: [...ids] })),
    open: (ids) => Effect.suspend(() => ctx.rpc(QUESTIONS_OPEN).open({ sessionIDs: [...ids] })),
    synthetic: (input) =>
      Effect.suspend(() =>
        ctx.session.synthetic({
          sessionID: SessionID.make(input.sessionID),
          text: input.text,
          description: input.description,
          metadata: { plugin: "dotfiles-opencode.queue", kind: "staleness" },
          delivery: "steer",
          resume: input.resume,
        }),
      ),
  })
