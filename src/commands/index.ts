import { Clock, Console, Effect, Option, Schedule, Schema } from "effect"
import { Argument, CliError, Command, Flag } from "effect/cli"
import { Baton } from "../Baton.js"
import type { Failure } from "../Baton.js"
import { Role } from "../domain/event.js"
import { IdentityView, OpenedView, RunView, identityView, runText, runView } from "../view.js"

/** A refusal or failure prints its reason; the exit code says it failed. */
const reported = <A, R>(effect: Effect.Effect<A, Failure, R>) =>
  Effect.mapError(effect, (error) =>
    CliError.UserError.make({ cause: error, userMessage: error.message }),
  )

/** Prints `value` as JSON, through the schema that fixes its shape. */
const json = <A>(schema: Schema.Codec<A>, value: A) =>
  Effect.flatMap(Schema.encodeEffect(Schema.fromJsonString(schema))(value), Console.log).pipe(
    Effect.orDie,
  )

const asJson = Flag.Boolean("json").pipe(
  Flag.withDescription("Print JSON"),
  Flag.withDefault(false),
)

const runStart = Command.make("start", { run: Argument.String("run") }).pipe(
  Command.withDescription("Take a run as its orchestrator: names this pane's agent <run>-orch"),
  Command.withHandler(({ run }) =>
    Effect.gen(function* () {
      const started = yield* (yield* Baton).start(run)
      yield* Console.log(
        `${started.name}: orchestrator ${started.orchestrator.name}, unit folders under ${started.root}`,
      )
    }).pipe(reported),
  ),
)

const runEnd = Command.make("end").pipe(
  Command.withDescription("End this pane's run: close its tracks and free its panes"),
  Command.withHandler(() =>
    Effect.gen(function* () {
      const ended = yield* (yield* Baton).end
      yield* Console.log(`${ended.name} ended`)
    }).pipe(reported),
  ),
)

const run = Command.make("run").pipe(
  Command.withDescription("Start or end a run"),
  Command.withSubcommands([runStart, runEnd]),
)

const open = Command.make("open", {
  unit: Argument.String("unit"),
  cwd: Flag.String("cwd").pipe(Flag.withDescription("The track's checkout: a rift or worktree")),
  verifier: Flag.Boolean("verifier").pipe(Flag.withDefault(false)),
  maxFailures: Flag.Int("max-failures").pipe(Flag.withDefault(3)),
  implModel: Flag.String("impl-model").pipe(Flag.withDefault("opus")),
  implEffort: Flag.String("impl-effort").pipe(Flag.withDefault("medium")),
  revModel: Flag.String("rev-model").pipe(Flag.withDefault("gpt-6.1-sol")),
  revEffort: Flag.String("rev-effort").pipe(Flag.withDefault("high")),
}).pipe(
  Command.withDescription(
    "Open a track for <unit>: a herdr tab with its agents; the implementor gets the spec",
  ),
  Command.withHandler((opening) =>
    Effect.gen(function* () {
      const { track, opened } = yield* (yield* Baton).open(opening)
      yield* json(OpenedView, { track: track.name, tab: opened.tab, seats: opened.seats })
    }).pipe(reported),
  ),
)

const pass = Command.make("pass", {
  file: Argument.String("file"),
  verdict: Flag.String("verdict").pipe(
    Flag.withDescription("Reviewer: accepted | changes | stuck. Verifier: pass | fail | stuck"),
    Flag.optional,
  ),
}).pipe(
  Command.withDescription("Pass the baton on, with the file the next agent needs"),
  Command.withHandler(({ file, verdict }) =>
    Effect.gen(function* () {
      const track = yield* (yield* Baton).pass(file, verdict)
      yield* Console.log(
        `${track.name}: the baton is with the ${track.step.holder}. End your turn.`,
      )
    }).pipe(reported),
  ),
)

const ask = Command.make("ask", { note: Argument.String("note") }).pipe(
  Command.withDescription("Hand the orchestrator a question (a line, or a file's path) and wait"),
  Command.withHandler(({ note }) =>
    Effect.gen(function* () {
      const track = yield* (yield* Baton).ask(note)
      yield* Console.log(`${track.name}: asked the orchestrator. End your turn.`)
    }).pipe(reported),
  ),
)

const tell = Command.make("tell", {
  unit: Argument.String("unit"),
  to: Argument.Literals("role", Role.literals),
  text: Argument.String("text"),
}).pipe(
  Command.withDescription("Send a worker a line; it holds the baton until it passes"),
  Command.withHandler(({ unit, to, text }) =>
    Effect.gen(function* () {
      const track = yield* (yield* Baton).tell(unit, to, text)
      yield* Console.log(`${track.name}: told the ${to}`)
    }).pipe(reported),
  ),
)

const close = Command.make("close", {
  unit: Argument.String("unit"),
  merged: Flag.String("merged").pipe(
    Flag.withDescription("The commit merged to main"),
    Flag.optional,
  ),
}).pipe(
  Command.withDescription("Close a track and its tab"),
  Command.withHandler(({ unit, merged }) =>
    Effect.gen(function* () {
      const track = yield* (yield* Baton).close(unit, merged)
      yield* Console.log(`${track.name} closed`)
    }).pipe(reported),
  ),
)

const redeliver = Command.make("redeliver", { ref: Argument.Int("ref") }).pipe(
  Command.withDescription("Send a failed message again"),
  Command.withHandler(({ ref }) =>
    Effect.gen(function* () {
      yield* (yield* Baton).redeliver(ref)
      yield* Console.log(`#${ref} sent again`)
    }).pipe(reported),
  ),
)

const tick = Command.make("tick").pipe(
  Command.withDescription("One watchdog pass: record herdr's agent states, report stalls, deliver"),
  Command.withHandler(() =>
    Effect.gen(function* () {
      yield* (yield* Baton).tick
    }).pipe(reported),
  ),
)

const watch = Command.make("watch", {
  every: Flag.Int("every").pipe(
    Flag.withDescription("Seconds between passes"),
    Flag.withDefault(60),
  ),
}).pipe(
  Command.withDescription("Run the watchdog until stopped"),
  Command.withHandler(({ every }) =>
    Effect.gen(function* () {
      const baton = yield* Baton
      yield* baton.tick.pipe(
        Effect.catchTag("HerdrError", (error) => Console.error(error.message)),
        Effect.repeat(Schedule.spaced(`${every} seconds`)),
      )
    }).pipe(reported),
  ),
)

const status = Command.make("status", { json: asJson }).pipe(
  Command.withDescription(
    "Every live run: each track's step, who holds the baton, and what is undelivered",
  ),
  Command.withHandler(({ json: wantsJson }) =>
    Effect.gen(function* () {
      const views = (yield* (yield* Baton).status).map(runView)
      if (wantsJson) return yield* json(Schema.Array(RunView), views)
      const now = yield* Clock.currentTimeMillis
      if (views.length === 0) return yield* Console.log("no live runs")
      yield* Console.log(views.map((view) => runText(view, now)).join("\n\n"))
    }).pipe(reported),
  ),
)

const whoami = Command.make("whoami", { json: asJson }).pipe(
  Command.withDescription("This pane's place: a run's orchestrator, or a track's seat"),
  Command.withHandler(({ json: wantsJson }) =>
    Effect.gen(function* () {
      const who = Option.map(yield* (yield* Baton).whoami, identityView)
      if (wantsJson) return yield* json(Schema.Array(IdentityView), Option.toArray(who))
      yield* Console.log(
        Option.match(who, {
          onNone: () => "no run knows this pane",
          onSome: (view) =>
            [view.run, view.role, view.track].filter((part) => part !== "").join("  "),
        }),
      )
    }).pipe(reported),
  ),
)

export const command = Command.make("baton").pipe(
  Command.withDescription("Relay the baton between herdr agents: whoever holds it works next"),
  Command.withSubcommands([
    run,
    open,
    pass,
    ask,
    tell,
    close,
    redeliver,
    status,
    whoami,
    tick,
    watch,
  ]),
)
