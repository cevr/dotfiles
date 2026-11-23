// The round policy's evidence, as one item's snapshot under every interleaving of its events (round-policy.ts and
// item-histories.ts `step` are the code; round-policy.test.ts (f) replays seeded production traces of the same
// events against them). History values are attempt ids: zero means none. Observation and admission are separate
// steps: `submit` is the hand-back, and what it saves must be exactly what the snapshot holds when it is taken.
//   begin        a new attempt starts (only while nothing holds the item and no attempt is running)
//   observe      the running attempt prints partial output
//   result       the running or interrupted attempt finishes; a late superseded result changes nothing
//   interrupt    the running attempt stops with no result: it stays the current attempt, partial output and all
//   deny         a fresh call never starts; it cannot substitute for a running or interrupted attempt
//   refuse       a separate action is refused beside an unfinished attempt; the attempt and its output stay
//   lift         the refusal is lifted (a later step that authorises it); attempt evidence stays on record
//   stop         the step itself hits a limit or is refused a write, without inventing an item attempt
//   host, wait   the host loses or regains the tool; a wait opens or closes
//   restart      the server restarts, or an event is delivered twice: nothing changes
// The abstraction proves no host delivery and no record authentication: only that no interleaving of these events
// lets a hand-back lose the latest completed or current attempt, its partial output, or an obstacle that holds.
module round_policy {
  // status: 0 no pending attempt, 1 running, 2 interrupted, 3 denied before start.
  // stop: 0 none of the step's own events, 1 write denied, 2 limit observed.
  var x: { current: int, status: int, latest: int, partial: int, host: bool, waiting: bool, denied: bool,
           deniedAt: int, beforeRefusal: int, stop: int, ended: bool, evidence: int, savedCurrent: int,
           savedPartial: int, savedHost: bool, savedWait: bool, savedDenial: bool, savedStop: int }

  action init = x' = { current: 0, status: 0, latest: 0, partial: 0, host: false, waiting: false, denied: false,
                       deniedAt: 0, beforeRefusal: 0, stop: 0, ended: false, evidence: 0, savedCurrent: 0,
                       savedPartial: 0, savedHost: false, savedWait: false, savedDenial: false, savedStop: 0 }

  val active = not(x.ended) and x.stop == 0
  val unfinished = x.status == 1 or x.status == 2
  action begin = all { active, not(x.denied), not(x.host), not(x.waiting), x.status != 1, x.current < 3,
                       x' = { ...x, current: x.current + 1, status: 1, partial: 0 } }
  action observe = all { active, x.status == 1, x' = { ...x, partial: x.current } }
  action result = {
    nondet id = Set(1, 2, 3).oneOf()
    all { active, id <= x.current,
          if (unfinished and not(x.denied) and id == x.current and id > x.latest)
            x' = { ...x, latest: id, status: 0, partial: 0 } else x' = x }
  }
  action interrupt = all { active, x.status == 1, x' = { ...x, status: 2 } }
  action deny = all { active, not(x.denied), not(unfinished), x.current < 3,
                     x' = { ...x, current: x.current + 1, status: 3, denied: true, deniedAt: x.current + 1, beforeRefusal: 0 } }
  action refuse = all { active, not(x.denied), unfinished,
                        x' = { ...x, denied: true, deniedAt: x.current, beforeRefusal: x.partial } }
  action lift = all { active, x.denied, x' = { ...x, denied: false } }
  action stop = {
    nondet reason = Set(1, 2).oneOf()
    all { active, not(x.denied), x' = { ...x, stop: reason } }
  }
  action host = all { active, x' = { ...x, host: not(x.host) } }
  action wait = all { active, x' = { ...x, waiting: not(x.waiting) } }
  action restartOrDuplicate = x' = x

  /** The newest attempt with no result, or none (zero). */
  val pending = if (x.status != 0) x.current else 0

  action submit = all { not(x.ended), x' = { ...x, ended: true, evidence: x.latest, savedCurrent: pending,
                            savedPartial: x.partial, savedHost: x.host, savedWait: x.waiting,
                            savedDenial: x.denied, savedStop: x.stop } }
  /** The baseline's loss: a refusal answers the hand-back and the attempt output and the other obstacles go. */
  action brokenSubmit = all { not(x.ended), x' = { ...x, ended: true, evidence: if (x.denied) 0 else x.latest, savedCurrent: pending,
                            savedPartial: if (x.denied or x.stop == 1) 0 else x.partial, savedHost: x.host and not(x.denied),
                            savedWait: x.waiting and not(x.denied), savedDenial: x.denied, savedStop: x.stop } }

  action step = any { begin, observe, result, interrupt, deny, refuse, lift, stop, host, wait, submit, restartOrDuplicate }
  action broken = any { begin, observe, result, interrupt, deny, refuse, lift, stop, host, wait, brokenSubmit, restartOrDuplicate }

  val preserves = x.ended implies
    (x.evidence == x.latest and x.savedCurrent == pending and x.savedPartial == x.partial and x.savedHost == x.host
      and x.savedWait == x.waiting and x.savedDenial == x.denied and x.savedStop == x.stop)
  val authorized = (x.denied implies x.deniedAt > 0 and x.stop == 0) and x.latest <= x.current
  val retains = (x.denied and x.beforeRefusal > 0 implies x.partial == x.beforeRefusal) and (x.status == 3 implies x.partial == 0)
  val evidenceIsAtomic = preserves and authorized and retains
}
