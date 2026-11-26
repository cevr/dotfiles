// The pool's Antigravity wiring (wiring.ts, what cmd/pool/server.ts uses for
// the pool_push status rows, the `antigravity` RPC method and the tool) with
// a reading present, with no source, and with a source whose every method
// fails or dies: the pool's own answer always comes, Antigravity's rows after
// it, or one typed "unknown" row in their place.
import { describe } from "bun:test"
import { Effect, Match, Option } from "effect"
import { expect, it } from "effect-bun-test"
import { OpenStatus } from "./fleet.ts"
import { GateDecision } from "./gate.ts"
import { RecordRefusal } from "./limit.ts"
import type { Source } from "./source.ts"
import { Answer } from "./state.ts"
import { Availability, availability, containedLine, failedLine, wire } from "./wiring.ts"

const ROWS = ["antigravity / Gemini · open", "  read Nov 24, 2026, 8:00:00 PM EST (now) · next read possible Nov 24, 2026, 8:05:00 PM EST"]
const RESET = Date.parse("2026-11-25T03:00:00Z")

const present: Source = {
  lines: Effect.succeed(ROWS),
  report: Effect.succeed({ host: "mac", at: RESET - 60_000, readableSignIn: true, limits: [] }),
  open: (target) =>
    Effect.succeed(
      Match.value(Option.contains(target, "claude-opus-4-6")).pipe(
        Match.when(true, () => [
          {
            group: "claude-gpt",
            label: "Claude & GPT (shared)",
            answer: Answer.cases.Limited.make({ until: RESET, by: "limit" }),
            open: OpenStatus.cases.NotNow.make({ until: RESET, why: "limit", answer: Answer.cases.Limited.make({ until: RESET, by: "limit" }) }),
          },
        ]),
        Match.orElse(() => [
          {
            group: "gemini",
            label: "Gemini",
            answer: Answer.cases.Open.make({}),
            open: OpenStatus.cases.Now.make({ measured: true, answer: Answer.cases.Open.make({}) }),
          },
        ]),
      ),
    ),
  record: () => Effect.succeed(Option.none()),
  clear: () => Effect.void,
  read: () => Effect.succeed({ note: "Read now.", lines: ROWS }),
  gate: () => Effect.succeed(GateDecision.cases.Admitted.make({ group: "gemini", measured: true, answer: Answer.cases.Open.make({}), geminiFleetCount: 1, geminiAgentCount: 1 })),
  heartbeat: () => Effect.void,
  release: () => Effect.void,
}

/** Every method a defect, as a thrown exception in Antigravity's code would be. */
const dying: Source = {
  lines: Effect.die(new TypeError("lines threw")),
  report: Effect.die(new TypeError("report threw")),
  open: () => Effect.die(new TypeError("open threw")),
  record: () => Effect.die(new TypeError("record threw")),
  clear: () => Effect.die(new TypeError("clear threw")),
  read: () => Effect.die(new TypeError("read threw")),
  gate: () => Effect.die(new TypeError("gate threw")),
  heartbeat: () => Effect.die(new TypeError("heartbeat threw")),
  release: () => Effect.die(new TypeError("release threw")),
}

const toolText = (agy: Availability, action: "status" | "read") =>
  Effect.map(wire(agy).tool.execute({ action }), (result) => result.content.map((part) => part.text).join("\n"))

describe("the pool's Antigravity wiring", () => {
  it.effect("a reading present: a status push carries its rows after the pool's; another action none; the RPC and the tool answer them", () =>
    Effect.gen(function* () {
      const agy = wire(Availability.Present({ source: present }))
      expect(yield* agy.pushText("status", "pool: 2 sources")).toBe(["pool: 2 sources", ...ROWS].join("\n"))
      expect(yield* agy.pushText("start", "started")).toBe("started")
      expect(yield* agy.rpc()).toEqual({ lines: ROWS })
      expect(yield* agy.rpc({ action: "open", model: "claude-opus-4-6" })).toEqual({
        groups: [
          {
            group: "claude-gpt",
            label: "Claude & GPT (shared)",
            open: false,
            measured: true,
            until: RESET,
            text: expect.stringContaining("limited until"),
          },
        ],
        lines: ROWS,
      })
      expect(yield* toolText(Availability.Present({ source: present }), "read")).toContain("Read now.")
      expect(yield* toolText(Availability.Present({ source: present }), "status")).toContain("antigravity / Gemini · open")
      // RPC record with a future `at` returns a typed FutureAt refusal (TestClock starts at 0)
      const refusedRpc = yield* agy.rpc({ action: "limit", text: "Individual quota reached. Resets in 30m.", at: 60_000 })
      expect(refusedRpc.recorded).toBe(false)
      expect(refusedRpc.refused).toEqual(RecordRefusal.cases.FutureAt.make({ at: 60_000, now: 0 }))
    }),
  )

  it.effect("no source (the option off, or its build failed): the pool's text alone, no rows, and the tool says it is off", () =>
    Effect.gen(function* () {
      const agy = wire(Availability.Off())
      expect(yield* agy.pushText("status", "pool: 2 sources")).toBe("pool: 2 sources")
      expect(yield* agy.rpc()).toEqual({ lines: [] })
      expect(yield* toolText(Availability.Off(), "status")).toContain("not read on this host")
    }),
  )

  it.effect("a source whose every method dies: the pool's text still comes, with one typed unknown row; the RPC and the tool answer", () =>
    Effect.gen(function* () {
      const agy = wire(Availability.Present({ source: dying }))
      expect(yield* agy.pushText("status", "pool: 2 sources")).toBe(["pool: 2 sources", containedLine("TypeError")].join("\n"))
      expect(yield* agy.rpc()).toEqual({ lines: [containedLine("TypeError")] })
      for (const action of ["status", "read"] as const) expect(yield* toolText(Availability.Present({ source: dying }), action)).toBe(containedLine("TypeError"))
      expect(containedLine("TypeError")).toBe("antigravity · unknown: the Antigravity reader failed here (TypeError)")
    }),
  )

  it.effect("a root's answer is its availability: a source present, none as off, a failure or defect as failed with its reason, never off", () =>
    Effect.gen(function* () {
      expect(yield* availability(Effect.succeed(Option.some(present)))).toEqual(Availability.Present({ source: present }))
      expect(yield* availability(Effect.succeed(Option.none()))).toEqual(Availability.Off())
      expect(yield* availability(Effect.die(new RangeError("root died")))).toEqual(Availability.Failed({ reason: "RangeError" }))
      const failed = wire(Availability.Failed({ reason: "RangeError" }))
      expect(yield* failed.pushText("status", "pool: 2 sources")).toBe(["pool: 2 sources", failedLine("RangeError")].join("\n"))
      expect(yield* failed.rpc()).toEqual({ lines: [failedLine("RangeError")] })
      for (const action of ["status", "read"] as const) {
        const text = yield* toolText(Availability.Failed({ reason: "RangeError" }), action)
        expect(text).toBe("antigravity · unavailable: its source did not build on this host (RangeError); the antigravity option is on")
        expect(text).not.toContain("option is off")
      }
    }),
  )
})
