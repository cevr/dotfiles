// The commands: each reads the log, decides, appends, then delivers the
// messages the log now owes. The pane a command runs in says who is asking.
import { Config, Context, Effect, FileSystem, Layer, Option, Path, Result } from "effect"
import * as Decide from "./domain/decide.js"
import { Refused } from "./domain/decide.js"
import { Event } from "./domain/event.js"
import type { Entry, Role } from "./domain/event.js"
import * as State from "./domain/state.js"
import type { Run, Seat, Track } from "./domain/state.js"
import { Herdr } from "./services/Herdr.js"
import type { HerdrError, Opened } from "./services/Herdr.js"
import { Journal } from "./services/Journal.js"
import type { JournalError } from "./services/Journal.js"
import { Shell } from "./services/Shell.js"
import type { ShellError } from "./services/Shell.js"

/** Who the asking pane is: a run's orchestrator, or a seat in one of its tracks. */
export type Identity =
  | { readonly kind: "orch"; readonly run: Run }
  | { readonly kind: "seat"; readonly run: Run; readonly seat: Seat }

export type Failure = Refused | JournalError | HerdrError | ShellError

export type Opening = {
  readonly unit: string
  readonly cwd: string
  readonly verifier: boolean
  readonly maxFailures: number
  /** The implementor's Claude account; this pane's when none. */
  readonly claudeConfig: Option.Option<string>
  readonly implModel: string
  readonly implEffort: string
  readonly revModel: string
  readonly revEffort: string
}

export interface BatonService {
  readonly start: (run: string) => Effect.Effect<Run, Failure>
  readonly end: Effect.Effect<Run, Failure>
  readonly open: (
    opening: Opening,
  ) => Effect.Effect<{ readonly track: Track; readonly opened: Opened }, Failure>
  readonly pass: (file: string, verdict: Option.Option<string>) => Effect.Effect<Track, Failure>
  readonly ask: (note: string) => Effect.Effect<Track, Failure>
  readonly tell: (unit: string, to: Role, text: string) => Effect.Effect<Track, Failure>
  readonly close: (unit: string, merged: Option.Option<string>) => Effect.Effect<Track, Failure>
  readonly redeliver: (ref: number) => Effect.Effect<Run, Failure>
  /** One watchdog pass over every live run: observe herdr, resend, report stalls, deliver. */
  readonly tick: Effect.Effect<ReadonlyArray<Run>, Failure>
  readonly status: Effect.Effect<ReadonlyArray<Run>, Failure>
  readonly whoami: Effect.Effect<Option.Option<Identity>, Failure>
}

const refuse = (reason: string) => Refused.make({ reason })
const fromResult = <A>(result: Result.Result<A, Refused>): Effect.Effect<A, Refused> =>
  Result.match(result, { onFailure: Effect.fail, onSuccess: Effect.succeed })

/** One decided event, as the list a write appends. */
const one = (result: Result.Result<Event, Refused>): Result.Result<ReadonlyArray<Event>, Refused> =>
  Result.map(result, (event) => [event])

/** `$name`, else `$HOME/<under>`, else `<under>`. */
const dirConfig = (name: string, under: string) =>
  Config.String(name).pipe(
    Config.orElse(() => Config.map(Config.String("HOME"), (home) => `${home}/${under}`)),
    Config.withDefault(under),
  )

/** Delivery passes per command: a failed message owes the orchestrator one more. */
const DRAIN_PASSES = 4

export class Baton extends Context.Service<Baton, BatonService>()("baton/src/Baton") {
  static layer: Layer.Layer<
    Baton,
    never,
    Journal | Herdr | Shell | FileSystem.FileSystem | Path.Path
  > = Layer.effect(
    Baton,
    Effect.gen(function* () {
      const journal = yield* Journal
      const herdr = yield* Herdr
      const shell = yield* Shell
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path

      const load = Effect.fn("Baton.load")(function* (name: string) {
        return State.project(name, yield* journal.read(name))
      })

      const required = (name: string) =>
        Effect.flatMap(load(name), (run) =>
          Effect.fromOption(run).pipe(Effect.mapError(() => refuse(`no run ${name}`))),
        )

      const live = Effect.gen(function* () {
        const names = yield* journal.runs
        const runs = yield* Effect.forEach(names, load)
        return runs.flatMap(Option.toArray).filter(State.isLive)
      })

      /** Writes what `decide` makes of the run as it stands. */
      const write = (
        name: string,
        decide: (run: Run, now: number) => Result.Result<ReadonlyArray<Event>, Refused>,
      ): Effect.Effect<ReadonlyArray<Entry>, Refused | JournalError> =>
        journal.write(name, (entries, now) =>
          Option.match(State.project(name, entries), {
            onNone: () => Result.fail(refuse(`no run ${name}`)),
            onSome: (run) => decide(run, now),
          }),
        )

      /** Sends what the log owes, recording each attempt and its outcome. */
      const drain = Effect.fn("Baton.drain")(function* (name: string) {
        for (let round = 0; round < DRAIN_PASSES; round += 1) {
          const claimed = yield* write(name, (run, now) =>
            Result.succeed(
              State.deliverable(run, now).map((message) =>
                Event.cases.DeliveryStarted.make({ ref: message.ref }),
              ),
            ),
          )
          if (claimed.length === 0) return
          const run = yield* required(name)
          const refs = claimed.flatMap((entry) => {
            if (!Event.guards.DeliveryStarted(entry.event)) return []
            return [entry.event.ref]
          })
          for (const ref of refs) {
            for (const message of Option.toArray(Option.fromUndefinedOr(run.messages.get(ref)))) {
              const failure = yield* herdr.prompt(message.to.name, message.text).pipe(
                Effect.as(Option.none<string>()),
                Effect.catchTags({
                  HerdrError: (error) => Effect.succeedSome(error.reason),
                  ShellError: (error) => Effect.succeedSome(error.message),
                }),
              )
              yield* write(name, () =>
                Result.succeed([Event.cases.DeliveryFinished.make({ ref, failure })]),
              )
            }
          }
        }
      })

      const pane = Effect.flatMap(herdr.pane, (found) =>
        Effect.fromOption(found).pipe(
          Effect.mapError(() => refuse("run baton inside a herdr pane")),
        ),
      )

      const whoami = Effect.gen(function* () {
        const here = yield* herdr.pane
        if (Option.isNone(here)) return Option.none<Identity>()
        const runs = yield* live
        return Arr_findFirst(runs, (run) => identify(run, here.value))
      })

      const orchestrating = Effect.gen(function* () {
        const who = yield* whoami
        if (Option.isSome(who) && who.value.kind === "orch") return who.value.run
        return yield* refuse("only a run's orchestrator can do this: baton run start <run>")
      })

      const seated = Effect.gen(function* () {
        const who = yield* whoami
        if (Option.isSome(who) && who.value.kind === "seat") return who.value
        return yield* refuse("this pane holds no seat in an open track")
      })

      const trackOf = (name: string, unit: string) =>
        Effect.flatMap(required(name), (run) => fromResult(Decide.openTrack(run, unit)))

      const exists = (file: string, hint: string) =>
        Effect.flatMap(fs.exists(file).pipe(Effect.orElseSucceed(() => false)), (found) => {
          if (found) return Effect.void
          return Effect.fail(refuse(`${file} does not exist: ${hint}`))
        })

      const start = Effect.fn("Baton.start")(function* (name: string) {
        const here = yield* pane
        const orchestrator = { name: `${name}-orch`, pane: here }
        const cache = yield* dirConfig("XDG_CACHE_HOME", ".cache").pipe(
          Effect.orElseSucceed(() => ".cache"),
        )
        const root = path.join(cache, "baton", name)
        const existing = yield* load(name)
        const event = yield* fromResult(Decide.start(name, existing, root, orchestrator))
        yield* herdr.name(here, orchestrator.name)
        yield* journal.write(name, () => Result.succeed([event]))
        const run = yield* required(name)
        yield* fs.makeDirectory(run.root, { recursive: true }).pipe(Effect.ignore)
        return run
      })

      const end = Effect.gen(function* () {
        const run = yield* orchestrating
        for (const track of State.openTracks(run)) yield* Effect.ignore(herdr.close(track.tab))
        yield* write(run.name, (current) => Result.succeed(Decide.end(current)))
        return yield* required(run.name)
      })

      const open = Effect.fn("Baton.open")(function* (opening: Opening) {
        const run = yield* orchestrating
        const cwd = path.resolve(opening.cwd)
        yield* fromResult(Decide.canOpen(run, opening.unit, cwd))
        const spec = path.join(State.unitDir(run, opening.unit), "spec.md")
        yield* exists(spec, "write the unit's spec first")
        yield* exists(cwd, "pass the track's working directory")
        const name = State.trackName(run.name, opening.unit)
        const ours = yield* dirConfig("CLAUDE_CONFIG_DIR", ".claude").pipe(
          Effect.orElseSucceed(() => ".claude"),
        )
        const claude = Option.match(opening.claudeConfig, {
          onNone: () => ours,
          onSome: (dir) => path.resolve(dir),
        })
        const codex = (model: string, effort: string) => [
          "-m",
          model,
          "-c",
          `model_reasoning_effort="${effort}"`,
        ]
        const opened = yield* herdr.open({
          label: name,
          cwd,
          env: [`CLAUDE_CONFIG_DIR=${claude}`],
          seats: [
            {
              name: `${name}-impl`,
              kind: "claude",
              args: ["--model", opening.implModel, "--effort", opening.implEffort],
            },
            {
              name: `${name}-rev`,
              kind: "codex",
              args: codex(opening.revModel, opening.revEffort),
            },
            ...Option.toArray(
              Option.liftPredicate(
                {
                  name: `${name}-ver`,
                  kind: "codex" as const,
                  args: codex(opening.revModel, opening.revEffort),
                },
                () => opening.verifier,
              ),
            ),
          ],
        })
        const seatAt = (index: number) =>
          Option.map(Option.fromUndefinedOr(opened.seats[index]), (seat) => ({
            name: seat.name,
            pane: seat.pane,
          }))
        const pair = Option.all([seatAt(0), seatAt(1)])
        if (Option.isNone(pair)) {
          yield* Effect.ignore(herdr.close(opened.tab))
          return yield* refuse("herdr started no implementor or reviewer")
        }
        const [impl, rev] = pair.value
        yield* write(run.name, (current) =>
          one(
            Decide.open(current, {
              unit: opening.unit,
              cwd,
              tab: opened.tab,
              spec,
              impl,
              rev,
              ver: seatAt(2),
              maxFailures: opening.maxFailures,
            }),
          ),
        ).pipe(Effect.tapError(() => Effect.ignore(herdr.close(opened.tab))))
        yield* drain(run.name)
        return { track: yield* trackOf(run.name, opening.unit), opened }
      })

      const pass = Effect.fn("Baton.pass")(function* (
        file: string,
        verdict: Option.Option<string>,
      ) {
        const { run, seat } = yield* seated
        const absolute = path.resolve(file)
        yield* exists(absolute, "write it, then pass it")
        const head = yield* headOf(seat)
        yield* write(run.name, (current) =>
          one(
            Result.flatMap(reseat(current, seat), (now) =>
              Decide.pass(now, { file: absolute, verdict, head }),
            ),
          ),
        )
        yield* drain(run.name)
        return yield* trackOf(run.name, seat.track.unit)
      })

      /** The implementor's commit; a round is always a commit. */
      const headOf = (seat: Seat) => {
        if (seat.role !== "impl") return Effect.succeed(Option.none<string>())
        return shell
          .run("git", ["-C", seat.track.cwd, "rev-parse", "HEAD"])
          .pipe(
            Effect.map((ran) => Option.liftPredicate(ran.stdout.trim(), () => ran.exitCode === 0)),
          )
      }

      const ask = Effect.fn("Baton.ask")(function* (note: string) {
        const { run, seat } = yield* seated
        yield* write(run.name, (current) =>
          one(Result.flatMap(reseat(current, seat), (now) => Decide.ask(now, note))),
        )
        yield* drain(run.name)
        return yield* trackOf(run.name, seat.track.unit)
      })

      const tell = Effect.fn("Baton.tell")(function* (unit: string, to: Role, text: string) {
        const run = yield* orchestrating
        yield* write(run.name, (current) => one(Decide.tell(current, unit, to, text)))
        yield* drain(run.name)
        return yield* trackOf(run.name, unit)
      })

      const close = Effect.fn("Baton.close")(function* (
        unit: string,
        merged: Option.Option<string>,
      ) {
        const run = yield* orchestrating
        const track = yield* fromResult(Decide.openTrack(run, unit))
        yield* write(run.name, (current) => one(Decide.close(current, unit, merged)))
        yield* Effect.ignore(herdr.close(track.tab))
        const closed = yield* required(run.name)
        return Option.getOrElse(Option.fromUndefinedOr(closed.tracks.get(unit)), () => track)
      })

      const redeliver = Effect.fn("Baton.redeliver")(function* (ref: number) {
        const run = yield* orchestrating
        yield* write(run.name, (current) => one(Decide.redeliver(current, ref)))
        yield* drain(run.name)
        return yield* required(run.name)
      })

      const tick = Effect.gen(function* () {
        const runs = (yield* live).filter((run) => State.openTracks(run).length > 0)
        if (runs.length === 0) return runs
        const seen = new Map((yield* herdr.agents).map((agent) => [agent.name, agent.status]))
        for (const run of runs) {
          yield* write(run.name, (current) => {
            const statuses = Object.fromEntries(
              State.watchedAgents(current).flatMap((agent) =>
                Option.toArray(Option.fromUndefinedOr(seen.get(agent.name))).map((status) => [
                  agent.name,
                  status,
                ]),
              ),
            )
            if (sameStatuses(current.statuses, statuses)) return Result.succeed([])
            return Result.succeed([Event.cases.AgentsObserved.make({ statuses })])
          })
          yield* write(run.name, (current) =>
            Result.succeed(
              State.resendable(current).map((ref) => Event.cases.RedeliveryRequested.make({ ref })),
            ),
          )
          yield* write(run.name, (current, now) =>
            Result.succeed(
              State.stalls(current, now).map((found) => Event.cases.StallDetected.make(found)),
            ),
          )
          yield* drain(run.name)
        }
        return yield* Effect.forEach(runs, (run) => required(run.name))
      })

      const status = live

      return Baton.of({ start, end, open, pass, ask, tell, close, redeliver, tick, status, whoami })
    }),
  )
}

const identify = (run: Run, pane: string): Option.Option<Identity> => {
  if (run.orchestrator.pane === pane) return Option.some({ kind: "orch", run })
  return Option.map(State.seatOf(run, pane), (seat) => ({ kind: "seat", run, seat }))
}

const Arr_findFirst = <A, B>(
  items: ReadonlyArray<A>,
  f: (a: A) => Option.Option<B>,
): Option.Option<B> => {
  for (const item of items) {
    const found = f(item)
    if (Option.isSome(found)) return found
  }
  return Option.none()
}

/** The seat as the log stands now, inside the write: it may have closed. */
const reseat = (run: Run, seat: Seat): Result.Result<Seat, Refused> =>
  Result.map(Decide.openTrack(run, seat.track.unit), (track) => ({ track, role: seat.role }))

const sameStatuses = (
  before: ReadonlyMap<string, string>,
  after: Readonly<Record<string, string>>,
): boolean => {
  const keys = Object.keys(after)
  return keys.length === before.size && keys.every((key) => before.get(key) === after[key])
}
