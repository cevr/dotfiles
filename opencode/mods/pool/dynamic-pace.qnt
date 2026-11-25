// Ordinary weekly admission in pace.ts: budgetPace -> dispatchPace -> eligible.
// One quota unit is 1/16800 of a week; time is hours. 99% / 168h is 99
// units/hour, with 840 units (5 percentage points) of launch leeway.
// Two accounts expose interference; dynamic-pace.test.ts also covers seven.
// Each transition is a new admission snapshot, not an atomic provider send.
module dynamicPace {
  const POOLED_DEBT: bool
  const ALL_OPEN: bool
  const FREE_STARTS: bool
  const IGNORE_LIMITS: bool

  type Account = {used: int, left: int, fresh: bool, held: bool, shortOpen: bool, modelOpen: bool}
  type State = {a: Account, b: Account, charged: int, eligible: Set[int]}
  var s: State
  val ids = Set(0, 1)
  val target = 16632
  val week = 168
  val leeway = 840
  pure def line(a: Account): int = (168 - a.left) * 99 + 840
  pure def open(a: Account): bool = and {
    a.fresh, not(a.held), a.shortOpen, a.modelOpen, a.left > 0, a.used < 16632,
  }
  pure def ready(a: Account): bool = open(a) and a.used <= line(a)
  pure def room(a: Account): int = if (ready(a)) line(a) - a.used else 0
  pure def at(a: Account, b: Account, id: int): Account = if (id == 0) a else b
  pure def offered(a: Account, b: Account): Set[int] =
    ids.filter(id => if (IGNORE_LIMITS) at(a, b, id).used <= line(at(a, b, id))
      else if (ALL_OPEN) open(at(a, b, id)) else ready(at(a, b, id)))
  pure def decision(a: Account, b: Account, charged: int): Set[int] = {
    val choices = offered(a, b)
    val fits = if (POOLED_DEBT)
      (if (a.fresh and a.left > 0) a.used else 0) + (if (b.fresh and b.left > 0) b.used else 0) + charged
        <= (if (a.fresh and a.left > 0) line(a) else 0) + (if (b.fresh and b.left > 0) line(b) else 0)
      else room(a) + room(b) >= (if (FREE_STARTS) 0 else charged)
    if (choices != Set() and fits) choices else Set()
  }
  pure def snapshot(a: Account, b: Account, charged: int): State =
    {a: a, b: b, charged: charged, eligible: decision(a, b, charged)}
  pure def single(a: Account, charged: int): bool = ready(a) and room(a) >= charged
  pure def valid(a: Account): bool = a.used >= 0 and a.used <= 16800 and a.left >= 0 and a.left <= 168
  pure def advance(a: Account): Account = {...a, left: if (a.left > 0) a.left - 1 else 0}

  action init = {
    nondet aUse = Set(0, 840, 841, 8316, 9156, 9157, 15792, 16631, 16632, 16800).oneOf()
    nondet bUse = Set(0, 840, 841, 8316, 9156, 9157, 15792, 16631, 16632, 16800).oneOf()
    nondet aLeft = Set(0, 1, 8, 24, 84, 160, 168).oneOf()
    nondet bLeft = Set(0, 1, 8, 24, 84, 160, 168).oneOf()
    nondet aFresh = Set(false, true).oneOf()
    nondet bFresh = Set(false, true).oneOf()
    nondet aHeld = Set(false, true).oneOf()
    nondet bHeld = Set(false, true).oneOf()
    nondet aShort = Set(false, true).oneOf()
    nondet bShort = Set(false, true).oneOf()
    nondet aModel = Set(false, true).oneOf()
    nondet bModel = Set(false, true).oneOf()
    nondet charged = Set(0, 84, 840, 1680).oneOf()
    s' = snapshot(
      {used: aUse, left: aLeft, fresh: aFresh, held: aHeld, shortOpen: aShort, modelOpen: aModel},
      {used: bUse, left: bLeft, fresh: bFresh, held: bHeld, shortOpen: bShort, modelOpen: bModel}, charged)
  }
  action tick = s' = snapshot(advance(s.a), advance(s.b), s.charged)
  action observe = {
    nondet id = ids.oneOf()
    nondet used = Set(0, 840, 841, 8316, 9156, 9157, 15792, 16631, 16632, 16800).oneOf()
    nondet fresh = Set(false, true).oneOf()
    nondet held = Set(false, true).oneOf()
    nondet shortOpen = Set(false, true).oneOf()
    nondet modelOpen = Set(false, true).oneOf()
    val updated = {...at(s.a, s.b, id), used: used, fresh: fresh, held: held, shortOpen: shortOpen, modelOpen: modelOpen}
    s' = if (id == 0) snapshot(updated, s.b, s.charged) else snapshot(s.a, updated, s.charged)
  }
  // A natural reset needs an observed new week; elapsed time alone creates no room.
  action reset = {
    nondet id = ids.oneOf()
    val old = at(s.a, s.b, id)
    val updated = {...old, used: 0, left: 168, fresh: true, held: false}
    all { old.left == 0,
      s' = if (id == 0) snapshot(updated, s.b, s.charged) else snapshot(s.a, updated, s.charged) }
  }
  action start = all { s.eligible != Set(), s.charged < 1680,
    s' = snapshot(s.a, s.b, s.charged + 84) }
  action settle = all { s.charged >= 84, s' = snapshot(s.a, s.b, s.charged - 84) }
  action step = any { tick, observe, reset, start, settle, s' = s }

  val healthy = {used: 0, left: 168, fresh: true, held: false, shortOpen: true, modelOpen: true}
  action initWitness = s' = snapshot(healthy, {...healthy, used: 15792, left: 72}, 0)
  action initFleet = s' = snapshot({...healthy, used: 9072, left: 84}, {...healthy, used: 9072, left: 84}, 168)
  action initRollover = s' = snapshot({...healthy, used: 16631, left: 1}, {...healthy, held: true}, 0)

  // Another account's use or unavailability cannot cancel a solo admission.
  val noForeignDebt = ids.forall(id => single(at(s.a, s.b, id), s.charged) implies s.eligible.contains(id))
  val ownCycle = s.eligible.forall(id => ready(at(s.a, s.b, id)))
  val fleetCharged = s.eligible == Set() or room(s.a) + room(s.b) >= s.charged
  val oneAvailable = if (open(s.a) and not(open(s.b)))
    (s.eligible.contains(0) == single(s.a, s.charged))
    else if (open(s.b) and not(open(s.a))) (s.eligible.contains(1) == single(s.b, s.charged)) else true
  // With demand and no unsettled starts, the final eight hours permit the
  // account to reach 99%. This is admission availability, not a promise of work.
  val finishCycle = ids.forall(id => {
    val a = at(s.a, s.b, id)
    open(a) and a.left <= 8 and s.charged == 0 implies s.eligible.contains(id)
  })
  val safe = valid(s.a) and valid(s.b) and s.charged >= 0 and s.charged <= 1764
    and noForeignDebt and ownCycle and fleetCharged and oneAvailable and finishCycle
}

module dynamic_pace {
  import dynamicPace(POOLED_DEBT = false, ALL_OPEN = false, FREE_STARTS = false, IGNORE_LIMITS = false).* from "dynamic-pace"
}
module pooled_debt {
  import dynamicPace(POOLED_DEBT = true, ALL_OPEN = false, FREE_STARTS = false, IGNORE_LIMITS = false).* from "dynamic-pace"
}
module unpaced_placement {
  import dynamicPace(POOLED_DEBT = false, ALL_OPEN = true, FREE_STARTS = false, IGNORE_LIMITS = false).* from "dynamic-pace"
}
module free_starts {
  import dynamicPace(POOLED_DEBT = false, ALL_OPEN = false, FREE_STARTS = true, IGNORE_LIMITS = false).* from "dynamic-pace"
}
module ignored_limits {
  import dynamicPace(POOLED_DEBT = false, ALL_OPEN = false, FREE_STARTS = false, IGNORE_LIMITS = true).* from "dynamic-pace"
}
