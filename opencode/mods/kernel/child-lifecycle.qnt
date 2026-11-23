module childLifecycle {
  type Phase = Held | Active | ShellWork | ResultUndetermined | WakePending | Recovering | Unknown | Settled
  type Route = None | Primary | Secondary
  type End = NoEnd | Ok | Failed | Cancelled
  var s: {
    phase: Phase, generation: int, route: Route, compatible: bool, room: bool,
    refused: bool, sawNotice: bool, deniedThenStarted: bool, incompatibleStarted: bool,
    end: End, handBack: bool, closedRound: bool, delivered: int, seen: int,
    seq: int, stepError: bool, pendingShell: bool, pendingWake: bool, trace: str
  }

  pure val empty = {
    phase: Held, generation: 1, route: None, compatible: false, room: false,
    refused: false, sawNotice: false, deniedThenStarted: false, incompatibleStarted: false,
    end: NoEnd, handBack: false, closedRound: false, delivered: 0, seen: 1,
    seq: 0, stepError: false, pendingShell: false, pendingWake: false, trace: ""
  }
  action init = s' = empty

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
    or { s.phase == Active, s.phase == Recovering, s.phase == ShellWork, s.phase == WakePending },
    s' = { ...s, sawNotice: true }
  }
  action stopAuthorization = all {
    or { s.phase == Active, s.phase == Recovering },
    s' = { ...s, refused: true }
  }
  action shutdown = all {
    s.phase == Active,
    s' = { ...s, phase: Recovering, trace: "shutdown" }
  }
  action resume = all {
    s.phase == Recovering, not(s.refused),
    s' = { ...s, phase: Active, seq: s.seq + 1 }
  }
  action shellPending = all {
    s.phase == Active,
    s' = { ...s, pendingShell: true }
  }
  action diagnostic = all {
    s.phase == Active,
    s' = { ...s, stepError: true, trace: "diagnostic" }
  }
  action failedSegment = all {
    s.phase == Active, not(s.pendingWake),
    s' = { ...s, phase: if (s.pendingShell) ShellWork else Settled,
      end: Failed, seq: s.seq + 1, trace: "failed" }
  }
  action shellExited = all {
    s.pendingShell, or { s.phase == Active, s.phase == ShellWork },
    s' = { ...s, pendingShell: false, phase: if (s.phase == ShellWork) ResultUndetermined else Active, trace: "exited" }
  }
  action wakeEnqueued = all {
    s.phase == ResultUndetermined, s.end == Failed, s.delivered == 0,
    s' = { ...s, pendingWake: true, phase: WakePending, trace: "enqueued" }
  }
  action wakeCancelled = all {
    s.phase == WakePending,
    s' = { ...s, pendingWake: false, phase: Settled, trace: "cancelled" }
  }
  action wakeResumed = all {
    s.phase == WakePending, not(s.refused),
    s' = { ...s, phase: Active, stepError: false, end: NoEnd, seq: s.seq + 1, trace: "resumed" }
  }
  action wakeDelivered = all {
    s.phase == Active, s.pendingWake,
    s' = { ...s, pendingWake: false, seq: s.seq + 1, trace: "delivered" }
  }
  action succeededSegment = all {
    s.phase == Active, not(s.pendingShell), not(s.pendingWake),
    s' = { ...s, phase: Settled, pendingWake: false, end: Ok, seq: s.seq + 1, trace: "succeeded" }
  }
  action stopTimesOut = all {
    or { s.phase == Active, s.phase == ShellWork, s.phase == WakePending, s.phase == ResultUndetermined, s.phase == Recovering },
    s' = { ...s, pendingShell: false, pendingWake: false, phase: Unknown, trace: "timeout" }
  }
  action settle = all {
    or { s.phase == Active, s.phase == Recovering, s.phase == Unknown },
    not(s.pendingShell), not(s.pendingWake),
    nondet e = oneOf(Set(Ok, Failed, Cancelled))
    s' = { ...s, phase: Settled, end: e, seq: s.seq + 1, trace: "settled" }
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
    shellPending, diagnostic, failedSegment, shellExited, wakeEnqueued, wakeCancelled, wakeResumed, wakeDelivered, stopTimesOut,
    settle, handBack, deliver, nextGeneration, staleObservation, readLatest
  }
  // Fixed orders exported as ITF, compared against direct `subagents` after
  // each event. Both use the same transitions the bounded invariant explores.
  action initContinuation = s' = { ...empty, phase: Active, seq: 1, pendingShell: true, trace: "started" }
  action traceContinuation = any {
    all { s.trace == "started", diagnostic },
    all { s.trace == "diagnostic", failedSegment },
    all { s.trace == "failed", shellExited },
    all { s.trace == "exited", wakeEnqueued },
    all { s.trace == "enqueued", wakeResumed },
    all { s.trace == "resumed", wakeDelivered },
    all { s.trace == "delivered", succeededSegment },
  }
  action traceEarlierExit = any {
    all { s.trace == "started", diagnostic },
    all { s.trace == "diagnostic", shellExited },
    all { s.trace == "exited", failedSegment },
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
    s.phase != Settled or (s.end != NoEnd and not(s.pendingShell) and not(s.pendingWake)),
    s.phase != ShellWork or (s.end == Failed and s.pendingShell),
    s.phase != ResultUndetermined or (s.end == Failed and not(s.pendingShell) and not(s.pendingWake)),
    s.phase != WakePending or (s.end == Failed and s.pendingWake and not(s.pendingShell)),
    s.trace != "diagnostic" or s.phase == Active,
  }
}
