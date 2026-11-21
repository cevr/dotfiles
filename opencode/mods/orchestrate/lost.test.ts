// What status says of finished work that never reached the default branch (lost.ts), on a manual clock: the four
// ways an Ergo run lost 17 ready hand-backs (made-up names and hashes, the shapes real), the threshold's two edges
// (time and lands since), a verifier still to answer, and the lane-first rule's legs (a process, a session, recent
// activity, something waiting), each of which alone keeps a lane off the list.
import { describe, expect, test } from "bun:test"
import { Option } from "effect"
import { IDLE_MS, LANDS_PAST, LISTED, type LaneSeen, LOST_FIX, lostLanes, lostText, OnMain, readyNotLanded, type UnitSeen, Verifier } from "./lost.ts"

const NOW = Date.UTC(2026, 10, 21, 12)
const HOUR = 3_600_000
const DAY = 24 * HOUR

const absent = (missing: ReadonlyArray<string>, subject: string, below: ReadonlyArray<string> = []) => OnMain.cases.Absent.make({ missing: [...missing], own: [...missing, ...below], subject })

/** A clean lane at `path` on `head`, last active `ago` ms before NOW, nobody on it. */
const lane = (path: string, head: string, onMain: OnMain, ago: number, more: Partial<LaneSeen> = {}): LaneSeen => ({
  lane: { path, branch: `feat/${path.split("/").at(-1) ?? ""}`, head, state: "clean" },
  head: { onMain, at: Option.some(NOW - ago) },
  activeAt: NOW - ago,
  held: false,
  sessions: [],
  waited: Option.none(),
  ...more,
})

/** A unit handed back ready at `head`, its request written `ago` ms before NOW. */
const unit = (name: string, head: string, onMain: OnMain, ago: number, more: Partial<UnitSeen> = {}): UnitSeen => ({
  unit: name,
  dir: `/run/${name}`,
  round: 1,
  head,
  requestAt: NOW - ago,
  onMain,
  lane: Option.some(`/code/.work/app/${name}`),
  verifier: Verifier.cases.None.make({}),
  ...more,
})

describe("the four ways ready work was lost", () => {
  test("1. routed to an integrator who compacted before it merged: ready, not landed, 7 d", () => {
    const alpha = unit("unit-alpha", "a1a1a1a1a1a1", absent(["a1a1a1a1a1a1", "a2", "a3"], "alpha three"), 7 * DAY)
    expect(readyNotLanded([alpha], [], [], NOW)).toEqual(["orchestrate: ready, not landed (1, oldest first):", "- ready, not landed 7 d: unit-alpha a1a1a1a1a /code/.work/app/unit-alpha"])
  })

  test("2. superseded by later work while the unit still says ready: flagged until its log ends it", () => {
    const beta = unit("unit-beta", "b1b1b1b1b", absent(["b1b1b1b1b", "b2"], "beta readouts"), 3 * DAY)
    expect(readyNotLanded([beta], [], [], NOW)).toEqual([expect.stringContaining(""), "- ready, not landed 3 d: unit-beta b1b1b1b1b /code/.work/app/unit-beta"])
    // `dropped r1 superseded-by <hash>` closes the unit: the run tables no longer show it ready, and it is never asked about.
    expect(readyNotLanded([], [], [], NOW)).toEqual([])
  })

  test("3a. landed under another hash (patch-equivalent on main): not lost", () => {
    const gamma = unit("unit-gamma", "c1c1c1c1c", OnMain.cases.Equivalent.make({}), 5 * DAY)
    expect(lostText([gamma], [lane("/code/.work/app/unit-gamma", "c1c1c1c1c", OnMain.cases.Equivalent.make({}), 5 * DAY)], [], NOW)).toEqual([])
  })

  test("3b. riding in another lane's unlanded stack: not landed, carried by that lane", () => {
    const gamma = unit("unit-gamma", "c1c1c1c1c", absent(["c1c1c1c1c"], "gamma"), 5 * DAY)
    const carrier = lane("/code/.work/app/other-lane", "d5d5d5d5d", absent(["d5d5d5d5d", "d4", "d3", "d2", "d1"], "other five", ["c1c1c1c1c"]), 1 * HOUR, {
      sessions: [{ id: "ses_other", busy: true, idleSince: Option.none() }],
    })
    expect(readyNotLanded([gamma], [carrier], [], NOW)[1]).toBe("- ready, not landed 5 d: unit-gamma c1c1c1c1c /code/.work/app/unit-gamma · carried by /code/.work/app/other-lane")
  })

  test("4. dropped when a checked group was rebuilt after main moved: two lands since, though only an hour old", () => {
    const member = unit("unit-delta", "e1e1e1e1e", absent(["e1e1e1e1e"], "delta"), HOUR)
    expect(readyNotLanded([member], [], [NOW - 30 * 60_000], NOW)).toEqual([])
    expect(readyNotLanded([member], [], [NOW - 20 * 60_000, NOW - 30 * 60_000], NOW)[1]).toBe("- ready, not landed 60 min: unit-delta e1e1e1e1e /code/.work/app/unit-delta")
    expect(LANDS_PAST).toBe(2)
  })
})

describe("the unit-first rule", () => {
  test("waits out the threshold to the millisecond, from the request or from the verdict", () => {
    const fresh = unit("fresh", "f1f1f1f1f", absent(["f1f1f1f1f"], "fresh"), IDLE_MS - 1)
    expect(readyNotLanded([fresh], [], [], NOW)).toEqual([])
    expect(readyNotLanded([{ ...fresh, requestAt: NOW - IDLE_MS }], [], [], NOW)).toHaveLength(2)
    const verdict = Verifier.cases.Answered.make({ verdict: "accepted", at: NOW - HOUR })
    expect(readyNotLanded([{ ...fresh, requestAt: NOW - 3 * DAY, verifier: verdict }], [], [], NOW)).toEqual([])
  })

  test("a deep unit waiting for its verifier is named with it, not lost; a changes verdict waits for its next round", () => {
    const deep = unit("deep", "a9a9a9a9a", absent(["a9a9a9a9a"], "deep"), 2 * DAY, { verifier: Verifier.cases.Pending.make({}) })
    expect(lostText([deep], [], [], NOW)).toEqual(["orchestrate: ready, not landed (1, oldest first):", "- ready, with its verifier: deep a9a9a9a9a /code/.work/app/deep"])
    const changes = { ...deep, verifier: Verifier.cases.Answered.make({ verdict: "changes", at: NOW - 2 * DAY }) }
    expect(lostText([changes], [], [], NOW)).toEqual([])
  })

  test("its lane removed: lane gone, and a head no checkout holds is said so rather than guessed", () => {
    const gone = unit("gone", "0badc0de0", OnMain.cases.Unknown.make({}), 2 * DAY, { lane: Option.none() })
    expect(readyNotLanded([gone], [], [], NOW)[1]).toBe("- ready, not landed 2 d: gone 0badc0de0 lane gone · head not in this repository")
  })
})

describe("the lane-first rule", () => {
  const old = (path: string, more: Partial<LaneSeen> = {}) => lane(path, `${path.length}abc`, absent([`${path.length}abc`, "x"], "last subject"), 2 * DAY, more)

  test("a lane with commits not on main that nobody is on is listed with its age, commits, subject and session", () => {
    const seen = old("/code/.work/app/orphan", { sessions: [{ id: "ses_made", busy: false, idleSince: Option.some(NOW - 2 * DAY) }] })
    expect(lostLanes([seen], NOW)).toEqual([
      "orchestrate: committed work not on main, nobody on it (1, oldest first):",
      "- /code/.work/app/orphan · 2 d · 2 commits · last subject · session ses_made",
    ])
  })

  test("each leg alone keeps a lane off: a process in it, a session at work or idle within the threshold, recent activity, something waiting", () => {
    const kept: ReadonlyArray<LaneSeen> = [
      old("/code/.work/app/a", { held: true }),
      old("/code/.work/app/b", { sessions: [{ id: "ses_b", busy: true, idleSince: Option.none() }] }),
      old("/code/.work/app/c", { sessions: [{ id: "ses_c", busy: false, idleSince: Option.some(NOW - HOUR) }] }),
      old("/code/.work/app/d", { activeAt: NOW - HOUR }),
      old("/code/.work/app/e", { waited: Option.some("unit e is in verify") }),
      lane("/code/.work/app/f", "f", OnMain.cases.Equivalent.make({}), 2 * DAY),
      old("/code/.work/app/verify-batch-1"),
      old("/code/.work/app/integrate"),
    ]
    expect(lostLanes(kept, NOW)).toEqual([])
  })

  test("dirty lanes nobody is on are the second list; oldest first; capped at LISTED with the rest counted", () => {
    const dirty = lane("/code/.work/app/dirty", "d", OnMain.cases.Landed.make({}), 3 * DAY)
    const lines = lostLanes([{ ...dirty, lane: { ...dirty.lane, state: "2 uncommitted" } }], NOW)
    expect(lines).toEqual(["orchestrate: uncommitted work, nobody on it (1, oldest first):", "- /code/.work/app/dirty · 3 d · 2 uncommitted · no session known"])
    const many = Array.from({ length: LISTED + 2 }, (_, n) => old(`/code/.work/app/l${n}`, { activeAt: NOW - (n + 1) * DAY }))
    const listed = lostLanes(many, NOW)
    expect([listed.length, listed[1], listed.at(-1)]).toEqual([LISTED + 2, expect.stringContaining(`/l${LISTED + 1} · ${LISTED + 2} d`), "- and 2 more"])
  })

  test("a lane the unit-first list names is not named again, and the fix follows any loss", () => {
    const alpha = unit("unit-alpha", "a1", absent(["a1"], "alpha"), 7 * DAY)
    const text = lostText([alpha], [lane("/code/.work/app/unit-alpha", "a1", absent(["a1"], "alpha"), 7 * DAY)], [], NOW)
    expect(text).toEqual(["orchestrate: ready, not landed (1, oldest first):", "- ready, not landed 7 d: unit-alpha a1 /code/.work/app/unit-alpha", LOST_FIX])
  })
})
