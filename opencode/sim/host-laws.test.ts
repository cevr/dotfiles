// The host laws on the world, at every seed: the law probe (sim/server.ts)
// loaded into the world runs each law from inside it, as tests/host-laws.test.ts
// runs it in real OpenCode. And no operation the world's context offers stands
// without a law: every one of them is named by one.
import type { Plugin } from "@opencode/plugin/effect"
import { describe, expect } from "bun:test"
import { Effect, Predicate } from "effect"
import { OPERATIONS } from "./context.ts"
import { answer, LAW_FOLDER, LAWS, PROBE_OPTIONS } from "./host-laws.ts"
import * as Seed from "./seed.ts"
import { BROKEN, DONE, KEPT, NAMES, outcome } from "./law-names.ts"
import Probe from "./server.ts"
import * as World from "./world.ts"

const { seeded } = Seed.runner("sim/host-laws.test.ts")

/** One world on `seed` with the probe loaded for the law folder, run until it has run every law: its log. */
const lawsOn = (seed: number) =>
  Effect.gen(function* () {
    const world = World.make({ seed, script: (request) => World.say(answer(request.kind, request.text)) })
    yield* world.load(Probe, { directory: `/scratch/${LAW_FOLDER}`, options: PROBE_OPTIONS })
    yield* world.until(() => world.logs().some((line) => line.message === DONE), 20 * 60_000, 500)
    return world.logs().flatMap(lawLine)
  })

/** A law's outcome line, alone; nothing for another. */
const lawLine = (line: { readonly message: string }) => {
  if (line.message.startsWith(KEPT) || line.message.startsWith(BROKEN)) return [line.message]
  return []
}

describe("the host laws on the world", () => {
  for (const law of LAWS)
    seeded(law.name, ({ seed, expect: check }) =>
      Effect.gen(function* () {
        const lines = yield* lawsOn(seed)
        check(outcome(lines, law.name)).toEqual([`${KEPT}${law.name}`])
      }),
    )

  Seed.effect(
    "the real run names the same laws, in the same order",
    Effect.sync(() => expect(LAWS.map((law) => law.name)).toEqual([...NAMES])),
  )

  Seed.effect(
    "every operation the world's context offers is named by a law, and the context offers nothing else",
    Effect.gen(function* () {
      const named = new Set(LAWS.flatMap((law) => law.operations))
      expect(OPERATIONS.filter((operation) => !named.has(operation))).toEqual([])
      const offered: Array<string> = []
      const world = World.make({ seed: 1, script: () => World.say("") })
      const walker: Plugin.Plugin = {
        id: "dotfiles-opencode.sim-walker",
        effect: (ctx) => Effect.sync(() => void offered.push(...operationsOf(ctx))),
      }
      yield* world.load(walker, { directory: "/scratch/walk" })
      expect(offered.toSorted()).toEqual([...OPERATIONS].toSorted())
    }),
  )
})

/** The paths of what a context offers: its data, its domains' operations, and an operation that is itself a domain (`rpc`). */
const operationsOf = (ctx: Plugin.Context) =>
  Object.entries(ctx).flatMap(([key, value]): ReadonlyArray<string> => {
    if (key === "options" || key === "location") return [key]
    const inner = Object.keys(value).map((name) => `${key}.${name}`)
    if (Predicate.isFunction(value)) return [key, ...inner]
    return inner
  })
