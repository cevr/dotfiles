// The ledger held in memory: its lines in an array the caller may share, so
// a second layer on the same array is the ledger after a restart.
import { Effect, Layer } from "effect"
import { type Line, make } from "../ledger.ts"
import type { Cadence } from "../machine.ts"
import { Ledger } from "../service.ts"

/** A ledger on `lines`: what it reads at a root's first decision, and where it appends. */
export const layer = (cadence: Cadence, lines: Array<unknown> = []) =>
  Layer.effect(
    Ledger,
    make(
      {
        read: (sessionID) =>
          Effect.sync(() => lines.filter((line) => typeof line === "object" && line !== null && (line as { sessionID?: unknown }).sessionID === sessionID)),
        append: (line: Line) => Effect.sync(() => void lines.push(line)),
      },
      cadence,
    ),
  )
