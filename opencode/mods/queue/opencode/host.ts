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
// - lost work: the orchestrate plugin's `lost({ sessionID, hashes })` RPC
//   (mods/orchestrate/lost-now.ts `lostAnswer`, cmd/orchestrate `LOST`).
// - wakes and questions: the wakes plugin's `pending({ sessionIDs })` RPC
//   (mods/wake/wake.ts `WAKES`, entries of kind alarm, monitor or latch) and
//   the questions plugin's `open({ sessionIDs })` (mods/questions/question.ts
//   `QUESTIONS`), through the context's `rpc(definition)` client; a plugin
//   not loaded fails the call.
// - the note (a staleness check, or the owner's answer to an item, told apart
//   by `metadata.kind`): `session.synthetic` with `delivery: "steer"` admits it; with
//   `resume: true` it wakes an idle session, with `resume: false` it waits
//   for the next turn; its description is the TUI's `◈` notice row.
// - every call is cut off after CALL_TIMEOUT and then counts as failed, so a
//   host that never answers costs one pass that long, not every later one.
//
// At run time a plugin gets only `effect` and `@opencode/plugin` from
// OpenCode; any other package comes from the checkout's own node_modules,
// links that point nowhere in a copy of it. So this file imports
// `@opencode/schema` for its types only, and brands a session id itself:
// a value import of it stopped the whole plugin, queue RPC included, from
// loading in such a copy ("Cannot find package '@opencode/schema'").
import type { Plugin } from "@opencode/plugin/effect"
import type { SessionID as HostSessionID } from "@opencode/schema/session-id"
import { Array as Arr, Cause, DateTime, type Duration, Effect, Layer, Option, Schema } from "effect"
import { type NoteKind, NoteRefused, QueueHost, type Root } from "../service.ts"
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
  /** The orchestrate plugin's `lost({ sessionID, hashes })` answer, undecoded. */
  readonly lost: (input: { readonly sessionID: string; readonly hashes: ReadonlyArray<string> }) => Effect.Effect<unknown, unknown>
  readonly synthetic: (input: {
    readonly sessionID: string
    readonly text: string
    readonly description: string
    readonly resume: boolean
    readonly kind: NoteKind
  }) => Effect.Effect<unknown, unknown>
}

const BY_SESSIONS = { type: "object", properties: { sessionIDs: { type: "array", items: { type: "string" } } }, required: ["sessionIDs"] } as const

/** The one method of each neighbour's RPC the sweep calls, as it defines it (ids kept in step with `WAKES`, `QUESTIONS` and orchestrate's `LOST`). */
export const WAKES_PENDING = { id: "dotfiles-opencode.wake", methods: { pending: { input: BY_SESSIONS, output: { type: "object" } } }, events: {} } as const
export const QUESTIONS_OPEN = { id: "dotfiles-opencode.questions", methods: { open: { input: BY_SESSIONS, output: { type: "object" } } }, events: {} } as const
export const ORCHESTRATE_LOST = {
  id: "dotfiles-opencode.orchestrate.lost",
  methods: {
    lost: {
      input: { type: "object", properties: { sessionID: { type: "string" }, hashes: { type: "array", items: { type: "string" } } }, required: ["sessionID", "hashes"] },
      output: { type: "object" },
    },
  },
  events: {},
} as const

/** How many of the location's newest root sessions a pass looks at, out of how many sessions read. */
export const ROOTS = 40
export const READ = 400

const Pending = Schema.Struct({ entries: Schema.Array(Schema.Struct({ id: Schema.String, kind: Schema.String, sessionID: Schema.String })) })
const Open = Schema.Struct({ questions: Schema.Array(Schema.Struct({ sessionID: Schema.String })) })
const LostAnswer = Schema.Struct({ lines: Schema.Array(Schema.String), keys: Schema.Array(Schema.String), hashes: Schema.Array(Schema.Struct({ hash: Schema.String, why: Schema.String })) })
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
  if (Cause.isTimeoutError(cause)) return "the host did not answer in time"
  if (Schema.is(Said)(cause)) return cause.message
  return "the host refused it"
}

const perSession = <A>(sessionIDs: ReadonlyArray<string>, rows: ReadonlyArray<A>, sessionOf: (row: A) => string) =>
  new Map(sessionIDs.map((sessionID) => [sessionID, rows.filter((row) => sessionOf(row) === sessionID)]))

/** How long one call to the host may take before it counts as failed. */
export const CALL_TIMEOUT: Duration.Input = "30 seconds"

/** A session id as the host's calls take it, branded here (see the header). */
const SessionID = Schema.String.check(Schema.isStartingWith("ses")).pipe(Schema.brand("SessionID"))
const sessionIDOf = (sessionID: string): HostSessionID => SessionID.make(sessionID)

export const layer = (host: Host, callTimeout: Duration.Input = CALL_TIMEOUT) => {
  const cut = <A>(call: Effect.Effect<A, unknown>) => Effect.timeout(call, callTimeout)
  return Layer.succeed(
    QueueHost,
    QueueHost.of({
      roots: cut(host.sessions).pipe(
        Effect.map((sessions) => Arr.take(Arr.filter(sessions, (session) => Option.isNone(Option.fromNullishOr(session.parentID))).map(rootOf), ROOTS)),
        Effect.orElseSucceed(Arr.empty),
      ),
      linked: (sessionID) =>
        cut(host.get(sessionID)).pipe(
          Effect.map((session) => Option.some(linkedOf(session))),
          Effect.catch((cause) => Effect.succeed(Option.liftPredicate<Linked>({ state: "gone" }, () => notFound(cause)))),
        ),
      wakes: (sessionIDs) =>
        cut(host.pending(sessionIDs)).pipe(
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
        cut(host.open(sessionIDs)).pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(Open)),
          Effect.map(
            (open): ReadonlyMap<string, number> =>
              new Map(Arr.map([...perSession(sessionIDs, open.questions, (question) => question.sessionID)], ([sessionID, rows]) => [sessionID, rows.length])),
          ),
          Effect.option,
        ),
      lost: (sessionID, hashes) =>
        cut(host.lost({ sessionID, hashes })).pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(LostAnswer)),
          Effect.map((answer) => ({ lines: answer.lines, keys: answer.keys, hashes: new Map(answer.hashes.map((each) => [each.hash, each.why] as const)) })),
          Effect.option,
        ),
      note: (sessionID, text, description, wake, kind) =>
        cut(host.synthetic({ sessionID, text, description, resume: wake, kind })).pipe(
          Effect.asVoid,
          Effect.mapError((cause) => new NoteRefused({ sessionID, message: messageOf(cause) })),
        ),
    }),
  )
}

/** The host through the plugin context, read lazily: nothing of the context is touched until a pass runs. */
export const fromContext = (ctx: Plugin.Context) =>
  layer({
    sessions: Effect.suspend(() => ctx.session.list({ directory: ctx.location.directory, archived: false, order: "desc", limit: READ })).pipe(
      Effect.map((page) => page.data),
    ),
    get: (sessionID) => Effect.suspend(() => ctx.session.get({ sessionID: sessionIDOf(sessionID) })),
    pending: (ids) => Effect.suspend(() => ctx.rpc(WAKES_PENDING).pending({ sessionIDs: [...ids] })),
    open: (ids) => Effect.suspend(() => ctx.rpc(QUESTIONS_OPEN).open({ sessionIDs: [...ids] })),
    lost: (input) => Effect.suspend(() => ctx.rpc(ORCHESTRATE_LOST).lost({ sessionID: input.sessionID, hashes: [...input.hashes] })),
    synthetic: (input) =>
      Effect.suspend(() =>
        ctx.session.synthetic({
          sessionID: sessionIDOf(input.sessionID),
          text: input.text,
          description: input.description,
          metadata: { plugin: "dotfiles-opencode.queue", kind: input.kind },
          delivery: "steer",
          resume: input.resume,
        }),
      ),
  })
