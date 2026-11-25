// Proposed automatic reset decisions; snapshots are provider readings, not predicted demand.
module resetPolicy {
  const EARLY: bool
  const WRONG_FABLE: bool
  const FREE_CODEX: bool
  const PERIOD_CAP: bool
  type Reading = {kind: str, week: int, fable: int, fableShared: int,
    weekLeft: int, expires: int, credits: int, work: bool, pending: bool, spent: int}
  type State = {r: Reading, claim: bool, afterWeek: int, afterFable: int, afterLeft: int}
  var s: State
  pure def depleted(r: Reading): bool =
    if (r.kind == "fable") r.fable == 100 or (r.week >= 99 and r.fableShared > 0)
    else r.week >= 99
  pure def restore(r: Reading): int = if (r.kind == "fable") (if (r.fable > r.fableShared) r.fable else r.fableShared) else r.week
  pure def expiring(r: Reading): bool = r.expires <= 1440 and (depleted(r) or r.expires <= 360) and restore(r) > 0
  pure def valuable(r: Reading): bool = and {
    r.credits > 0, not(r.pending), r.weekLeft > 30,
    expiring(r) or (r.work and depleted(r) and restore(r) > 0 and (r.kind != "fable" or r.week - r.fableShared < 99)),
  }
  pure def decide(r: Reading): bool =
    (valuable(r) or (EARLY and r.work and r.week >= 85 and r.credits > 0 and not(r.pending)))
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
    nondet work = Set(false, true).oneOf()
    nondet pending = Set(false, true).oneOf()
    nondet spent = Set(0, 1).oneOf()
    all { part <= week,
      s' = snapshot({kind: kind, week: week, fable: fable, fableShared: part,
        weekLeft: left, expires: expires, credits: credits, work: work, pending: pending, spent: spent}) }
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
  import resetPolicy(EARLY = false, WRONG_FABLE = false, FREE_CODEX = false, PERIOD_CAP = false).* from "reset-policy"
}
module early_claim {
  import resetPolicy(EARLY = true, WRONG_FABLE = false, FREE_CODEX = false, PERIOD_CAP = false).* from "reset-policy"
}
module wrong_fable {
  import resetPolicy(EARLY = false, WRONG_FABLE = true, FREE_CODEX = false, PERIOD_CAP = false).* from "reset-policy"
}
module free_codex {
  import resetPolicy(EARLY = false, WRONG_FABLE = false, FREE_CODEX = true, PERIOD_CAP = false).* from "reset-policy"
}
module period_cap {
  import resetPolicy(EARLY = false, WRONG_FABLE = false, FREE_CODEX = false, PERIOD_CAP = true).* from "reset-policy"
}
