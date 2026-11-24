import { Effect, Layer } from "effect"
import * as Backstop from "@dotfiles/opencode-wake/memory/backstop"
import * as Checks from "@dotfiles/opencode-wake/memory/checks"
import * as Courier from "@dotfiles/opencode-wake/memory/courier"
import * as Opener from "@dotfiles/opencode-wake/memory/opener"
import * as Runner from "@dotfiles/opencode-wake/memory/runner"
import * as Store from "@dotfiles/opencode-wake/memory/store"
import * as Model from "@dotfiles/opencode-wake/model"
import { Changes, JobRefused } from "@dotfiles/opencode-wake/service"
import { admittedJobArgv, classifyJob } from "@dotfiles/opencode-wake/process/supervise"
import { simulationRunner } from "../../sim/seed.ts"

const { seeded } = simulationRunner("cmd/wake/job-admission.sim.test.ts")

// Observe the existing job-to-launcher seam on the exact base. Supply and
// process execution are controlled boundaries; nothing starts on the host.
seeded("a below-floor or unavailable host prevents a heavy job from reaching the payload", ({ expect, seed }) => {
    const memory = Runner.empty()
    const faults = ["unavailable", "disk"] as const
    const [short = faults[0]] = faults.slice(seed % faults.length)
    const layers = Layer.mergeAll(
      Backstop.layer(Backstop.empty()),
      Checks.layer(Checks.empty()),
      Courier.layer(Courier.empty("ses_fixture")),
      Opener.layer(Opener.empty()),
      Runner.layer(memory, (spec) => {
        if (!spec.heavy) return Effect.void
        return Effect.fail(new JobRefused({ message: short }))
      }),
      Store.layer(Store.empty()),
      Layer.succeed(Changes, Changes.of({ changed: () => Effect.void })),
    )
    const world = Model.layer({ directory: "/scratch/project", classifyJob }).pipe(Layer.provide(layers))
    return Effect.gen(function* () {
      const model = yield* Model.WakesModel
      yield* Effect.result(model.job("ses_fixture", { command: "printf fixture", heavy: true, note: "fixture" }))
      yield* Effect.result(model.job("ses_fixture", { command: "bun test --filter exact", heavy: false, note: "classified" }))
      yield* model.job("ses_fixture", { command: "printf light", note: "control" })
      expect([...memory.jobs.values()].map(({ spec }) => spec.command)).toEqual(["printf light"])
      expect(admittedJobArgv(["bun", "host-admit.ts"], "bun test --filter exact", false))
        .toEqual(["bun", "host-admit.ts", "check", "run", "--class", "check", "--", "/bin/sh", "-c", "bun test --filter exact"])
    }).pipe(Effect.provide(world), Effect.scoped)
})
