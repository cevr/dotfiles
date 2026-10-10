// A herdr and a git that live in memory, beside a real journal and file
// system in a temp directory: enough to run every command end to end.
import { BunServices } from "@effect/platform-bun"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { ConfigProvider, Context, Effect, FileSystem, Layer, Option, Ref } from "effect"
import { Baton } from "../../src/Baton.js"
import type { AgentStatus } from "../../src/domain/event.js"
import { Herdr, HerdrError } from "../../src/services/Herdr.js"
import { Journal } from "../../src/services/Journal.js"
import { Shell } from "../../src/services/Shell.js"

export type Prompt = { readonly agent: string; readonly text: string }

export interface WorldService {
  /** The directory every test file lives under. */
  readonly dir: string
  /** Acts from this herdr pane from now on. */
  readonly at: (pane: string) => Effect.Effect<void>
  readonly prompts: Effect.Effect<ReadonlyArray<Prompt>>
  /** herdr's agent states from now on; an agent left out is gone. */
  readonly statuses: (statuses: Readonly<Record<string, AgentStatus>>) => Effect.Effect<void>
  /** Prompts to these agents fail with `agent_blocked` from now on. */
  readonly blocked: (agents: ReadonlyArray<string>) => Effect.Effect<void>
  readonly closedTabs: Effect.Effect<ReadonlyArray<string>>
}

export class World extends Context.Service<World, WorldService>()("baton/tests/helpers/world") {}

const fakes = (dir: string) =>
  Layer.effectContext(
    Effect.gen(function* () {
      const here = yield* Ref.make(Option.none<string>())
      const prompts = yield* Ref.make<ReadonlyArray<Prompt>>([])
      const statuses = yield* Ref.make<Readonly<Record<string, AgentStatus>>>({})
      const blocked = yield* Ref.make<ReadonlySet<string>>(new Set())
      const closed = yield* Ref.make<ReadonlyArray<string>>([])
      const tabs = yield* Ref.make(0)

      const herdr = Herdr.of({
        pane: Ref.get(here),
        agents: Effect.map(Ref.get(statuses), (all) =>
          Object.entries(all).map(([name, status]) => ({ name, status })),
        ),
        name: () => Effect.void,
        prompt: (agent, text) =>
          Effect.gen(function* () {
            if ((yield* Ref.get(blocked)).has(agent))
              return yield* HerdrError.make({
                code: "agent_blocked",
                detail: `${agent} is at a dialog`,
              })
            yield* Ref.update(prompts, (all) => [...all, { agent, text }])
          }),
        open: (input) =>
          Effect.gen(function* () {
            const tab = yield* Ref.updateAndGet(tabs, (n) => n + 1)
            return {
              tab: `w:t${tab}`,
              seats: input.seats.map((seat, index) => ({
                name: seat.name,
                pane: `w:t${tab}p${index}`,
                started: "ready",
              })),
            }
          }),
        close: (tab) => Ref.update(closed, (all) => [...all, tab]),
      })
      const shell = Shell.of({
        run: (_command, args) =>
          Effect.succeed({ stdout: `head-of-${args[1] ?? ""}\n`, stderr: "", exitCode: 0 }),
      })
      const world = World.of({
        dir,
        at: (pane) => Ref.set(here, Option.some(pane)),
        prompts: Ref.get(prompts),
        statuses: (next) => Ref.set(statuses, next),
        blocked: (agents) => Ref.set(blocked, new Set(agents)),
        closedTabs: Ref.get(closed),
      })
      return Context.make(Herdr, herdr).pipe(Context.add(Shell, shell), Context.add(World, world))
    }),
  )

/** Baton over the fakes, with its journal and cache in a fresh temp directory. */
export const world = Layer.unwrap(
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const dir = yield* fs.makeTempDirectoryScoped({ prefix: "baton-test-" })
    const services = fakes(dir)
    const journal = Journal.layerSql.pipe(
      Layer.provide(SqliteClient.layer({ filename: `${dir}/baton.db` })),
    )
    const config = ConfigProvider.layer(
      ConfigProvider.fromEnvRecord({ XDG_CACHE_HOME: `${dir}/cache` }),
    )
    return Baton.layer.pipe(
      Layer.provideMerge(services),
      Layer.provideMerge(journal),
      Layer.provide(config),
    )
  }),
).pipe(Layer.provideMerge(BunServices.layer))
