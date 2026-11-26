module handle {
  // One session, one cell, two handles, two plugin instances. The interleavings the simulation cannot exhaust:
  //   C23  a call ends WHILE its cell is being cut (before its handle is recorded);
  //   C24  a second instance starts beside the first (an install's overlap, a reload of another location);
  //        a letter whose send is lost after the host admitted it; a deleted session with a letter owed.
  // `v` is volatile (a tools.* call the cell waits on; it has no handle until the cut records one), owned by
  // instance "A". `d` is durable (a land: recorded before it starts).
  //
  //   quint run handle.qnt --invariant=safe --max-samples=20000 --max-steps=40          → no violation
  //
  // Each mutant step (the design as r1 wrote it) breaks `safe`, through the invariant named (measured by the
  // r2 review, one invariant at a time; quint.log records all five runs):
  //   quint run handle.qnt --step=stepRace --invariant=safe --max-samples=20000          → noLoss, and no other
  //   quint run handle.qnt --step=stepGlobalRestart --invariant=safe --max-samples=20000 → ownLoss, and no other
  //   quint run handle.qnt --step=stepLate --invariant=safe --max-samples=20000          → quiet and once
  // And the race is explored, not assumed away:
  //   quint run handle.qnt --invariant=raceNeverSeen --max-samples=20000                 → violated (a witness)
  //
  // Phases: "none" | "open" | "settled" | "claimed" | "delivered" | "cancelled".
  type H = { phase: str, delivery: int, starts: int, lost: bool }
  type State = {
    v: H, d: H,
    // The call's own fiber has exited (its result exists), and whether the cell read it (the reply went to the worker).
    vDone: bool, vRead: bool,
    // Mutant only: the exit reached a registry that had no handle for it yet, and was dropped.
    vDropped: bool,
    // The call ended before its handle was recorded: the race, seen.
    raced: bool,
    // The plugin instances that live. "A" owns `v`.
    alive: Set[str],
    // The host's inbox: per delivery id, how many messages it holds (it admits an id once).
    inbox: int -> int,
    // Delivery id → the handles its letter names.
    names: int -> Set[str],
    next: int,
    gone: bool,
    // The cell: "idle" | "running" | "cut". A cut cell holds no turn.
    cell: str,
    // Letters admitted after the session was deleted.
    late: int,
  }
  var s: State

  val fresh: H = { phase: "none", delivery: 0, starts: 0, lost: false }

  action init = s' = {
    v: fresh, d: fresh, vDone: false, vRead: false, vDropped: false, raced: false, alive: Set("A"),
    inbox: Map(), names: Map(), next: 1, gone: false, cell: "idle", late: 0,
  }

  pure def settled(h: H): H = if (h.phase == "open") { ...h, phase: "settled" } else h
  pure def claimed(h: H, id: int): H = if (h.phase == "settled") { ...h, phase: "claimed", delivery: id } else h
  pure def admitted(h: H, id: int): H = if (h.phase == "claimed" and h.delivery == id) { ...h, phase: "delivered" } else h

  // A cell starts a call and waits on it: the call runs in its owner's per-session scope and has NO handle.
  // The same cell accepts a land: recorded (open) before any of its work starts.
  action begin = all {
    not(s.gone), s.cell == "idle", s.v.starts == 0, s.alive.contains("A"),
    s' = { ...s, cell: "running", v: { ...s.v, starts: 1 }, d: { ...s.d, phase: "open", starts: s.d.starts + 1 } },
  }
  // The call's fiber exits, whenever: while the cell waits, during the cut, after it. Its owner must live.
  action finishV = all {
    s.v.starts == 1, not(s.vDone), s.alive.contains("A"), s.v.phase.in(Set("none", "open")),
    s' = { ...s, vDone: true },
  }
  // The host replies to the waiting cell: the cell read the result. Only before the cut is decided.
  action reply = all { s.cell == "running", s.vDone, not(s.vRead), s' = { ...s, vRead: true, cell: "idle" } }
  // W1: the cut. Every call not replied when the cut is decided gets a handle, recorded now, whether or not its
  // fiber has already exited. After the decision no reply is sent to the worker.
  action cut = all {
    s.cell == "running", not(s.vRead),
    s' = { ...s, cell: "cut", v: { ...s.v, phase: "open" }, raced: s.raced or s.vDone },
  }
  // The observer is attached only after the handle is recorded, and a fiber that already exited still yields
  // its exit: so the settle can never arrive before its handle exists.
  action observe = all { s.v.phase == "open", s.vDone, not(s.vDropped), s' = { ...s, v: settled(s.v) } }
  action settleD = all { s.d.phase == "open", s' = { ...s, d: settled(s.d) } }

  // Instance "B" starts beside "A": an install's second server, or another location's reload. It touches nothing of A's.
  action startB = all { not(s.alive.contains("B")), s' = { ...s, alive: s.alive.union(Set("B")) } }
  // An instance ends. Only "A"'s end loses `v`: open and unobserved, it settles lost, once. A waiting cell dies with it. The land runs on.
  action retire = {
    nondet o = s.alive.oneOf()
    all {
      s.alive.size() > 0,
      s' = {
        ...s,
        alive: s.alive.exclude(Set(o)),
        cell: if (o == "A" and s.cell == "running") "idle" else s.cell,
        v: if (o == "A" and s.v.phase == "open") { ...s.v, phase: "settled", lost: true } else s.v,
      },
    }
  }
  // One letter for every settle not yet told (H6).
  action claim = all {
    not(s.gone),
    s.v.phase == "settled" or s.d.phase == "settled",
    s' = {
      ...s, next: s.next + 1,
      names: s.names.put(s.next, Set("v", "d").filter(n => if (n == "v") s.v.phase == "settled" else s.d.phase == "settled")),
      v: claimed(s.v, s.next), d: claimed(s.d, s.next),
    },
  }
  // A send of an owed letter: the host admits a delivery id once. `ack` false: the answer was lost
  // (a restart, a reload) after the host took it, so the letter is sent again under the same id.
  action sendAny(guarded: bool): bool = {
    nondet id = Set(s.v.delivery, s.d.delivery).filter(i => i > 0).oneOf()
    nondet ack = Set(true, false).oneOf()
    all {
      guarded implies not(s.gone),
      (s.v.phase == "claimed" and s.v.delivery == id) or (s.d.phase == "claimed" and s.d.delivery == id),
      s' = {
        ...s,
        inbox: if (s.gone) s.inbox else s.inbox.put(id, 1),
        late: if (s.gone) s.late + 1 else s.late,
        v: if (ack) admitted(s.v, id) else s.v,
        d: if (ack) admitted(s.d, id) else s.d,
      },
    }
  }
  action send = sendAny(true)
  action cancelD = all { s.d.phase == "open", s' = { ...s, d: { ...s.d, phase: "cancelled" } } }
  // The session is deleted: what was open or untold is cancelled. A letter already claimed is still in the
  // store for a moment: the send's own guard is what keeps it from a deleted session.
  pure def dropped(h: H): H = if (h.phase.in(Set("open", "settled"))) { ...h, phase: "cancelled" } else h
  action forget = all { not(s.gone), s' = { ...s, gone: true, cell: "idle", v: dropped(s.v), d: dropped(s.d) } }

  action step = any { begin, finishV, reply, cut, observe, settleD, startB, retire, claim, send, cancelD, forget }

  // ── Mutants: the r1 design, each breaking one invariant ──

  // r1: the exit is signalled to the registry when it happens; with no handle recorded yet it is dropped (C23).
  action finishDrop = all {
    s.v.starts == 1, not(s.vDone), s.alive.contains("A"), s.v.phase == "none",
    s' = { ...s, vDone: true, vDropped: true },
  }
  action stepRace = any { begin, finishDrop, reply, cut, observe, settleD, startB, retire, claim, send, cancelD, forget }
  // r1: any instance's start marks every open volatile handle lost (C24).
  action startBGlobal = all {
    not(s.alive.contains("B")),
    s' = { ...s, alive: s.alive.union(Set("B")), v: if (s.v.phase == "open") { ...s.v, phase: "settled", lost: true } else s.v },
  }
  action stepGlobalRestart = any { begin, finishV, reply, cut, observe, settleD, startBGlobal, retire, claim, send, cancelD, forget }
  // A send with no guard for a deleted session (H5).
  action stepLate = any { begin, finishV, reply, cut, observe, settleD, startB, retire, claim, sendAny(false), cancelD, forget }

  // ── Invariants ──

  // How many admitted letters name a handle.
  def told(name: str): int = s.inbox.keys().filter(id => s.names.get(id).contains(name)).size()

  // H1: a handle is told at most once, and a delivered one exactly once.
  val once = and {
    told("v") <= 1, told("d") <= 1,
    s.v.phase == "delivered" implies told("v") == 1,
    s.d.phase == "delivered" implies told("d") == 1,
  }
  // H2: no letter names a handle that has not settled.
  val settledOnly = and {
    told("v") == 1 implies s.v.phase.in(Set("claimed", "delivered")),
    told("d") == 1 implies s.d.phase.in(Set("claimed", "delivered")),
  }
  // H7: nothing is started twice.
  val startedOnce = s.v.starts <= 1 and s.d.starts <= 1
  // H4: only the volatile call is ever lost.
  val durable = not(s.d.lost)
  // C24: a call is lost only by its own owner's end.
  val ownLoss = s.v.lost implies not(s.alive.contains("A"))
  // W1: every call a cut cell left in flight has a handle.
  val cutHasHandle = s.cell == "cut" implies s.v.phase != "none"
  // C23: a result that exists is never stuck behind a handle that cannot settle: either the cell read it,
  // or its handle is past open, or the observer can still take it.
  val noLoss = (s.v.phase == "open" and s.vDone) implies not(s.vDropped)
  // H5: nothing is admitted for a deleted session.
  val quiet = s.late == 0

  val safe = and { once, settledOnly, startedOnce, durable, ownLoss, cutHasHandle, noLoss, quiet }

  // A witness, expected VIOLATED: the call ended before its handle was recorded, and the model went there.
  val raceNeverSeen = not(s.raced and s.v.phase == "delivered" and not(s.v.lost))
}
