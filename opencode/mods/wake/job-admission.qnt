module jobAdmission {
  // Bounded CPU / protected-supply, tenant, device, boot and generation model.
  // The separate runnable tests exercise volume bytes, liveness and replay.
  type Lease = {phase: str, gen: int, until: int, live: bool}
  type State = {now: int, tier: int, outside: int, disk: bool,
    a: Lease, b: Lease, other: Lease, starts: int, badStart: bool,
    waiting: bool, letter: str, wakes: int, ack: bool}
  var s: State
  val newLease = {phase: "none", gen: 0, until: 0, live: false}
  action init = {
    nondet tier = Set(3, 4).oneOf()
    s' = {now: 0, tier: tier, outside: 0, disk: true, a: newLease, b: newLease,
      other: newLease, starts: 0, badStart: false,
      waiting: false, letter: "none", wakes: 0, ack: false}
  }
  pure def held(l: Lease): bool = l.phase.in(Set("reserved", "running", "draining"))
  pure def charge(l: Lease): int = if (held(l)) 1 else 0
  val used = charge(s.a) + charge(s.b) + charge(s.other)
  // Two protected core-equivalents, never allocated to these tenants.
  val canReserve = s.disk and used + s.outside + 2 < s.tier
  val canStart = s.disk and used + s.outside + 2 <= s.tier
  pure def queued(l: Lease): Lease = {...l, phase: "queued", gen: l.gen + 1}
  pure def grant(l: Lease, now: int): Lease = {...l, phase: "reserved", until: now + 1}
  pure def begin(l: Lease): Lease = {...l, phase: "running", live: true}
  pure def retired(l: Lease): Lease = {...l, phase: "done", live: false}
  action request = all { s.a.phase.in(Set("none", "done")), s' = {...s, a: queued(s.a)} }
  action requestOther = all { s.other.phase.in(Set("none", "done")), s' = {...s, other: queued(s.other)} }
  action grantA = all {
    s.a.phase == "queued", canReserve, not(held(s.b)),
    s' = {...s, a: grant(s.a, s.now)}
  }
  action grantOther = all { s.other.phase == "queued", canReserve, s' = {...s, other: grant(s.other, s.now)} }
  // B requests the same device as A; other requests a disjoint one.
  action b = if (held(s.b)) s' = {...s, b: retired(s.b)}
    else all { not(held(s.a)), canReserve, s' = {...s, b: begin(s.b)} }
  action startA = {
    nondet gen = Set(s.a.gen, s.a.gen + 1).oneOf()
    all { s.a.phase == "reserved", gen == s.a.gen, s.now < s.a.until, canStart,
      s' = {...s, a: begin(s.a), starts: s.starts + 1} }
  }
  action startOther = all {
    s.other.phase == "reserved", s.now < s.other.until, canStart,
    s' = {...s, other: begin(s.other)}
  }
  action finish = {
    nondet gen = Set(s.a.gen, s.a.gen + 1).oneOf()
    all { s.a.phase == "running", gen == s.a.gen, s' = {...s, a: retired(s.a), letter: "owed"} }
  }
  action expire = any {
    all { s.a.phase == "running", s.now >= s.a.until, s' = {...s, a: {...s.a, phase: "draining"}} },
    all { s.a.phase == "reserved", s.now >= s.a.until, s' = {...s, a: retired(s.a), letter: "owed"} },
    all { held(s.other), s.now >= s.other.until, not(s.other.live), s' = {...s, other: retired(s.other)} },
  }
  action proveExited = all { s.a.phase == "draining", s' = {...s, a: {...s.a, live: false}} }
  action reap = all { s.a.phase == "draining", not(s.a.live), s' = {...s, a: retired(s.a), letter: "owed"} }
  action finishOther = all { s.other.phase == "running", s' = {...s, other: retired(s.other)} }
  action pressure = {
    nondet demand = Set(0, 1, 2).oneOf()
    s' = {...s, outside: demand}
  }
  action disk = s' = {...s, disk: not(s.disk)}
  action tick = all { s.now < 3, s' = {...s, now: s.now + 1} }
  action park = all { s.letter == "none", not(s.waiting), s' = {...s, waiting: true} }
  action deliver = all { s.letter == "owed", s.wakes == 0,
    s' = {...s, letter: "delivered", wakes: 1, waiting: false} }
  action ack = all { s.letter == "delivered", not(s.ack), s' = {...s, ack: true} }
  action step = any {
    request, requestOther, grantA, grantOther, b, startA, startOther, finish,
    expire, proveExited, reap, finishOther, pressure, disk, tick, park, deliver, ack, s' = s,
  }
  action duplicate = any {
    step,
    all { s.letter == "delivered", not(s.ack), s' = {...s, wakes: s.wakes + 1} },
  }
  action staleSnapshot = any {
    step,
    all { s.letter == "delivered", s' = {...s, waiting: true} },
  }
  action belowFloor = any {
    step,
    all { s.a.phase == "reserved", not(s.disk), s' = {...s, a: begin(s.a), badStart: true} },
  }
  action expiredLive = any {
    step,
    all { s.a.phase == "draining", s.a.live, s' = {...s, a: {...s.a, phase: "done"}} },
  }
  action staleGeneration = any {
    step,
    all { s.a.phase == "reserved", s.a.gen > 1, s' = {...s, a: begin(s.a), badStart: true} },
  }
  action ignoredDeadline = any {
    step,
    all { s.a.phase == "reserved", s.now >= s.a.until, s' = {...s, a: begin(s.a), badStart: true} },
  }
  action ignoredKey = any {
    step,
    all { held(s.a), not(held(s.b)), canReserve, s' = {...s, b: begin(s.b)} },
  }
  val safe = used + 2 <= s.tier and s.wakes <= 1 and not(s.badStart)
    and not(held(s.a) and held(s.b)) and (not(s.a.live) or held(s.a))
    and (s.letter != "delivered" or not(s.waiting))
    and (not(s.ack) or s.wakes == 1)
}

// Scripted kernel capability: fork/exec and process-group changes do not
// close copies. Observation, not signalling or PID lookup, frees capacity.
module descriptorProof {
  type Hold = {linux: bool, launcher: bool, watchdog: bool, group: bool, escaped: bool,
    escapedWork: bool, released: bool, foreignSignals: int, admittedAfterClose: bool}
  var h: Hold
  action init = {
    nondet linux = Set(true, false).oneOf()
    h' = {linux: linux, launcher: true, watchdog: not(linux), group: true, escaped: false,
      escapedWork: false, released: false, foreignSignals: 0, admittedAfterClose: false}
  }
  action duplicate = all { h.group, not(h.escaped), h' = {...h, escaped: true} }
  action setsid = all { h.group, not(h.escaped), h' = {...h, group: false, escaped: true} }
  action execOrReparent = all { h.group or h.escaped, h' = h }
  action loseLauncher = all { h.launcher, h' = {...h, launcher: false} }
  action loseWatchdog = all { h.watchdog, h' = {...h, watchdog: false} }
  action stopOwnGroup = all {
    h.group, not(h.linux), h.launcher or h.watchdog,
    h' = {...h, group: false}
  }
  action stopCgroup = all {
    h.linux, h.group or h.escaped or h.escapedWork,
    h' = {...h, group: false, escaped: false, escapedWork: false}
  }
  action closeAll = all { h.escaped, h' = {...h, escaped: false, escapedWork: true} }
  action exit = any {
    all { h.group, h' = {...h, group: false} },
    all { h.escaped, h' = {...h, escaped: false} },
    all { h.escapedWork, h' = {...h, escapedWork: false} },
  }
  val descriptorFree = not(h.group or h.escaped)
  val cgroupFree = descriptorFree and not(h.escapedWork)
  action release = all {
    not(h.released), descriptorFree, not(h.linux) or cgroupFree,
    h' = {...h, released: true}
  }
  // A holder that deliberately dropped all FDs is not an owned target on
  // Darwin. Its CPU remains ambient demand and closes the new-start policy.
  action startOther = all {
    h.released, not(h.escapedWork), h' = {...h, admittedAfterClose: true}
  }
  action step = any {
    duplicate, setsid, execOrReparent, loseLauncher, loseWatchdog,
    stopOwnGroup, stopCgroup, closeAll, exit, release, startOther, h' = h,
  }
  action pgidProof = any { step, all { not(h.group), h.escaped, h' = {...h, released: true} } }
  action stalePid = any { step, all { h.escaped, not(h.launcher), h' = {...h, foreignSignals: 1} } }
  action ignoreAmbient = any {
    step, all { h.escapedWork, h.released, h' = {...h, admittedAfterClose: true} },
  }
  val safe = (not(h.released) or (descriptorFree and (not(h.linux) or cgroupFree)))
    and h.foreignSignals == 0 and (not(h.admittedAfterClose) or not(h.escapedWork))
}

module frontierProof {
  // Whole-pool exclusivity needs half the managed pool available, not
  // zero ambient work. The two slots bound the FIFO witness: lower ambient
  // pressure to the floor, drain an older lease, and grant the waiter.
  type Request = {phase: str, ticket: int, realWidth: int, charge: int, exclusive: bool, feasible: bool}
  type Frontier = {a: Request, b: Request, pool: int, outside: int, next: int, bypassed: bool}
  var f: Frontier
  val empty = {phase: "none", ticket: 0, realWidth: 0, charge: 0, exclusive: false, feasible: false}
  pure def minimum(a: int, b: int): int = if (a < b) a else b
  pure def waiting(r: Request): bool = r.phase == "queued"
  pure def held(r: Request): bool = r.phase == "running"
  pure def done(r: Request): Request = {...r, phase: "done"}
  pure def running(r: Request): Request = {...r, phase: "running"}
  pure def ordered(r: Request, predecessor: Request): bool =
    not(waiting(predecessor)) or r.ticket < predecessor.ticket
  pure def used(r: Request): int = if (held(r)) r.charge else 0
  pure def grantable(r: Request, peer: Request, pool: int, cap: int): bool =
    waiting(r) and r.feasible and r.charge > 0 and ordered(r, peer)
      and (if (r.charge == pool) not(held(peer)) and 2 * cap >= pool
           else r.charge + used(peer) <= cap)
      and (not(held(peer)) or not(r.exclusive or peer.exclusive))
  pure def request(ticket: int, width: int, pool: int, feasible: bool, exclusive: bool): Request =
    {phase: if (feasible) "queued" else "refused", ticket: if (feasible) ticket else 0,
      realWidth: width, charge: minimum(pool, width), exclusive: exclusive, feasible: feasible}
  pure def eligible(r: Request, pool: int): bool =
    (r.phase != "refused" or r.ticket == 0)
      and (not(waiting(r) or held(r)) or (r.charge >= minimum(r.realWidth, pool) and r.charge <= pool and r.feasible))
  pure def hasWitness(r: Request, peer: Request, pool: int): bool =
    if (not(waiting(r))) true
    else if (waiting(peer) and peer.ticket < r.ticket)
      grantable(peer, r, pool, pool) and grantable(r, done(running(peer)), pool, pool)
    else grantable(r, done(peer), pool, pool)
  pure def atFloor(r: Request, pool: int): bool =
    not(waiting(r) and r.charge == pool) or grantable(r, empty, pool, pool - 1)
  action init = {
    nondet pool = Set(2, 3).oneOf()
    f' = {a: empty, b: empty, pool: pool, outside: 0, next: 1, bypassed: false}
  }
  action post = {
    nondet first = Set(true, false).oneOf()
    nondet packageOption = Set(0, 1, 4).oneOf()
    nondet runtimeOption = Set(0, 1, 4).oneOf()
    nondet unknown = Set(false, true).oneOf()
    nondet fits = Set(true, false).oneOf()
    nondet exclusive = Set(true, false).oneOf()
    val runtime = if (runtimeOption == 0) f.pool + 2 else runtimeOption
    val packages = if (packageOption == 0) runtime else packageOption
    val width = if (unknown) f.pool else packages * runtime
    val row = request(f.next, width, f.pool, fits, exclusive)
    val next = if (fits) f.next + 1 else f.next
    val previous = if (first) f.a else f.b
    all {
      not(waiting(previous) or held(previous)), f.next <= 4,
      if (first) f' = {...f, a: row, next: next}
      else f' = {...f, b: row, next: next},
    }
  }
  action pressure = {
    nondet outside = Set(0, 1, 2).oneOf()
    f' = {...f, outside: outside}
  }
  action step = any {
    post, pressure,
    all { grantable(f.a, f.b, f.pool, f.pool - f.outside), f' = {...f, a: running(f.a)} },
    all { grantable(f.b, f.a, f.pool, f.pool - f.outside), f' = {...f, b: running(f.b)} },
    all { held(f.a), f' = {...f, a: done(f.a)} },
    all { held(f.b), f' = {...f, b: done(f.b)} },
    f' = f,
  }
  action immortal = any { step, all {
    not(waiting(f.a) or held(f.a)),
    f' = {...f, a: {...request(f.next, 1, f.pool, false, false), phase: "queued"}},
  } }
  action collapsedFactors = any { step, all {
    not(waiting(f.a) or held(f.a)),
    f' = {...f, a: {...request(f.next, 16, f.pool, true, false), charge: 1}},
  } }
  action jumpedWaiter = any { step, all {
    waiting(f.a), waiting(f.b), f.a.ticket < f.b.ticket,
    f' = {...f, b: running(f.b), bypassed: true},
  } }
  val safe = eligible(f.a, f.pool) and eligible(f.b, f.pool)
    and hasWitness(f.a, f.b, f.pool) and hasWitness(f.b, f.a, f.pool)
    and atFloor(f.a, f.pool) and atFloor(f.b, f.pool)
    and used(f.a) + used(f.b) <= f.pool and not(f.bypassed)
    and (not(held(f.a) and held(f.b)) or not(f.a.exclusive or f.b.exclusive))
}
