// The pool's Antigravity wiring (wiring.ts, what cmd/pool/server.ts uses for
// the pool_push status rows, the `antigravity` RPC method and the tool) with
// a reading present, with no source, and with a source whose every method
// fails or dies: the pool's own answer always comes, Antigravity's rows after
// it, or one typed "unknown" row in their place.
import { describe } from "bun:test"
import { Effect, Option } from "effect"
import { expect, it } from "effect-bun-test"
import type { Source } from "./source.ts"
import { containedLine, wire } from "./wiring.ts"

const ROWS = ["antigravity / Gemini · open", "  read Nov 24, 2026, 8:00:00 PM EST (now) · next read possible Nov 24, 2026, 8:05:00 PM EST"]

const present: Source = {
  lines: Effect.succeed(ROWS),
  open: () => Effect.succeed([]),
  record: () => Effect.succeed(Option.none()),
  clear: () => Effect.void,
  read: () => Effect.succeed({ note: "Read now.", lines: ROWS }),
}

/** Every method a defect, as a thrown exception in Antigravity's code would be. */
const dying: Source = {
  lines: Effect.die(new TypeError("lines threw")),
  open: () => Effect.die(new TypeError("open threw")),
  record: () => Effect.die(new TypeError("record threw")),
  clear: () => Effect.die(new TypeError("clear threw")),
  read: () => Effect.die(new TypeError("read threw")),
}

const toolText = (agy: Option.Option<Source>, action: "status" | "read") =>
  Effect.map(wire(agy).tool.execute({ action }), (result) => result.content.map((part) => part.text).join("\n"))

describe("the pool's Antigravity wiring", () => {
  it.effect("a reading present: a status push carries its rows after the pool's; another action none; the RPC and the tool answer them", () =>
    Effect.gen(function* () {
      const agy = wire(Option.some(present))
      expect(yield* agy.pushText("status", "pool: 2 sources")).toBe(["pool: 2 sources", ...ROWS].join("\n"))
      expect(yield* agy.pushText("start", "started")).toBe("started")
      expect(yield* agy.rpc()).toEqual({ lines: ROWS })
      expect(yield* toolText(Option.some(present), "read")).toContain("Read now.")
      expect(yield* toolText(Option.some(present), "status")).toContain("antigravity / Gemini · open")
    }),
  )

  it.effect("no source (the option off, or its build failed): the pool's text alone, no rows, and the tool says it is off", () =>
    Effect.gen(function* () {
      const agy = wire(Option.none())
      expect(yield* agy.pushText("status", "pool: 2 sources")).toBe("pool: 2 sources")
      expect(yield* agy.rpc()).toEqual({ lines: [] })
      expect(yield* toolText(Option.none(), "status")).toContain("not read on this host")
    }),
  )

  it.effect("a source whose every method dies: the pool's text still comes, with one typed unknown row; the RPC and the tool answer", () =>
    Effect.gen(function* () {
      const agy = wire(Option.some(dying))
      expect(yield* agy.pushText("status", "pool: 2 sources")).toBe(["pool: 2 sources", containedLine("TypeError")].join("\n"))
      expect(yield* agy.rpc()).toEqual({ lines: [containedLine("TypeError")] })
      for (const action of ["status", "read"] as const) expect(yield* toolText(Option.some(dying), action)).toBe(containedLine("TypeError"))
      expect(containedLine("TypeError")).toBe("antigravity · unknown: the Antigravity reader failed here (TypeError)")
    }),
  )
})
