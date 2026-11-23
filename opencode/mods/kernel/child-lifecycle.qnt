module childLifecycle {
  type Phase = Held | Active | Background | Recovering | Unknown | Settled
  type Route = None | Primary | Secondary
  type End = NoEnd | Ok | Failed | Cancelled
  var s: {
    phase: Phase, generation: int, route: Route, compatible: bool, room: bool,
    refused: bool, sawNotice: bool, deniedThenStarted: bool, incompatibleStarted: bool,
    end: End, handBack: bool, closedRound: bool, delivered: int, seen: int,
    seq: int, stepError: bool, pendingShell: bool
  }

  action init = s' = {
    phase: Held, generation: 1, route: None, compatible: false, room: false,
    refused: false, sawNotice: false, deniedThenStarted: false, incompatibleStarted: false,
    end: NoEnd, handBack: false, closedRound: false, delivered: 0, seen: 1,
    seq: 0, stepError: false, pendingShell: false
  }

  action readCatalog = {
    nondet v = oneOf(Set(false, true))
    s' = { ...s, compatible: v }
  }
  action readPace = {
    nondet v = oneOf(Set(false, true))
    s' = { ...s, room: v }
  }
  action admit = all {
    s.phase == Held, not(s.refused), or { s.room, s.compatible },
    s' = { ...s, phase: Active, route: if (s.room) Primary else Secondary, seq: s.seq + 1 }
  }
  action notice = all {
    or { s.phase == Active, s.phase == Recovering, s.phase == Background },
    s' = { ...s, sawNotice: true }
  }
  action stopAuthorization = all {
    or { s.phase == Active, s.phase == Recovering },
    s' = { ...s, refused: true }
  }
  action shutdown = all {
    s.phase == Active,
    s' = { ...s, phase: Recovering }
  }
  action resume = all {
    s.phase == Recovering, not(s.refused),
    s' = { ...s, phase: Active, seq: s.seq + 1 }
  }
  action shellPending = all {
    s.phase == Active,
    s' = { ...s, pendingShell: true }
  }
  action stepFails = all {
    s.phase == Active, s.pendingShell,
    s' = { ...s, stepError: true, phase: Background }
  }
  action shellAwakensSameChild = all {
    s.phase == Background, s.pendingShell, not(s.refused),
    s' = { ...s, pendingShell: false, phase: Active, seq: s.seq + 1 }
  }
  action stopTimesOut = all {
    or { s.phase == Active, s.phase == Background, s.phase == Recovering },
    s' = { ...s, pendingShell: false, phase: Unknown }
  }
  action settle = all {
    or { s.phase == Active, s.phase == Recovering, s.phase == Unknown },
    not(s.pendingShell),
    nondet e = oneOf(Set(Ok, Failed, Cancelled))
    s' = { ...s, phase: Settled, end: e, seq: s.seq + 1 }
  }
  action handBack = all {
    s.phase == Settled, s.end == Ok, not(s.refused),
    s' = { ...s, handBack: true, closedRound: true }
  }
  action deliver = all {
    s.phase == Settled, s.delivered == 0,
    s' = { ...s, delivered: 1 }
  }
  // Replacement after settlement, independently assigned and not a retry of denied work.
  action nextGeneration = all {
    s.phase == Settled, s.generation == 1, not(s.refused),
    s' = { ...s, generation: 2, route: None, phase: Held, end: NoEnd,
      handBack: false, closedRound: false, delivered: 0, sawNotice: false, stepError: false }
  }
  action staleObservation = all {
    s.generation == 2,
    s' = s
  }
  action readLatest = all {
    s' = { ...s, seen: s.generation }
  }
  action step = any {
    readCatalog, readPace, admit, notice, stopAuthorization, shutdown, resume,
    shellPending, stepFails, shellAwakensSameChild, stopTimesOut,
    settle, handBack, deliver, nextGeneration, staleObservation, readLatest
  }
  action noticeCloses = any {
    step,
    all { s.sawNotice, s.phase == Active, s' = { ...s, closedRound: true } }
  }
  action retryDenied = any {
    step,
    all { s.refused, s' = { ...s, phase: Active, route: Secondary, deniedThenStarted: true } }
  }
  action admitIncompatible = any {
    step,
    all { s.phase == Held, not(s.room), not(s.compatible),
      s' = { ...s, phase: Active, route: Secondary, incompatibleStarted: true } }
  }
  action staleWins = any {
    step,
    all { s.generation == 2, s.seen == 2, s' = { ...s, seen: 0 } }
  }
  val safe = and {
    not(s.closedRound) or (s.phase == Settled and s.end == Ok and s.handBack and not(s.refused)),
    s.delivered <= 1,
    s.delivered == 0 or s.phase == Settled,
    not(s.deniedThenStarted),
    not(s.incompatibleStarted),
    s.seen >= s.generation - 1,
    s.phase != Settled or (s.end != NoEnd and not(s.pendingShell)),
    s.phase != Background or (s.stepError and s.pendingShell),
  }
}
