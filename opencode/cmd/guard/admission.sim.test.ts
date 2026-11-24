import { Effect, Option, Predicate, Schema } from "effect"
import { Admission, AdmissionUnavailable, cpuDemand, initial, shellFact, type ShellFact, transition } from "@dotfiles/opencode-guard/admission"
import { demandOnVolume, enforceDeclaredWidth } from "@dotfiles/opencode-guard/check-demand"
import { encodeProgram, owner, request, shellLaunchLaws, shellProgram, supply, type ShellExit, type ShellLaunchDriver } from "@dotfiles/opencode-guard/memory/admission-acceptance"
import { systemdArgv } from "@dotfiles/opencode-guard/process/launchers"
import { linuxPressure } from "@dotfiles/opencode-guard/process/admission"
import { issue, watchdogPlan, type Actuation, type SignalIntent } from "@dotfiles/opencode-guard/process/actuation"
import { attachGrant, attestLinux, linuxDrain, runAfterClaim, stopLinux, type LinuxManager } from "@dotfiles/opencode-guard/process/linux-controller"
import { simulationRunner } from "../../sim/seed.ts"
import { checkSpec } from "./host-admit.ts"

const { seeded } = simulationRunner("cmd/guard/admission.sim.test.ts")
const persisted = Schema.fromJsonString(Admission)
const encode = Schema.encodeSync(persisted)
const decode = Schema.decodeUnknownSync(persisted)
const outcome = (exit: ShellExit) => {
  if ("code" in exit) return exit.code
  if ("signal" in exit) return exit.signal
  return "unknown"
}
const expectedDispatch = (authority: boolean): Array<SignalIntent["signal"]> => {
  if (authority) return ["TERM", "KILL"]
  return []
}
const counterFiles = ["cpu.max", "memory.max", "memory.swap.max", "memory.oom.group", "cgroup.events"] as const

seeded("a Linux declaration is a scope cap, not a tool inference or advisory hint", ({ expect }) =>
  Effect.gen(function* () {
    const payload = ["/fixture/unmodeled", "-j", "99"]
    const options = ["--class", "vm", "--width", "1"]
    const linux = yield* checkSpec(payload, options, true)
    const darwin = yield* checkSpec(payload, options, false)
    expect({ width: String(linux.width), imposed: linux.imposed }).toEqual({ width: "1", imposed: true })
    expect({ width: darwin.width, imposed: darwin.imposed }).toEqual({ width: "unknown", imposed: false })
    const demand = enforceDeclaredWidth(demandOnVolume(linux, "fixture"))
    const cap = cpuDemand(demand, 10000)
    expect(cap).toBe(1000)
    expect(systemdArgv({ id: "declaration", generation: 1, cwd: "/fixture", cpuMilli: cap,
      memoryBytes: demand.memoryBytes, helper: payload })).toContain("CPUQuota=100%")
  }),
)

seeded("historical load cannot fence a start; measured PSI and the current runnable ceiling can", ({ expect }) =>
  Effect.sync(() => {
    const offer = (rawLoad: string, cpu: number, runnable = 1) => {
      const input = { rawLoad, cpu, memory: 0, io: 0, swap: 0 }
      const at = supply({ cores: 16, overrides: { pressure: linuxPressure(input), runnable } })
      return transition(initial("host", "boot"), { op: "request", owner: owner("one"), request: request("one") }, at).reply.reason
    }
    for (const raw of ["0", "1", "45", "100000", "unreadable", ""]) expect(offer(raw, 0)).toBe("granted")
    expect(offer("1", 50)).toBe("pressure")
    expect(offer("1", 0, 16)).toBe("pressure")
  }),
)

seeded("the shell launch contract permits only one bound spawn past permission, keeps handoffs and drains proved scope exit", ({ expect }) =>
  Effect.gen(function* () {
    let state = initial("host", "boot")
    const launched: string[] = []
    const journal: string[] = []
    const io: string[] = []
    const woke: string[] = []
    const known = new Map<string, string>()
    const bound = new Set<string>()
    const execClosed = new Set<string>()
    const ended = new Set<string>()
    const blocked = new Set<string>()
    const retired = new Set<string>()
    const offline = new Set<string>()
    const deferredWake = new Map<string, string>()
    const record = (shell: ShellFact["shell"], event: string) => { journal.push(`${shell.id}:${event}`) }
    const incarnation = (shell: ShellFact["shell"]) => `${shell.owner}:${shell.ownerEpoch}`
    const intent = (shell: ShellFact["shell"]) => `${incarnation(shell)}:${shell.attempt}`
    const execute = (shell: ShellFact["shell"], program: typeof shellProgram) => {
      launched.push(shell.id)
      io.push(`${shell.id}:${encodeProgram(program)}`)
    }
    const apply = (fact: ShellFact) => Effect.sync(() => {
      const action = shellFact(state, fact)
      if (Option.isNone(action)) return
      const next = transition(state, action.value, supply({ cores: 3 }))
      const { shell } = fact
      const affected = next.changes.find((row) => row.request.requestId === shell.id)
      if (fact.kind === "authorized" && affected && !known.has(shell.id)) {
        known.set(shell.id, intent(shell))
        record(shell, "authorized")
      }
      if (fact.kind === "bound" && affected?.state === "running" && !bound.has(shell.id)) {
        bound.add(shell.id)
        record(shell, "bound")
        if (!execClosed.has(shell.id)) execute(shell, shellProgram)
      }
      if (fact.kind === "ended" && affected?.state === "released") record(shell, "drained")
      state = next.state
    })
    const cancel = (shell: ShellFact["shell"]) => Effect.sync(() => {
      const row = Object.values(state.leases).find(({ request }) => request.requestId === shell.id)
      if (!row || known.get(shell.id) !== intent(shell)) return
      state = transition(state, { op: "cancel", id: row.id, owner: row.owner }, supply({ cores: 3 })).state
      record(shell, "cancelled")
    })
    const driver: ShellLaunchDriver = {
      permission: (shell, verdict) => {
        if (verdict === "allowed" && !blocked.has(shell.id)) return apply({ kind: "authorized", shell, request: request(shell.id) })
        return Effect.sync(() => { if (verdict === "denied") blocked.add(shell.id) })
      },
      bind: (shell, binding) => apply({ kind: "bound", shell, binding }),
      owner: (shell, state) => {
        const observed = Effect.sync(() => {
          if (known.get(shell.id) !== intent(shell)) return
          record(shell, `owner:${state}`)
          if (state === "terminal") retired.add(incarnation(shell))
        })
        if (state === "terminal") return observed.pipe(Effect.andThen(apply({ kind: "terminal-owner", shell, evidence: "settled" })))
        return observed.pipe(Effect.andThen(apply({ kind: state, shell })))
      },
      finish: (shell, binding, scope) => apply({ kind: "ended", shell, binding, scope, evidence: "observed" }),
      restart: () => Effect.sync(() => {
        state = decode(encode(state))
        offline.clear()
        for (const owner of deferredWake.values()) {
          if (!retired.has(owner)) woke.push(owner)
        }
        deferredWake.clear()
      }),
      launches: () => Effect.sync(() => [...launched]),
      held: () => Effect.sync(() => Object.values(state.leases).filter(({ state }) => state === "running" || state === "draining").map((row) => row.request.requestId)),
      input: (shell, value) => Effect.sync(() => {
        if (launched.includes(shell.id) && !ended.has(shell.id) && known.get(shell.id) === intent(shell))
          io.push(`${shell.id}:stdout:${value}`, `${shell.id}:stderr:${value}`)
      }),
      cancel,
      place: (shell, place) => {
        if (place === "rejected") return cancel(shell)
        return Effect.void
      },
      holdExec: (shell) => Effect.sync(() => { execClosed.add(shell.id) }),
      openExec: (shell) => Effect.sync(() => {
        if (known.get(shell.id) !== intent(shell) || !execClosed.delete(shell.id) || !bound.has(shell.id)) return
        const lease = Object.values(state.leases).find(({ request }) => request.requestId === shell.id)
        if (lease?.state === "running") execute(shell, shellProgram)
      }),
      transportFailure: (shell, phase) => Effect.sync(() => {
        if (phase === "before-ack") blocked.add(shell.id)
        else if (bound.has(shell.id)) offline.add(shell.id)
      }),
      complete: (shell, exit) => Effect.sync(() => {
        if (!bound.has(shell.id) || ended.has(shell.id) || known.get(shell.id) !== intent(shell)) return
        ended.add(shell.id)
        const result = outcome(exit)
        record(shell, `ended:${result}`)
        io.push(`${shell.id}:exit:${result}`)
        const owner = incarnation(shell)
        if (offline.has(shell.id)) deferredWake.set(shell.id, owner)
        else if (!retired.has(owner)) woke.push(owner)
      }),
      snapshot: () => Effect.sync(() => ({ watermark: journal.length, shells: [...known.keys()] })),
      replay: (after) => Effect.sync(() => journal.slice(after)),
      payloads: () => Effect.sync(() => [...io]),
      wakes: () => Effect.sync(() => [...woke]),
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

seeded("the Linux manager attests the exact attached generation before exec, and drains only after both fences", ({ expect }) =>
  Effect.gen(function* () {
    const id = { id: "lease", generation: 2, owner: "peer" }
    const unit = `host-admit-run-${"a".repeat(32)}`
    const root = "/sys/fs/cgroup/user.slice/agentwork.slice"
    const path = `${root}/${unit}.service`
    const failure = new AdmissionUnavailable({ reason: "unqualified" })
    let group = path.slice("/sys/fs/cgroup".length)
    let quota = "100000 100000"
    let populated = true
    let exists = true
    const actions: string[] = []
    const manager: LinuxManager = {
      workloadRoot: Effect.succeed(root),
      currentGroup: Effect.sync(() => `0::${group}`),
      read: (file) => Effect.suspend(() => {
        if (!file.startsWith(`${path}/`) || !exists) return Effect.fail(failure)
        const data = {
          "cpu.max": quota, "memory.max": "262144000", "memory.swap.max": "0", "memory.oom.group": "1",
          "cgroup.events": `populated ${Number(populated)}`,
        }
        const name = counterFiles.find((item) => item === file.slice(path.length + 1))
        if (Predicate.isUndefined(name)) return Effect.fail(failure)
        return Effect.succeed(data[name])
      }),
      exists: () => Effect.sync(() => exists),
      stop: (unit) => Effect.sync(() => { actions.push(`stop:${unit}`) }),
    }
    const grant = { ...id, state: "granted" }
    const attach = (generation: number, state: "queued" | "running" = "running") =>
      attachGrant({ ...id, generation }, Option.some(grant), () => Effect.gen(function* () {
        const placed = yield* attestLinux(manager, unit, 1000, 262144000)
        actions.push("bind")
        return yield* runAfterClaim({ state, reason: state }, () => Effect.sync(() => {
          actions.push("exec")
          return placed
        }))
      }))
    expect(yield* Effect.option(attach(1))).toEqual(Option.none())
    quota = "200000 100000"
    expect(yield* Effect.option(attach(2))).toEqual(Option.none())
    expect(actions).toEqual([])
    quota = "100000 100000"
    expect(yield* attach(2, "queued")).toEqual(Option.none())
    expect(actions).toEqual(["bind"])
    expect(yield* attach(2)).toEqual(Option.some(path))
    expect(actions).toEqual(["bind", "bind", "exec"])
    group = "/unowned"
    expect(yield* Effect.option(stopLinux(manager, path, true))).toEqual(Option.none())
    group = path.slice("/sys/fs/cgroup".length)
    expect(yield* Effect.option(stopLinux(manager, path, false))).toEqual(Option.none())
    yield* stopLinux(manager, path, true)
    expect(actions).toEqual(["bind", "bind", "exec", `stop:${unit}.service`])
    expect(yield* linuxDrain(manager, path, "gone")).toBe("live")
    populated = false
    expect(yield* linuxDrain(manager, path, "held")).toBe("live")
    expect(yield* linuxDrain(manager, path, "unknown")).toBe("unknown")
    expect(yield* linuxDrain(manager, path, "gone")).toBe("gone")
    exists = false
    expect(yield* linuxDrain(manager, path, "gone")).toBe("gone")
  }),
)

seeded("actuation reaches only a proven own group across both loss orders and ambiguous identity evidence", ({ expect }) =>
  Effect.gen(function* () {
    const seen: SignalIntent[] = []
    const port: Actuation = { dispatch: (intent) => Effect.sync(() => { seen.push(intent) }) }
    for (const armed of [false, true]) {
      for (const order of ["none", "drained", "eof", "stop"] as const) {
        seen.length = 0
        yield* issue(port, watchdogPlan({ source: "pipe", armed, order }))
        const wanted = armed && (order === "eof" || order === "stop")
        expect(seen.map(({ signal }) => signal)).toEqual(expectedDispatch(wanted))
        expect(seen.every(({ target }) => target === "own-group")).toBe(true)
      }
    }
    for (const ownGroup of [false, true]) {
      for (const watchdog of ["gone", "live", "unknown"] as const) {
        seen.length = 0
        yield* issue(port, watchdogPlan({ source: "leader", ownGroup, watchdog }))
        expect(seen.map(({ signal }) => signal)).toEqual(expectedDispatch(ownGroup && watchdog === "gone"))
        expect(seen.every(({ target }) => target === "own-group")).toBe(true)
      }
    }
    seen.length = 0
    for (const proof of ["escaped", "reused", "unknown"] as const) yield* issue(port, watchdogPlan({ source: "observation", proof }))
    expect(seen).toEqual([])
  }),
)
