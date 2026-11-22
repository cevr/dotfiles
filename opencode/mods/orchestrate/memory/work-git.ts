// Committed work and who is on it, held in memory for the plugin's tests: each head's place against the default
// branch and commit time, each lane's last HEAD move, the lanes a process works in, and the default branch's land
// times, in a world the test changes. A head it does not hold is on the default branch (a world with no lost work).
import { Effect, Layer, Option } from "effect"
import { type HeadSeen, type LaneStatus, OnMain } from "../lost.ts"
import { WorkGit } from "../service.ts"

export interface World {
  /** Each head the test placed, by the name a lane or request gives it. */
  readonly heads: Map<string, HeadSeen>
  /** Each lane's last HEAD move (epoch ms), by path. */
  readonly touched: Map<string, number>
  /** The lanes a process works in now. */
  readonly held: Set<string>
  /** The default branch's first-parent commit times (epoch ms), newest first. */
  readonly lands: Array<number>
  /** What `work --json list -status` says of each lane, by path; none when the installed `work` does not say it. */
  readonly statuses: Map<string, LaneStatus>
}

export const world = (): World => ({ heads: new Map(), touched: new Map(), held: new Set(), lands: [], statuses: new Map() })

const LANDED: HeadSeen = { onMain: OnMain.cases.Landed.make({}), at: Option.none() }

export const layer = (state: World) =>
  Layer.succeed(
    WorkGit,
    WorkGit.of({
      heads: (_repo, _main, wanted) => Effect.sync(() => new Map(wanted.map(({ head }) => [head, Option.getOrElse(Option.fromUndefinedOr(state.heads.get(head)), () => LANDED)] as const))),
      touchedAt: (lane) => Effect.sync(() => Option.fromUndefinedOr(state.touched.get(lane))),
      held: (lanes) => Effect.sync(() => new Set(lanes.filter((lane) => state.held.has(lane)))),
      lands: (_repo, _main, limit) => Effect.sync(() => state.lands.slice(0, limit)),
      statuses: () => Effect.sync(() => new Map(state.statuses)),
    }),
  )
