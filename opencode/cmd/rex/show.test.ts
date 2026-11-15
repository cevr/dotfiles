// rex-show's seams: the arguments it takes, the run on memory systems from a
// caller's pane (one showcase split off beside it, the viewer told the
// spool), the refusal outside a pane, and the command's exit outside one.
import { describe, expect } from "bun:test"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import * as MemoryRex from "@dotfiles/opencode-rex/memory/rex"
import * as MemorySpool from "@dotfiles/opencode-rex/memory/spool"
import { Page, Picture, type Spooled } from "@dotfiles/opencode-rex/spool"
import { ConfigProvider, Effect, Exit, Layer, Option, Ref, Schema } from "effect"
import { effectTest } from "../../sim-tui/effect-test.ts"
import { parse, Refused, Request, run, type Screen } from "./show.ts"

const screen: Screen = { size: Effect.succeed({ cols: 80, rows: 24 }), display: () => Effect.void }
const settings = { rex: "rex", spool: "/state/rex-show", self: ["/opt/bun", "/dotfiles/rex/show.ts"] }
const SHOW = fileURLToPath(new URL("./show.ts", import.meta.url))

/** The exit code a refused run ends with; none when it was not refused. */
const refusalOf = <A>(exit: Exit.Exit<A, unknown>) => Option.map(Option.filter(Exit.findErrorOption(exit), Schema.is(Refused)), (refused) => refused.code)

describe("the arguments rex-show takes", () => {
  effectTest(
    "image, md, tally with its flags, and view; anything else is a usage error",
    Effect.gen(function* () {
      expect(yield* parse(["image", "x.png"])).toEqual(Request.Show({ shown: Picture.make({ file: join(process.cwd(), "x.png"), name: "x.png" }) }))
      expect(yield* parse(["md", "notes.md"])).toEqual(Request.Show({ shown: Page.make({ file: join(process.cwd(), "notes.md"), name: "notes.md" }) }))
      expect(yield* parse(["tally", "2 of 5", "--progress", "40", "--state", "done"])).toEqual(
        Request.Tally({ msg: "2 of 5", progress: Option.some(40), state: "done" }),
      )
      expect(yield* parse(["view", "--session", "session:a"])).toEqual(Request.View({ session: "session:a", spool: Option.none() }))
      for (const bad of [[], ["paint"], ["image"], ["image", "a", "b"], ["tally", "x", "--progress", "140"], ["tally", "x", "--state", "sleepy"], ["view"]]) {
        expect({ bad, code: refusalOf(yield* Effect.exit(parse(bad))) }).toEqual({ bad, code: Option.some(2) })
      }
    }),
    5_000,
  )
})

describe("a run from a caller's pane", () => {
  const rex = Ref.makeUnsafe(MemoryRex.world([{ session: "session:a", label: "shell" }]))
  const spools = Ref.makeUnsafe<ReadonlyMap<string, Spooled>>(new Map())
  const systems = Layer.mergeAll(MemoryRex.layer(rex), MemorySpool.layer(spools))
  const env = (vars: Record<string, string>) => ConfigProvider.layer(ConfigProvider.fromEnvRecord(vars))

  const inPane = { REX_SESSION: "session:a", REX_BLOCK: MemoryRex.blockId(1) }
  const showcases = Effect.map(Ref.get(rex), (world) => world.blocks.filter((held) => held.label === "showcase").map((held) => [held.id, held.command]))
  const closeShowcases = Ref.update(rex, (world) => ({ ...world, blocks: world.blocks.filter((held) => held.label !== "showcase") }))

  effectTest(
    "splits off one showcase running this same program as the viewer on this spool, and a second call reuses it",
    Effect.gen(function* () {
      const tally = yield* parse(["tally", "2 of 5 done", "--progress", "40"])
      const block = yield* run(tally, screen, settings)
      expect(yield* run(tally, screen, settings)).toBe(block)
      expect(yield* showcases).toEqual([[block, ["/opt/bun", "/dotfiles/rex/show.ts", "view", "--session", "session:a", "--spool", "/state/rex-show"]]])
      expect((yield* Ref.get(spools)).get("session:a")).toMatchObject({ tally: { msg: "2 of 5 done", progress: 40, state: "working" } })
      yield* closeShowcases
    }).pipe(Effect.provide(Layer.mergeAll(systems, env(inPane)))),
    5_000,
  )

  effectTest(
    "starts the viewer as REX_SHOW_BIN when that is set",
    Effect.gen(function* () {
      const block = yield* run(yield* parse(["tally", "x"]), screen, settings)
      expect(yield* showcases).toEqual([[block, ["/bin/rex-show", "view", "--session", "session:a", "--spool", "/state/rex-show"]]])
    }).pipe(Effect.provide(Layer.mergeAll(systems, env({ ...inPane, REX_SHOW_BIN: "/bin/rex-show" })))),
    5_000,
  )

  effectTest(
    "outside a pane it is refused with exit 2 and touches no pane",
    Effect.gen(function* () {
      const before = yield* Ref.get(rex)
      const exit = yield* Effect.exit(run(yield* parse(["tally", "x"]), screen, settings))
      expect(refusalOf(exit)).toEqual(Option.some(2))
      expect(yield* Ref.get(rex)).toEqual(before)
    }).pipe(Effect.provide(Layer.mergeAll(systems, env({ REX_SESSION: "session:a" })))),
    5_000,
  )
})

effectTest(
  "the command outside a pane prints why on stderr and exits 2",
  Effect.gen(function* () {
    const child = Bun.spawn(["bun", SHOW, "tally", "x"], { env: { PATH: process.env.PATH }, stdout: "pipe", stderr: "pipe" })
    const [out, err, code] = yield* Effect.all(
      [Effect.promise(() => new Response(child.stdout).text()), Effect.promise(() => new Response(child.stderr).text()), Effect.promise(() => child.exited)],
      { concurrency: 3 },
    )
    expect({ code, out, err: err.includes("not in a Rex pane") }).toEqual({ code: 2, out: "", err: true })
  }),
  10_000,
)
