module childLifecycle {
  type Phase = Held | Active | ShellWork | ResultUndetermined | WakePending | Recovering | Unknown | Settled
  type Route = None | Primary | Secondary
  type End = NoEnd | Ok | Failed | Cancelled
  type Row = Working | Waiting | Undetermined | Failure | Hidden | Other
  type RestartCut = NoCut | Cut({ before: Row, after: Row, afterLinger: Row, expectedAfterLinger: Row })
  type Basis = Current | AsOf
  type Reply = { rev: int, seq: int, phase: Phase, end: End, basis: Basis, terminalFact: bool }
  type Observer = { last: Reply, inflight: Reply, requested: bool, checking: bool, floor: int }
  var s: {
    phase: Phase, generation: int, route: Route, compatible: bool, room: bool,
    refused: bool, sawNotice: bool, deniedThenStarted: bool, incompatibleStarted: bool,
    end: End, handBack: bool, closedRound: bool, delivered: int, seen: int,
    seq: int, stepError: bool, pendingShell: bool, pendingWake: bool, trace: str,
    exitObserved: bool, cut: RestartCut
  }

  pure val empty = {
    phase: Held, generation: 1, route: None, compatible: false, room: false,
    refused: false, sawNotice: false, deniedThenStarted: false, incompatibleStarted: false,
    end: NoEnd, handBack: false, closedRound: false, delivered: 0, seen: 1,
    seq: 0, stepError: false, pendingShell: false, pendingWake: false, trace: "",
    exitObserved: false, cut: NoCut
  }
  pure val noReply = { rev: 0, seq: 0, phase: Held, end: NoEnd, basis: Current, terminalFact: false }
  pure val noObserver = { last: noReply, inflight: noReply, requested: false, checking: true, floor: 0 }
  var t: { owner: Reply, row: Observer, tool: Observer, history: Set[Reply], beforeReload: Reply }
  pure val noTransport = { owner: noReply, row: noObserver, tool: noObserver, history: Set(noReply), beforeReload: noReply }
  action init = all { s' = empty, t' = noTransport }

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
      end: Failed, seq: s.seq + 1, trace: "failed", exitObserved: false }
  }
  action shellExited = all {
    s.pendingShell, or { s.phase == Active, s.phase == ShellWork },
    s' = { ...s, pendingShell: false, phase: if (s.phase == ShellWork) ResultUndetermined else Active,
      exitObserved: s.phase == ShellWork, trace: "exited" }
  }
  action wakeEnqueued = all {
    s.phase == ResultUndetermined, s.end == Failed, s.delivered == 0,
    s' = { ...s, pendingWake: true, phase: WakePending, trace: "enqueued", exitObserved: false }
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
    s' = { ...s, pendingShell: false, pendingWake: false, phase: Unknown, trace: "timeout", exitObserved: false }
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
  pure def rowFromFacts(phase: Phase, end: End, shell: bool, wake: bool, exit: bool, lingered: bool): Row =
    if (phase == Active) Working
    else if (shell or wake) Waiting
    else if (exit and end == Failed) Undetermined
    else if (end == Failed and phase == Settled) (if (lingered) Hidden else Failure)
    else Other

  // The reference is the continuous producer phase. The restarted reader has
  // no observer cache and reconstructs the row from the persisted evidence.
  pure def visibleRow(phase: Phase, end: End, lingered: bool): Row =
    if (phase == Active) Working
    else if (phase == ShellWork or phase == WakePending) Waiting
    else if (phase == ResultUndetermined) Undetermined
    else if (phase == Settled and end == Failed) (if (lingered) Hidden else Failure)
    else Other

  def restoredRow(lingered: bool): Row =
    rowFromFacts(s.phase, s.end, s.phase == ShellWork and s.pendingShell, s.phase == WakePending and s.pendingWake, s.exitObserved, lingered)

  action observerRestart = s' = { ...s, cut: Cut({
    before: visibleRow(s.phase, s.end, false),
    after: restoredRow(false),
    afterLinger: restoredRow(true),
    expectedAfterLinger: visibleRow(s.phase, s.end, true),
  }) }

  action losesExitOnRestart = any {
    step,
    all { t' = t, s.phase == ResultUndetermined, s' = { ...s, cut: Cut({
      before: Undetermined, after: Failure, afterLinger: Hidden, expectedAfterLinger: Undetermined,
    }) } },
  }

  action producers = any {
    readCatalog, readPace, admit, notice, stopAuthorization, shutdown, resume,
    shellPending, diagnostic, failedSegment, shellExited, wakeEnqueued, wakeCancelled, wakeResumed, wakeDelivered, stopTimesOut,
    settle, handBack, deliver, nextGeneration, staleObservation, readLatest, observerRestart
  }
  pure def takeRead(observer: Observer, owner: Reply): Observer =
    { ...observer, inflight: owner, requested: true, checking: true }
  pure def invalidate(observer: Observer, revision: int): Observer =
    { ...observer, floor: revision, checking: true }
  pure def accept(observer: Observer): Observer =
    if (observer.inflight.rev < observer.floor or observer.inflight.rev < observer.last.rev)
      { ...observer, requested: false }
    else { ...observer, requested: false, last: observer.inflight, checking: false }
  pure def validObserver(o: Observer, history: Set[Reply]): bool = and {
    history.contains(o.last),
    o.checking or o.last.rev >= o.floor,
    // A stale historical terminal stays Checking, never an authoritative badge.
    not(o.checking) and o.last.phase == Settled and o.last.basis == Current implies o.last.terminalFact,
  }
  action refreshOwner = all {
    t.owner.phase != s.phase or t.owner.end != s.end or t.owner.seq != s.seq,
    val owner = { rev: t.owner.rev + 1, seq: s.seq, phase: s.phase, end: s.end, basis: Current, terminalFact: s.phase == Settled }
    t' = { ...t, owner: owner, history: t.history.union(Set(owner)) },
    s' = s,
  }
  action kernelReload = all {
    t.owner.basis == Current,
    val owner = { ...t.owner, rev: t.owner.rev + 1, basis: AsOf }
    t' = { ...t, owner: owner, history: t.history.union(Set(owner)), beforeReload: t.owner },
    s' = s,
  }
  action observers = all {
    s' = s,
    any {
      all { not(t.row.requested), t' = { ...t, row: takeRead(t.row, t.owner) } },
      all { not(t.tool.requested), t' = { ...t, tool: takeRead(t.tool, t.owner) } },
      all { t.row.requested, t' = { ...t, row: accept(t.row) } },
      all { t.tool.requested, t' = { ...t, tool: accept(t.tool) } },
      all { t.row.floor < t.owner.rev, t' = { ...t, row: invalidate(t.row, t.owner.rev) } },
      all { t.tool.floor < t.owner.rev, t' = { ...t, tool: invalidate(t.tool, t.owner.rev) } },
    },
  }
  action staleReplyWins = any {
    step,
    all {
      t.row.requested, t.row.inflight.rev < t.row.floor,
      s' = s,
      t' = { ...t, row: { ...t.row, checking: false, last: t.row.inflight, requested: false } },
    },
  }
  action mixesRevisions = any {
    step,
    all {
      t.row.last.phase == ShellWork, s.phase == ResultUndetermined,
      s' = s,
      t' = { ...t, row: { ...t.row, checking: false, last: {
        ...t.row.last, phase: Settled, end: Failed, terminalFact: false,
      } } },
    },
  }
  action step = any {
    all { producers, t' = t },
    refreshOwner, kernelReload, observers
  }
  // Fixed orders exported as ITF, compared against direct `subagents` after
  // each event. Both use the same transitions the bounded invariant explores.
  action initContinuation = all {
    s' = { ...empty, phase: Active, seq: 1, pendingShell: true, trace: "started" },
    t' = noTransport,
  }
  action traceContinuation = all { t' = t, any {
    all { s.trace == "started", diagnostic },
    all { s.trace == "diagnostic", failedSegment },
    all { s.trace == "failed", shellExited },
    all { s.trace == "exited", wakeEnqueued },
    all { s.trace == "enqueued", wakeResumed },
    all { s.trace == "resumed", wakeDelivered },
    all { s.trace == "delivered", succeededSegment },
  } }
  action traceEarlierExit = all { t' = t, any {
    all { s.trace == "started", diagnostic },
    all { s.trace == "diagnostic", shellExited },
    all { s.trace == "exited", failedSegment },
  } }
  action noticeCloses = any {
    step,
    all { t' = t, s.sawNotice, s.phase == Active, s' = { ...s, closedRound: true } }
  }
  action retryDenied = any {
    step,
    all { t' = t, s.refused, s' = { ...s, phase: Active, route: Secondary, deniedThenStarted: true } }
  }
  action admitIncompatible = any {
    step,
    all { t' = t, s.phase == Held, not(s.room), not(s.compatible),
      s' = { ...s, phase: Active, route: Secondary, incompatibleStarted: true } }
  }
  action staleWins = any {
    step,
    all { t' = t, s.generation == 2, s.seen == 2, s' = { ...s, seen: 0 } }
  }
  val safe = and {
    validObserver(t.row, t.history),
    validObserver(t.tool, t.history),
    t.owner.basis != AsOf or
      (t.owner.phase == t.beforeReload.phase and t.owner.end == t.beforeReload.end and t.owner.seq == t.beforeReload.seq),
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
    restoredRow(false) == visibleRow(s.phase, s.end, false),
    restoredRow(true) == visibleRow(s.phase, s.end, true),
    match s.cut {
      | NoCut => true
      | Cut(cut) => cut.before == cut.after and cut.afterLinger == cut.expectedAfterLinger
    },
  }
}
