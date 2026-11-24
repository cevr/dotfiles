module childLifecycle {
  type Phase = Held | Active | ShellWork | ResultUndetermined | WakePending | Recovering | Unknown | Settled
  type Route = None | Primary | Secondary
  type End = NoEnd | Ok | Failed | Cancelled
  type Row = Working | Waiting | Undetermined | Failure | Hidden | Other
  type RestartCut = NoCut | Cut({ before: Row, after: Row, afterLinger: Row, expectedAfterLinger: Row })
  type Basis = Current | AsOf
  type Reply = { rev: int, seq: int, phase: Phase, end: End, basis: Basis, terminalFact: bool, used: Set[int], activation: int }
  type Observer = { last: Reply, inflight: Reply, requested: bool, checking: bool, floor: int }
  type State = {
    phase: Phase, generation: int, route: Route, compatible: bool, room: bool,
    refused: bool, sawNotice: bool, deniedThenStarted: bool, incompatibleStarted: bool,
    end: End, handBack: bool, closedRound: bool, delivered: int, seen: int,
    seq: int, stepError: bool, pendingShell: bool, pendingWake: bool, trace: str,
    exitObserved: bool, cut: RestartCut,
    activation: int, execution: int, executionSeen: int, oldExecutionSeen: int, shellSeen: int, exitSeen: int,
    pending: Set[int], ordinary: Set[int], inputSeen: int -> int, inputExecution: int -> int,
    admission: int -> int, actualAdmission: int -> int, unseenThrough: int,
    incarnation: int, stopSeen: int, foreignPreserved: bool, instanceSound: bool
  }
  var s: State

  pure val empty = {
    phase: Held, generation: 1, route: None, compatible: false, room: false,
    refused: false, sawNotice: false, deniedThenStarted: false, incompatibleStarted: false,
    end: NoEnd, handBack: false, closedRound: false, delivered: 0, seen: 1,
    seq: 0, stepError: false, pendingShell: false, pendingWake: false, trace: "",
    exitObserved: false, cut: NoCut,
    activation: 1, execution: 0, executionSeen: 0, oldExecutionSeen: 0, shellSeen: 0, exitSeen: 0,
    pending: Set(), ordinary: Set(), inputSeen: Map(1 -> 0, 2 -> 0, 3 -> 0), inputExecution: Map(1 -> 0, 2 -> 0),
    admission: Map(1 -> 0, 2 -> 0), actualAdmission: Map(1 -> 0, 2 -> 0), unseenThrough: 0, incarnation: 1,
    stopSeen: 0, foreignPreserved: true, instanceSound: true
  }
  pure val noReply = { rev: 0, seq: 0, phase: Held, end: NoEnd, basis: Current, terminalFact: false, used: Set(), activation: 1 }
  pure val noObserver = { last: noReply, inflight: noReply, requested: false, checking: true, floor: 0 }
  var t: { owner: Reply, row: Observer, tool: Observer, history: Set[Reply], reloadPreserved: bool }
  pure val noTransport = { owner: noReply, row: noObserver, tool: noObserver, history: Set(noReply), reloadPreserved: true }
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
    s' = { ...s, phase: Active, route: if (s.room) Primary else Secondary, seq: s.seq + 1,
      execution: s.execution + 1, executionSeen: s.activation }
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
    s' = { ...s, phase: Recovering, trace: "shutdown", executionSeen: s.activation }
  }
  action resume = all {
    s.phase == Recovering, not(s.refused),
    s' = { ...s, phase: Active, seq: s.seq + 1, execution: s.execution + 1, executionSeen: s.activation }
  }
  action shellPending = all {
    s.phase == Active,
    s' = { ...s, pendingShell: true, shellSeen: s.activation }
  }
  action diagnostic = all {
    s.phase == Active,
    s' = { ...s, stepError: true, trace: "diagnostic" }
  }
  action failedSegment = all {
    s.phase == Active, not(s.pendingWake),
    s' = { ...s, phase: if (s.pendingShell) ShellWork else Settled,
      end: Failed, seq: s.seq + 1, trace: "failed", exitObserved: false, executionSeen: s.activation }
  }
  action shellExited = all {
    s.pendingShell, or { s.phase == Active, s.phase == ShellWork },
    s' = { ...s, pendingShell: false, phase: if (s.phase == ShellWork) ResultUndetermined else Active,
      exitObserved: s.phase == ShellWork, trace: "exited", exitSeen: s.activation }
  }
  action wakeEnqueuedFor(id: int): bool = all {
    or { s.phase == ResultUndetermined, s.phase == WakePending }, s.end == Failed, s.delivered == 0,
    not(s.pending.union(s.ordinary).contains(id)),
    s' = { ...s, pendingWake: true, phase: WakePending, trace: "enqueued", exitObserved: false,
      pending: s.pending.union(Set(id)), inputSeen: s.inputSeen.set(id, s.activation), seq: s.seq + 1,
      inputExecution: s.inputExecution.set(id, s.execution),
      admission: s.admission.set(id, s.seq + 1), actualAdmission: s.actualAdmission.set(id, s.seq + 1) }
  }
  action wakeEnqueued = { nondet id = oneOf(Set(1, 2)); wakeEnqueuedFor(id) }
  action wakeCancelled = all {
    or { s.phase == WakePending, s.phase == Active },
    nondet id = oneOf(s.pending)
    val rest = s.pending.exclude(Set(id))
    val done = rest == Set()
    val attributable = s.admission.get(id) > s.unseenThrough
    val closesEpoch = done and s.phase == WakePending and attributable and s.inputExecution.get(id) == s.execution
    s' = { ...s, pending: rest, pendingWake: not(done),
      phase: if (closesEpoch) Settled else if (done and s.phase == WakePending) Unknown else s.phase,
      trace: "cancelled", inputSeen: s.inputSeen.set(id, s.activation), seq: s.seq + 1,
      instanceSound: s.instanceSound and (not(attributable) or s.admission.get(id) == s.actualAdmission.get(id)),
      executionSeen: if (closesEpoch) s.activation else s.executionSeen }
  }
  action reuseForNotice = {
    nondet id = oneOf(Set(1, 2))
    all {
      s.admission.get(id) > 0, not(s.pending.union(s.ordinary).contains(id)),
      s' = { ...s, seq: s.seq + 1, ordinary: s.ordinary.union(Set(id)), inputExecution: s.inputExecution.set(id, 0),
        admission: s.admission.set(id, s.seq + 1), actualAdmission: s.actualAdmission.set(id, s.seq + 1) },
    }
  }
  action closeNotice = all {
    nondet id = oneOf(s.ordinary)
    val changed = { ...s, seq: s.seq + 1, ordinary: s.ordinary.exclude(Set(id)) }
    s' = { ...changed, foreignPreserved: basisAt(changed) == basisAt(s) }
  }
  // Two indistinguishable gaps: only the producer knows whether the missing
  // positions were harmless or closed and re-admitted the visible ID.
  action missPositions = all {
    s.phase == WakePending,
    nondet id = oneOf(s.pending)
    nondet reuse = oneOf(Set(false, true))
    nondet width = oneOf(Set(1, 2))
    val seq = s.seq + width
    all {
      not(reuse) or width == 2,
      s' = { ...s, seq: seq, unseenThrough: seq,
        actualAdmission: if (reuse) s.actualAdmission.set(id, seq) else s.actualAdmission },
    }
  }
  action seePosition = all {
    s.phase == WakePending,
    s' = { ...s, seq: s.seq + 1 }
  }
  // The owner sees creation or detects the changed creation marker. Either
  // resets the facts and aggregate positions, not the transport's floor.
  action recreate = all {
    s.incarnation == 1, s.phase == WakePending,
    nondet observed = oneOf(Set(false, true))
    s' = { ...empty, activation: s.activation, incarnation: 2,
      trace: if (observed) "created" else "changed-marker" }
  }
  action cancelForeign = {
    val changed = { ...s, seq: s.seq + 1, inputSeen: s.inputSeen.set(3, s.activation) }
    s' = { ...changed, foreignPreserved: basisAt(changed) == basisAt(s) }
  }
  action observeOlderExecution = all {
    s.execution >= 2,
    val changed = { ...s, oldExecutionSeen: s.activation }
    s' = { ...changed, foreignPreserved: basisAt(changed) == basisAt(s) }
  }
  action wakeResumed = all {
    s.phase == WakePending, not(s.refused),
    s' = { ...s, phase: Active, stepError: false, end: NoEnd, seq: s.seq + 1, trace: "resumed",
      execution: s.execution + 1, executionSeen: s.activation }
  }
  action wakeDelivered = all {
    s.phase == Active, s.pendingWake,
    nondet id = oneOf(s.pending)
    val rest = s.pending.exclude(Set(id))
    s' = { ...s, pending: rest, pendingWake: rest != Set(), inputSeen: s.inputSeen.set(id, s.activation), seq: s.seq + 1, trace: "delivered" }
  }
  action succeededSegment = all {
    s.phase == Active, not(s.pendingShell), not(s.pendingWake),
    s' = { ...s, phase: Settled, pendingWake: false, end: Ok, seq: s.seq + 1, trace: "succeeded", executionSeen: s.activation }
  }
  action stopTimesOut = all {
    or { s.phase == Active, s.phase == ShellWork, s.phase == WakePending, s.phase == ResultUndetermined, s.phase == Recovering },
    s' = { ...s, pendingShell: false, pendingWake: false, pending: Set(), phase: Unknown, trace: "timeout", exitObserved: false, stopSeen: s.activation }
  }
  action settle = all {
    or { s.phase == Active, s.phase == Recovering, s.phase == Unknown },
    not(s.pendingShell), not(s.pendingWake),
    nondet e = oneOf(Set(Ok, Failed, Cancelled))
    s' = { ...s, phase: Settled, end: e, seq: s.seq + 1, trace: "settled", executionSeen: s.activation }
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
      handBack: false, closedRound: false, delivered: 0, sawNotice: false, stepError: false, inputSeen: empty.inputSeen }
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
    shellPending, diagnostic, failedSegment, shellExited, wakeEnqueued, wakeCancelled, cancelForeign, observeOlderExecution,
    reuseForNotice, closeNotice, missPositions, seePosition, recreate,
    wakeResumed, wakeDelivered, stopTimesOut,
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
  pure def evaluated(st: State): Set[int] =
    if (st.phase == Held) Set()
    else if (st.phase == Unknown) Set(st.stopSeen)
    else if (st.phase == ShellWork) Set(st.executionSeen, st.shellSeen)
    else if (st.phase == ResultUndetermined) Set(st.executionSeen, st.exitSeen)
    else if (st.phase == WakePending)
      Set(st.executionSeen, st.inputSeen.get(if (st.pending.contains(1)) 1 else 2))
    else Set(st.executionSeen)
  pure def basisAt(st: State): Basis =
    if (evaluated(st).forall((seen) => seen == st.activation)) Current else AsOf
  pure def answer(st: State, rev: int): Reply =
    { rev: rev, seq: st.seq, phase: st.phase, end: st.end, basis: basisAt(st),
      terminalFact: st.phase == Settled and st.executionSeen == st.activation, used: evaluated(st), activation: st.activation }
  val ownerMatches = t.owner == answer(s, t.owner.rev)
  action refreshOwner = all {
    not(ownerMatches),
    val owner = answer(s, t.owner.rev + 1)
    t' = { ...t, owner: owner, history: t.history.union(Set(owner)) },
    s' = s,
  }
  action kernelReload = all {
    val after = { ...s, activation: s.activation + 1 }
    val owner = answer(after, t.owner.rev + 1)
    val before = answer(s, t.owner.rev)
    all {
      s' = after,
      t' = { ...t, owner: owner, history: t.history.union(Set(owner)),
        reloadPreserved: owner.phase == before.phase and owner.end == before.end and owner.seq == before.seq },
    },
  }
  action observers = all {
    s' = s,
    any {
      all { ownerMatches, not(t.row.requested), t' = { ...t, row: takeRead(t.row, t.owner) } },
      all { ownerMatches, not(t.tool.requested), t' = { ...t, tool: takeRead(t.tool, t.owner) } },
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
  action initMixCut = {
    val shell = { ...empty, phase: ShellWork, end: Failed, seq: 3, execution: 1,
      executionSeen: 1, pendingShell: true, shellSeen: 1 }
    val live = answer(shell, 1)
    all {
      s' = { ...shell, phase: ResultUndetermined, pendingShell: false, exitObserved: true, exitSeen: 1 },
      t' = { ...noTransport, owner: live, history: Set(noReply, live),
        row: { ...noObserver, last: live, checking: false } },
    }
  }
  action laundersProvenance = any {
    step,
    all {
      or { s.phase == Settled, s.phase == WakePending }, basisAt(s) == AsOf,
      val changed = { ...s, seq: s.seq + 1, executionSeen: s.activation,
        inputSeen: s.inputSeen.set(1, s.activation).set(2, s.activation).set(3, s.activation) }
      s' = { ...changed, foreignPreserved: basisAt(changed) == basisAt(s) },
      t' = t,
    },
  }
  action initLaunderCut = all {
    s' = { ...empty, phase: WakePending, end: Failed, activation: 2, execution: 1, seq: 5, executionSeen: 1,
      pending: Set(1, 2), pendingWake: true, inputSeen: empty.inputSeen.set(1, 1).set(2, 1),
      inputExecution: empty.inputExecution.set(1, 1).set(2, 1) },
    t' = noTransport,
  }
  action initReuseCut = all {
    s' = { ...empty, phase: WakePending, end: Failed, activation: 2, execution: 1, seq: 8, executionSeen: 1,
      pending: Set(1), pendingWake: true, admission: empty.admission.set(1, 4),
      actualAdmission: empty.actualAdmission.set(1, 8), unseenThrough: 8,
      inputSeen: empty.inputSeen.set(1, 1), inputExecution: empty.inputExecution.set(1, 1) },
    t' = noTransport,
  }
  action ignoresAdmissionGeneration = any {
    step,
    all {
      t' = t, s.phase == WakePending, s.admission.get(1) != s.actualAdmission.get(1),
      s' = { ...s, phase: Settled, pending: Set(), pendingWake: false,
        executionSeen: s.activation, instanceSound: false },
    },
  }
  action step = any {
    all { producers, t' = t },
    refreshOwner, kernelReload, observers
  }
  // Fixed orders exported as ITF, compared against direct `subagents` after
  // each event. Both use the same transitions the bounded invariant explores.
  action initContinuation = all {
    s' = { ...empty, phase: Active, seq: 1, pendingShell: true, trace: "started",
      execution: 1, executionSeen: 1, shellSeen: 1 },
    t' = noTransport,
  }
  action traceContinuation = all { t' = t, any {
    all { s.trace == "started", diagnostic },
    all { s.trace == "diagnostic", failedSegment },
    all { s.trace == "failed", shellExited },
    all { s.trace == "exited", wakeEnqueuedFor(1) },
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
    t.owner.basis == (if (t.owner.used.forall((seen) => seen == t.owner.activation)) Current else AsOf),
    t.reloadPreserved,
    s.foreignPreserved,
    s.instanceSound,
    s.pendingWake == (s.pending != Set()),
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
