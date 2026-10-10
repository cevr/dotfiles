// herdr, the terminal workspace the agents live in: who is in this pane, what
// state each agent is in, sending one a line, and opening a track's tab.
import { Config, Context, Effect, Layer, Option, Schema } from "effect"
import { AgentStatus } from "../domain/event.js"
import type { Agent } from "../domain/event.js"
import { Shell } from "./Shell.js"
import type { ShellError } from "./Shell.js"

/** herdr answered with an error code, such as `agent_blocked` or `agent_not_found`. */
export class HerdrError extends Schema.TaggedError<HerdrError>()("HerdrError", {
  code: Schema.String,
  detail: Schema.String,
}) {
  override get message(): string {
    return `herdr: ${this.code}: ${this.detail}`
  }
}

export type Seen = { readonly name: string; readonly status: AgentStatus }

/** One agent to start in a track's tab. */
export type Seating = {
  readonly name: string
  readonly kind: "claude" | "codex"
  readonly args: ReadonlyArray<string>
}

export type Opened = {
  readonly tab: string
  /** Each seat's agent, and `ready` or herdr's error code from starting it. */
  readonly seats: ReadonlyArray<Agent & { readonly started: string }>
}

export interface HerdrService {
  /** This process's pane, when it runs inside herdr. */
  readonly pane: Effect.Effect<Option.Option<string>>
  readonly agents: Effect.Effect<ReadonlyArray<Seen>, HerdrError | ShellError>
  /** Names the agent in `pane`, so herdr can prompt it by name. */
  readonly name: (pane: string, name: string) => Effect.Effect<void, HerdrError | ShellError>
  readonly prompt: (agent: string, text: string) => Effect.Effect<void, HerdrError | ShellError>
  /** A tab labelled `label`, its panes side by side, one agent started in each. */
  readonly open: (input: {
    readonly label: string
    readonly cwd: string
    readonly env: ReadonlyArray<string>
    readonly seats: ReadonlyArray<Seating>
  }) => Effect.Effect<Opened, HerdrError | ShellError>
  readonly close: (tab: string) => Effect.Effect<void, HerdrError | ShellError>
}

const Failure = Schema.Struct({
  error: Schema.Struct({ code: Schema.String, message: Schema.String }),
})
const decodeFailure = Schema.decodeUnknownOption(Schema.fromJsonString(Failure))
const AgentList = Schema.Struct({
  result: Schema.Struct({
    agents: Schema.Array(
      Schema.Struct({ name: Schema.optional(Schema.String), agent_status: AgentStatus }),
    ),
  }),
})
const decodeAgentList = Schema.decodeUnknownEffect(Schema.fromJsonString(AgentList))
const TabCreated = Schema.Struct({
  result: Schema.Struct({
    tab: Schema.Struct({ tab_id: Schema.String }),
    root_pane: Schema.Struct({ pane_id: Schema.String }),
  }),
})
const decodeTabCreated = Schema.decodeUnknownEffect(Schema.fromJsonString(TabCreated))
const PaneSplit = Schema.Struct({
  result: Schema.Struct({ pane: Schema.Struct({ pane_id: Schema.String }) }),
})
const decodePaneSplit = Schema.decodeUnknownEffect(Schema.fromJsonString(PaneSplit))

const malformed = (error: { readonly message: string }) =>
  HerdrError.make({ code: "malformed", detail: error.message })

export class Herdr extends Context.Service<Herdr, HerdrService>()("baton/src/services/Herdr") {
  static layer: Layer.Layer<Herdr, never, Shell> = Layer.effect(
    Herdr,
    Effect.gen(function* () {
      const shell = yield* Shell
      /** Runs herdr; a non-zero exit becomes its error code. */
      const herdr = Effect.fn("Herdr.run")(function* (args: ReadonlyArray<string>) {
        const ran = yield* shell.run("herdr", args)
        if (ran.exitCode === 0) return ran.stdout
        const failure = Option.map(decodeFailure(ran.stdout), ({ error }) => ({
          code: error.code,
          detail: error.message,
        }))
        return yield* HerdrError.make(
          Option.getOrElse(failure, () => ({ code: "failed", detail: ran.stderr.trim() })),
        ).pipe(Effect.fail)
      })

      const pane = Config.option(Config.String("HERDR_PANE_ID")).pipe(
        Effect.orElseSucceed(() => Option.none<string>()),
      )

      const agents = Effect.gen(function* () {
        const listed = yield* herdr(["agent", "list"]).pipe(
          Effect.flatMap(decodeAgentList),
          Effect.mapError(asHerdr),
        )
        return listed.result.agents.flatMap((agent) =>
          Option.toArray(Option.fromUndefinedOr(agent.name)).map((name) => ({
            name,
            status: agent.agent_status,
          })),
        )
      }).pipe(Effect.withSpan("Herdr.agents"))

      const name = Effect.fn("Herdr.name")(function* (target: string, agent: string) {
        yield* herdr(["agent", "rename", target, agent])
      })

      const prompt = Effect.fn("Herdr.prompt")(function* (agent: string, text: string) {
        yield* herdr(["agent", "prompt", agent, text])
      })

      const close = Effect.fn("Herdr.close")(function* (tab: string) {
        yield* herdr(["tab", "close", tab])
      })

      const open = Effect.fn("Herdr.open")(function* (input: Parameters<HerdrService["open"]>[0]) {
        const workspace = yield* Config.String("HERDR_WORKSPACE_ID").pipe(
          Effect.mapError(() =>
            HerdrError.make({ code: "no_workspace", detail: "run baton inside a herdr pane" }),
          ),
        )
        const created = yield* herdr([
          "tab",
          "create",
          "--workspace",
          workspace,
          "--cwd",
          input.cwd,
          "--label",
          input.label,
          ...input.env.flatMap((pair) => ["--env", pair]),
          "--no-focus",
        ]).pipe(Effect.flatMap(decodeTabCreated), Effect.mapError(asHerdr))
        const tab = created.result.tab.tab_id
        // A failure past here closes the half-built tab, so opening can be retried.
        return yield* seat(created.result.root_pane.pane_id, input).pipe(
          Effect.map((seats) => ({ tab, seats })),
          Effect.tapError(() => Effect.ignore(close(tab))),
        )
      })

      /** Splits a pane for each seat after the first, then starts every agent. */
      const seat = Effect.fn("Herdr.seat")(function* (
        root: string,
        input: Parameters<HerdrService["open"]>[0],
      ) {
        const panes = [root]
        for (const [index] of input.seats.slice(1).entries()) {
          const direction = Option.match(
            Option.liftPredicate(index, (i) => i === 0),
            {
              onNone: () => "down",
              onSome: () => "right",
            },
          )
          const from = panes[panes.length - 1] ?? root
          const split = yield* herdr([
            "pane",
            "split",
            from,
            "--direction",
            direction,
            "--cwd",
            input.cwd,
            "--no-focus",
          ]).pipe(Effect.flatMap(decodePaneSplit), Effect.mapError(asHerdr))
          panes.push(split.result.pane.pane_id)
        }
        return yield* Effect.forEach(input.seats, (seating, index) => {
          const target = panes[index] ?? root
          return herdr([
            "agent",
            "start",
            seating.name,
            "--kind",
            seating.kind,
            "--pane",
            target,
            "--timeout",
            "90000",
            "--",
            ...seating.args,
          ]).pipe(
            Effect.as("ready"),
            Effect.catchTag("HerdrError", (error) => Effect.succeed(error.code)),
            Effect.map((started) => ({ name: seating.name, pane: target, started })),
          )
        })
      })

      return Herdr.of({ pane, agents, name, prompt, open, close })
    }),
  )
}

const isHerdrError = Schema.is(HerdrError)
const asHerdr = <E extends { readonly message: string }>(error: E | HerdrError): HerdrError => {
  if (isHerdrError(error)) return error
  return malformed(error)
}
