// The round policy's evidence, as one item's snapshot under every interleaving of its events (round-policy.ts and
// item-histories.ts `step` are the code; round-policy.test.ts (f) replays seeded production traces of the same
// events against them). History values are attempt ids: zero means none. Observation and admission are separate
// steps: `submit` is the hand-back, and what it saves must be exactly what the snapshot holds when it is taken.
//   begin        a new attempt starts (only while nothing holds the item and no attempt is running)
//   result       the running attempt finishes; an older or repeated result (late, duplicate) changes nothing
//   interrupt    the running attempt stops with no result: it stays the current attempt, partial output and all
//   deny         a refusal answers the item: the running attempt, if any, is denied; the completed one stays
//   lift         the refusal is lifted (a later step that authorises it); the denied attempt stays on record
//   host, wait   the host loses or regains the tool; a wait opens or closes
//   restart      the server restarts, or an event is delivered twice: nothing changes
// The abstraction proves no host delivery and no record authentication: only that no interleaving of these events
// lets a hand-back lose the latest completed attempt, the current one, or an obstacle that holds.
module round_policy {
  var x: { current: int, running: bool, latest: int, host: bool, waiting: bool, denied: bool, deniedAt: int,
           ended: bool, evidence: int, savedCurrent: int, savedHost: bool, savedWait: bool, savedDenial: bool }

  action init = x' = { current: 0, running: false, latest: 0, host: false, waiting: false, denied: false, deniedAt: 0,
                       ended: false, evidence: 0, savedCurrent: 0, savedHost: false, savedWait: false, savedDenial: false }

  action begin = all { not(x.ended), not(x.denied), not(x.host), not(x.waiting), not(x.running), x.current < 3,
                       x' = { ...x, current: x.current + 1, running: true } }
  action result = {
    nondet id = Set(1, 2, 3).oneOf()
    all { not(x.ended), id <= x.current,
          if (x.running and id == x.current and id > x.latest) x' = { ...x, latest: id, running: false } else x' = x }
  }
  action interrupt = all { not(x.ended), x.running, x' = { ...x, running: false } }
  action deny = all { not(x.ended), not(x.denied), x.current > 0, x' = { ...x, denied: true, deniedAt: x.current, running: false } }
  action lift = all { not(x.ended), x.denied, x' = { ...x, denied: false } }
  action host = all { not(x.ended), x' = { ...x, host: not(x.host) } }
  action wait = all { not(x.ended), x' = { ...x, waiting: not(x.waiting) } }
  action restartOrDuplicate = x' = x

  /** The newest attempt with no result, or none (zero). */
  val pending = if (x.current > x.latest) x.current else 0

  action submit = all { not(x.ended), x' = { ...x, ended: true, evidence: x.latest, savedCurrent: pending,
                            savedHost: x.host, savedWait: x.waiting, savedDenial: x.denied } }
  /** The baseline's loss: a refusal answers the hand-back and the attempt output and the other obstacles go. */
  action brokenSubmit = all { not(x.ended), x' = { ...x, ended: true, evidence: if (x.denied) 0 else x.latest, savedCurrent: pending,
                            savedHost: x.host and not(x.denied), savedWait: x.waiting and not(x.denied), savedDenial: x.denied } }

  action step = any { begin, result, interrupt, deny, lift, host, wait, submit, restartOrDuplicate }
  action broken = any { begin, result, interrupt, deny, lift, host, wait, brokenSubmit, restartOrDuplicate }

  val preserves = x.ended implies
    (x.evidence == x.latest and x.savedCurrent == pending and x.savedHost == x.host and x.savedWait == x.waiting and x.savedDenial == x.denied)
  /** A refusal answers an attempt; the latest completed attempt is never newer than the newest one begun. */
  val authorized = (x.denied implies x.deniedAt > 0) and x.latest <= x.current
  val evidenceIsAtomic = preserves and authorized
}
