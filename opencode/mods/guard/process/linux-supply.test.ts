// @reads all
// @reads-reason computed read at mods/guard/process/admission.ts: textOf's fs.readFileString(file), served here by cgroup-fixture.ts's in-memory FileSystem, never the disk
// The Linux supply reads (linuxBudget, linuxLimits) on fixture cgroup trees
// (cgroup-fixture.ts): the workbox as read on 2026-11-25, the same host
// provisioned, cpuset at an ancestor only, no io.weight anywhere, and nothing
// readable. A missing capability is data, never a refusal: the envelope
// always offers every class.
import { describe } from "bun:test"
import { Effect, Option } from "effect"
import { expect, it } from "effect-bun-test"
import type { Purpose } from "../admission-wire.ts"
import { POLICY } from "../host-supply.ts"
import { linuxBudget, linuxEnvelope } from "./admission.ts"
import { PROVISIONED, ROOT, run, type Tree, USER, WORKBOX, withFiles, withoutFiles } from "./cgroup-fixture.ts"

const GiB = 2 ** 30
const ALL: ReadonlyArray<Purpose> = ["check", "land-check", "vm", "inventory", "exclusive-check"]

const weighted = (agent: string, control: string, bite: string) => withFiles(PROVISIONED, {
  [`${USER}/agentwork.slice/io.weight`]: `default ${agent}\n`,
  [`${USER}/opencodecontrol.slice/io.weight`]: `default ${control}\n`,
  [`${ROOT}/bite.slice/io.weight`]: `default ${bite}\n`,
  [`${ROOT}/user.slice/io.weight`]: "default 100\n",
})

describe("the workbox as read on 2026-11-25", () => {
  it.effect("its envelope is the whole host less the reserve: cpuset read at user.slice, memory at user-1000.slice's limit", () =>
    Effect.gen(function* () {
      const envelope = yield* run(WORKBOX, linuxEnvelope)
      expect(envelope.cpuMilli).toBe(16_000 - POLICY.reserveCpuMilli)
      expect(envelope.memoryBytes).toBe(55_834_574_848 - POLICY.reserveMemoryBytes)
      expect(envelope.purposes).toEqual(ALL)
    }))

  it.effect("it is unattested, naming the missing workload slice, and its kernel weighs no IO", () =>
    Effect.gen(function* () {
      const { attestation, budget } = yield* run(WORKBOX, linuxBudget)
      expect(Option.isNone(budget)).toBe(true)
      expect(attestation).toMatchObject({ controller: "unattested", io: "unavailable", file: "agentwork.slice" })
      expect((yield* run(WORKBOX, linuxEnvelope)).attestation).toEqual(attestation)
    }))
})

describe("the workbox provisioned", () => {
  it.effect("with no io.weight anywhere it attests on CPU and memory, its envelope the slice's caps", () =>
    Effect.gen(function* () {
      const { attestation, budget } = yield* run(PROVISIONED, linuxBudget)
      expect(attestation).toEqual({ controller: "enforced", io: "unavailable" })
      expect(Option.map(budget, ({ control }) => control)).toEqual(Option.some(`${USER}/agentwork.slice`))
      const envelope = yield* run(PROVISIONED, linuxEnvelope)
      expect(envelope.cpuMilli).toBe(12_000)
      expect(envelope.containedMemoryBytes).toBe(30 * GiB)
      expect(envelope.purposes).toEqual(ALL)
    }))

  it.effect("where the kernel weighs IO, the weights count: the right ones attest, a low protected one names its file", () =>
    Effect.gen(function* () {
      expect((yield* run(weighted("100", "1000", "1000"), linuxBudget)).attestation).toEqual({ controller: "enforced", io: "weighted" })
      expect((yield* run(weighted("100", "1000", "100"), linuxBudget)).attestation)
        .toMatchObject({ controller: "unattested", io: "weighted", file: `${ROOT}/bite.slice/io.weight` })
    }))

  it.effect("each requirement names its own file when it fails, and every class stays offered", () =>
    Effect.gen(function* () {
      const cases: ReadonlyArray<readonly [string, Tree]> = [
        [`${USER}/agentwork.slice/cpu.weight`, withFiles(PROVISIONED, { [`${USER}/agentwork.slice/cpu.weight`]: "100\n" })],
        [`${USER}/agentwork.slice/cpu.max`, withFiles(PROVISIONED, { [`${USER}/agentwork.slice/cpu.max`]: "max 100000\n" })],
        [`${USER}/agentwork.slice/memory.high`, withoutFiles(PROVISIONED, new Set([`${USER}/agentwork.slice/memory.high`]))],
        [`${USER}/opencodecontrol.slice/memory.min`, withFiles(PROVISIONED, { [`${USER}/opencodecontrol.slice/memory.min`]: "0\n" })],
        [`${ROOT}/bite.slice/cpu.weight`, withFiles(PROVISIONED, { [`${ROOT}/bite.slice/cpu.weight`]: "100\n" })],
      ]
      for (const [file, tree] of cases) {
        expect((yield* run(tree, linuxBudget)).attestation).toMatchObject({ controller: "unattested", file })
        expect((yield* run(tree, linuxEnvelope)).purposes).toEqual(ALL)
      }
    }))
})

it.effect("cpuset at an ancestor only: the nearest one counts, and so does every ancestor's cpu.max and memory.max", () =>
  Effect.gen(function* () {
    const tree: Tree = { slices: {}, files: {
      "/fixture/sys/devices/system/cpu/online": "0-15\n",
      "/fixture/proc/self/cgroup": "0::/work.slice/deep.slice/leaf.scope\n",
      "/fixture/proc/meminfo": "MemTotal: 33554432 kB\n",
      [`${ROOT}/cpuset.cpus.effective`]: "0-7\n",
      [`${ROOT}/work.slice/cpu.max`]: "600000 100000\n",
      [`${ROOT}/work.slice/memory.max`]: `${16 * GiB}\n`,
      [`${ROOT}/work.slice/deep.slice/memory.max`]: "max\n",
    } }
    const envelope = yield* run(tree, linuxEnvelope)
    expect(envelope.cpuMilli).toBe(6000 - POLICY.reserveCpuMilli)
    expect(envelope.memoryBytes).toBe(16 * GiB - POLICY.reserveMemoryBytes)
    const narrow = yield* run(withFiles(tree, { [`${ROOT}/cpuset.cpus.effective`]: "0-3\n" }), linuxEnvelope)
    expect(narrow.cpuMilli).toBe(4000 - POLICY.reserveCpuMilli)
  }))

it.effect("nothing readable: the host's own processor count and memory, unattested, every class offered", () =>
  Effect.gen(function* () {
    const envelope = yield* run({ slices: {}, files: {} }, linuxEnvelope)
    expect(envelope.cpuMilli).toBe(4000 - POLICY.reserveCpuMilli)
    expect(envelope.memoryBytes).toBe(8 * GiB - POLICY.reserveMemoryBytes)
    expect(envelope.purposes).toEqual(ALL)
    expect(envelope.attestation).toMatchObject({ controller: "unattested", io: "unavailable", file: "agentwork.slice" })
  }))
