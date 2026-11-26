// Proposed automatic reset decisions; snapshots are provider readings, not predicted demand.
module resetPolicy {
  const EARLY: bool
  const WRONG_FABLE: bool
  const FREE_CODEX: bool
  const PERIOD_CAP: bool
  // Room read off a login's reading alone, whatever refuses it or however old the reading is (the B1 fault).
  const ROOM_ON_READING: bool
  // Running work refills while another login has room (no work waits: the q223 fault).
  const ROOM_BLIND: bool
  // running: agents run on the pool; held: work is held for want of a login, a start or a running agent's request.
  // other: the pool's other login, as placement sees it: none, room (it takes work now), signin (refused),
  // stale (its reading past the 30-minute bound). Only "room" is room.
  type Reading = {kind: str, week: int, fable: int, fableShared: int,
    weekLeft: int, expires: int, credits: int, running: bool, held: bool, other: str, pending: bool, spent: int}
  type State = {r: Reading, claim: bool, afterWeek: int, afterFable: int, afterLeft: int}
  var s: State
  pure def depleted(r: Reading): bool =
    if (r.kind == "fable") r.fable == 100 or (r.week >= 99 and r.fableShared > 0)
    else r.week >= 99
  pure def restore(r: Reading): int = if (r.kind == "fable") (if (r.fable > r.fableShared) r.fable else r.fableShared) else r.week
  pure def expiring(r: Reading): bool = r.expires <= 1440 and (depleted(r) or r.expires <= 360) and restore(r) > 0
  pure def working(r: Reading): bool = r.running or r.held
  // Work waits when some is held, or when agents run and no other login takes work (room).
  pure def waitsWith(r: Reading, room: bool): bool = r.held or (r.running and not(room))
  pure def valuableWith(r: Reading, room: bool): bool = and {
    r.credits > 0, not(r.pending), r.weekLeft > 30,
    expiring(r) or (waitsWith(r, room) and depleted(r) and restore(r) > 0 and (r.kind != "fable" or r.week - r.fableShared < 99)),
  }
  pure def valuable(r: Reading): bool = valuableWith(r, r.other == "room")
  // The room the policy under check reads.
  pure def roomSeen(r: Reading): bool =
    if (ROOM_BLIND) false else if (ROOM_ON_READING) r.other != "none" else r.other == "room"
  pure def decide(r: Reading): bool =
    (valuableWith(r, roomSeen(r)) or (EARLY and working(r) and r.week >= 85 and r.credits > 0 and not(r.pending)))
      and (not(PERIOD_CAP) or r.spent == 0)
  pure def snapshot(r: Reading): State = {
    val claim = decide(r)
    {r: r, claim: claim,
      afterWeek: if (not(claim)) r.week else if (r.kind == "fable")
        (if (WRONG_FABLE) 0 else r.week - r.fableShared) else 0,
      afterFable: if (claim and r.kind.in(Set("fable", "codex"))) 0 else r.fable,
      afterLeft: if (claim and r.kind == "codex" and not(FREE_CODEX)) 10080 else r.weekLeft}
  }
  action init = {
    nondet kind = Set("full", "fable", "codex").oneOf()
    nondet week = Set(0, 60, 85, 98, 99, 100).oneOf()
    nondet fable = Set(0, 60, 100).oneOf()
    nondet part = Set(0, 10, 30, 50, 60).oneOf()
    nondet left = Set(15, 30, 31, 60, 720, 1440, 1441, 10080).oneOf()
    nondet expires = Set(60, 360, 1440, 1441, 50000).oneOf()
    nondet credits = Set(0, 1, 2).oneOf()
    nondet running = Set(false, true).oneOf()
    nondet held = Set(false, true).oneOf()
    nondet other = Set("none", "room", "signin", "stale").oneOf()
    nondet pending = Set(false, true).oneOf()
    nondet spent = Set(0, 1).oneOf()
    all { part <= week,
      s' = snapshot({kind: kind, week: week, fable: fable, fableShared: part,
        weekLeft: left, expires: expires, credits: credits, running: running, held: held, other: other,
        pending: pending, spent: spent}) }
  }
  // A spent account with an ordinary reset in hand, agents running, nothing held, beside another login of
  // each kind: left alone for room, refilled beside a refused or stale login (traces replayed against hasRoom).
  action initRoom = {
    nondet other = Set("room", "signin", "stale").oneOf()
    nondet week = Set(99, 100).oneOf()
    nondet left = Set(720, 10080).oneOf()
    s' = snapshot({kind: "full", week: week, fable: 0, fableShared: 0, weekLeft: left, expires: 50000, credits: 1,
      running: true, held: false, other: other, pending: false, spent: 0})
  }
  action tick = all {s.r.weekLeft > 0, s.r.expires > 1,
    s' = snapshot({...s.r, weekLeft: s.r.weekLeft - 1, expires: s.r.expires - 1})}
  // Confirmed success consumes one credit. Subsequent measured work can exhaust it again.
  action redeem = all {s.claim,
    s' = snapshot({...s.r, week: s.afterWeek, fable: s.afterFable,
      fableShared: 0, weekLeft: s.afterLeft, credits: s.r.credits - 1, spent: s.r.spent + 1})}
  action consume = all {s.r.credits > 0, not(s.r.pending),
    s' = snapshot({...s.r, week: 100, fable: 100, fableShared: 50})}
  action step = any {tick, redeem, consume, s' = s}
  val noForecastClaim = s.claim implies valuable(s.r)
  val noMissedReset = valuable(s.r) implies s.claim
  val fableSubtractsOwn = (s.claim and s.r.kind == "fable") implies
    (s.afterWeek == s.r.week - s.r.fableShared and s.afterFable == 0 and s.afterLeft == s.r.weekLeft)
  val cadence = (s.claim and s.r.kind == "codex") implies s.afterLeft == 10080
  val safe = noForecastClaim and noMissedReset and fableSubtractsOwn and cadence
}
module reset_policy {
  import resetPolicy(EARLY = false, WRONG_FABLE = false, FREE_CODEX = false, PERIOD_CAP = false, ROOM_ON_READING = false, ROOM_BLIND = false).* from "reset-policy"
}
module early_claim {
  import resetPolicy(EARLY = true, WRONG_FABLE = false, FREE_CODEX = false, PERIOD_CAP = false, ROOM_ON_READING = false, ROOM_BLIND = false).* from "reset-policy"
}
module wrong_fable {
  import resetPolicy(EARLY = false, WRONG_FABLE = true, FREE_CODEX = false, PERIOD_CAP = false, ROOM_ON_READING = false, ROOM_BLIND = false).* from "reset-policy"
}
module free_codex {
  import resetPolicy(EARLY = false, WRONG_FABLE = false, FREE_CODEX = true, PERIOD_CAP = false, ROOM_ON_READING = false, ROOM_BLIND = false).* from "reset-policy"
}
module period_cap {
  import resetPolicy(EARLY = false, WRONG_FABLE = false, FREE_CODEX = false, PERIOD_CAP = true, ROOM_ON_READING = false, ROOM_BLIND = false).* from "reset-policy"
}
module room_on_reading {
  import resetPolicy(EARLY = false, WRONG_FABLE = false, FREE_CODEX = false, PERIOD_CAP = false, ROOM_ON_READING = true, ROOM_BLIND = false).* from "reset-policy"
}
module room_blind {
  import resetPolicy(EARLY = false, WRONG_FABLE = false, FREE_CODEX = false, PERIOD_CAP = false, ROOM_ON_READING = false, ROOM_BLIND = true).* from "reset-policy"
}
