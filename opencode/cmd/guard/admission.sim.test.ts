import { Effect, Option, Schema } from "effect"
import { Admission, initial, shellFact, type ShellFact, transition } from "@dotfiles/opencode-guard/admission"
import { owner, request, shellLaunchLaws, supply, type ShellLaunchDriver } from "@dotfiles/opencode-guard/memory/admission-acceptance"
import { systemdArgv } from "@dotfiles/opencode-guard/process/launchers"
import * as Seed from "../../sim/seed.ts"

const { seeded } = Seed.runner("cmd/guard/admission.sim.test.ts")
const persisted = Schema.fromJsonString(Admission)
const encode = Schema.encodeSync(persisted)
const decode = Schema.decodeUnknownSync(persisted)

seeded("the shell launch contract permits only one bound spawn past permission, keeps handoffs and drains proved scope exit", ({ expect }) =>
  Effect.gen(function* () {
    let state = initial("host", "boot")
    const launched: string[] = []
    const apply = (fact: ShellFact) => Effect.sync(() => {
      const action = shellFact(state, fact)
      if (Option.isNone(action)) return
      const next = transition(state, action.value, supply({ cores: 3 }))
      const changed = next.changes.some((row) => row.request.requestId === fact.shell.id && row.state === "running")
      if (action.value.op === "claim" && changed) launched.push(fact.shell.id)
      state = next.state
    })
    const driver: ShellLaunchDriver = {
      permission: (shell, verdict) => {
        if (verdict === "allowed") return apply({ kind: "authorized", shell, request: request(shell.id) })
        return Effect.void
      },
      bind: (shell, binding) => apply({ kind: "bound", shell, binding }),
      owner: (shell, state) => {
        if (state === "terminal") return apply({ kind: "terminal-owner", shell, evidence: "settled" })
        return apply({ kind: state, shell })
      },
      finish: (shell, binding, scope) => apply({ kind: "ended", shell, binding, scope, evidence: "observed" }),
      restart: () => Effect.sync(() => { state = decode(encode(state)) }),
      launches: () => Effect.sync(() => [...launched]),
      held: () => Effect.sync(() => Object.values(state.leases).filter(({ state }) => state === "running" || state === "draining").map((row) => row.request.requestId)),
    }
    yield* shellLaunchLaws(driver, (actual, expected) => expect(actual).toEqual(expected))
  }),
)

seeded("eight of 28 offered cores are granted, excess and later one-core request queue", ({ expect }) =>
  Effect.sync(() => {
    let state = initial("host", "boot")
    const at = supply({ overrides: { outsideNoncriticalMilli: 6000, effectiveCpuMilli: 16000 } })
    const post = (id: string, width: number) => {
      const next = transition(state, { op: "request", request: request(id, width * 1000), owner: owner(id) }, at)
      state = next.state
      return next.reply.state
    }
    const prior = Array.from({ length: 7 }, (_, i) => post(`job-${i}`, 4))
    expect(prior).toEqual(["granted", "granted", "queued", "queued", "queued", "queued", "queued"])
    expect(post("one-more", 1)).toBe("queued")
    const charges = Object.values(state.leases).reduce(
      (totals, row) => ({ granted: totals.granted + Option.match(row.admittedDemand, { onSome: ({ cpuMilli }) => cpuMilli, onNone: () => 0 }),
        queued: totals.queued + Number(row.state === "queued") * row.request.demand.cpuMilli }),
      { granted: 0, queued: 0 },
    )
    expect(charges).toEqual({ granted: 8000, queued: 21000 })
  }),
)

seeded("the Linux offer puts only a one-use helper in the protected manager's workload slice", ({ expect }) =>
  Effect.sync(() => {
    const helper = ["/scratch/bin/bun", "/scratch/host-admit.ts", "internal-attach", "/run/user/1/fixture/start"]
    const config = { id: "lease-fixture", generation: 2, cwd: "/scratch/place with spaces", cpuMilli: 1750, memoryBytes: 2 ** 30, helper }
    const command = systemdArgv(config)
    expect(command[0]).toBe("/usr/bin/systemd-run")
    expect(command).toContain("--slice=agentwork.slice")
    expect(command).not.toContain("--scope")
    expect(command).toContain("CPUQuota=175%")
    expect(command).toContain("MemoryMax=1073741824")
    expect(command).toContain("KillMode=control-group")
    expect(command).toContain("TimeoutStopSec=2s")
    expect(command).toContain("--working-directory=/scratch/place with spaces")
    expect(command.slice(command.indexOf("--") + 1)).toEqual(helper)
    const unit = (args: ReadonlyArray<string>) => args.find((arg) => arg.startsWith("--unit="))
    expect(unit(command)).not.toBe(unit(systemdArgv({ ...config, generation: 3 })))
  }),
)
