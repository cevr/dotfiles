// host-admit-queue, the deadlock and width laws (cases 5-7, 2026-11-26):
// - a check run from inside a lease's own process tree is that lease
//   (re-entrant), never a second request queued behind its own ancestor;
// - an explicit `--width N` is the width the lease is recorded at,
//   whatever the wrapped command (`timeout … sh script`, `systemd-run`,
//   `unshare`, `env`, a tool the model reads wider). The real lines.
import { describe, test } from "bun:test"
import { Effect, Option } from "effect"
import { expect, it } from "effect-bun-test"
import { initial, type Lease, transition } from "@dotfiles/opencode-guard/admission"
import { type Request } from "@dotfiles/opencode-guard/admission-wire"
import { POLICY } from "@dotfiles/opencode-guard/host-supply"
import { supply } from "@dotfiles/opencode-guard/memory/admission-acceptance"
import { enclosing } from "./admission.ts"
import { checkSpec } from "./host-admit.ts"

const declared = (payload: string, width: string) =>
  checkSpec(payload.split(" "), ["--class", "check", "--width", width], false).pipe(Effect.map(({ width: recorded }) => String(recorded)))

describe("an explicit --width is honoured whatever the wrapped command", () => {
  it.effect("the incident's lines are recorded at their declared width", () => Effect.gen(function* () {
    expect(yield* Effect.all({
      case5: declared("timeout 600 sh /tmp/vperf2/leg.sh", "2"),
      case6: declared("timeout 900 sh /tmp/r/leg.sh x", "2"),
      case7: declared("timeout 900 /usr/bin/systemd-run --user --scope -q -p MemoryMax=8G -p MemorySwapMax=0 -- /usr/bin/unshare --user --map-root-user --net /usr/bin/env VFY_PKG=x bun runner.ts label t.test.ts", "2"),
      case8: declared("timeout 60m sh light.sh sh mutants-r2c.sh", "4"),
      orch: declared("timeout 80m zsh /tmp/opencode/orch-2a0r.sh", "4"),
      taskset: declared("timeout 900 systemd-run --user --scope -p MemoryMax=4G taskset -c 0 sh /tmp/x.sh", "2"),
      wider: declared("bun test --parallel=8 src", "2"),
      probe: declared("/bin/true", "1"),
    })).toEqual({ case5: "2", case6: "2", case7: "2", case8: "4", orch: "4", taskset: "2", wider: "2", probe: "1" })
  }))
  it.effect("with no --width, the tool model decides", () => Effect.gen(function* () {
    const modelled = yield* checkSpec(["bun", "test", "--parallel=8", "src"], ["--class", "check"], false)
    expect(String(modelled.width)).toBe("8")
  }))
})

describe("a request from inside a lease's own process tree is that lease", () => {
  const request = (id: string): Request => ({
    version: 1, requestId: id, principal: { kind: "external-runner", scopeId: "p", epoch: 1 }, purpose: "check", tier: "standard",
    deadlineBootMs: POLICY.queueMs, demand: { width: "unknown", cpuMilli: 1000, memoryBytes: 0, ioClass: "idle", keys: [], volumeReservations: [{ volumeId: "volume-a", bytes: 0 }] },
  })
  const rows = ["outer", "other", "unknown"].reduce((state, id) =>
    transition(state, { op: "request", owner: id, request: request(id) }, supply({ now: 1 })).state, initial("h", "b"))
  const row = (id: string): Lease => Option.getOrThrow(Option.fromNullishOr(Object.values(rows.leases).find((lease) => lease.owner === id)))
  test("the nearest ancestor that owns a lease is the enclosing one; a stranger's lease is not", () => {
    const owners = [{ row: row("other"), pid: Option.some(777) }, { row: row("outer"), pid: Option.some(431_000) }, { row: row("unknown"), pid: Option.none() }]
    // host-admit (431379) <- timeout <- sh -c (the wrapped line) <- host-admit wrapper (431000, the outer lease)
    expect(Option.map(enclosing([431_378, 431_377, 431_000, 3_595_907], owners), ({ owner }) => owner)).toEqual(Option.some("outer"))
    expect(enclosing([10, 11, 12], owners)).toEqual(Option.none())
  })
})
