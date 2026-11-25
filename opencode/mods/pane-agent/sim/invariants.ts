import { Option } from "effect"
import type { PaneWorker } from "../worker.ts"
import { DEADLINES_MS } from "./doubles.ts"
import { type CommandName, TICK_MS, type ToolCall, type Trace } from "./driver.ts"
import type { EffectRecord } from "./faults.ts"
import { latestTurnAt, numberingKnown, type RefCall, type Reference, referenceOf, type RefTurn, type RefWorker } from "./reference.ts"
import { answerOf, goneAt, LIMIT_MS, OWNER_BLOCK, PLACEHOLDER, PROMPT_SCREENS, type Run, STALE_CONTENT, TOKEN, type WakeRecord, type WorldState } from "./world.ts"

/** The eight invariants of the diagnosis section 4, plus the SPEC v2 usage-limit rule. */
export const INVARIANTS = {
  1: "bounded liveness",
  2: "accepted means owned",
  3: "typing outcome",
  4: "settle and wake",
  5: "safety",
  6: "truth",
  7: "no loss",
  8: "progress",
  9: "usage limit resumed once or reported",
} as const
export type InvariantId = keyof typeof INVARIANTS

export interface Violation {
  readonly invariant: InvariantId
  readonly detail: string
}

const v = (invariant: InvariantId, detail: string): Violation => ({ invariant, detail })

export const refCallOf = (call: ToolCall): RefCall => ({
  command: call.command,
  worker: call.worker,
  token: call.token,
  issuedAt: call.startedAt,
  at: Option.getOrElse(call.endedAt, () => call.startedAt),
  outcome: call.outcome,
  workerId: Option.map(Option.fromUndefinedOr(call.reply[0]), (w) => w.id),
  skipPermissions: call.skipPermissions,
})

/** The reference model of a trace; a mutant reference can be passed in to show an invariant is not vacuous. */
export const referenceOfTrace = (trace: Trace): Reference => referenceOf(trace.calls.map(refCallOf))

const orchestratorWrites = (world: WorldState) => world.writes.filter((write) => write.proc >= 0)

/** Whether a text names a token as a whole word (TK-w1-1 is not mentioned by TK-w1-117). */
export const mentions = (text: string, token: string): boolean => text.split(/[^A-Za-z0-9-]+/).includes(token)

const typings = (world: WorldState, token: string): ReadonlyArray<number> => [
  ...orchestratorWrites(world).filter((write) => mentions(write.data, token)).map((write) => write.at),
  ...world.splits.filter((split) => split.input.command.some((arg) => mentions(arg, token))).map((split) => split.at),
]

const completedRun = (world: WorldState, token: string): Option.Option<Run> =>
  Option.fromUndefinedOr(world.runs.find((run) => Option.contains(run.token, token) && Option.isSome(run.endedAt) && !run.interrupted && !run.limited))

const wakesOf = (world: WorldState, id: string): ReadonlyArray<WakeRecord> =>
  world.wakes.filter((wake) => wake.letter.metadata["workerId"] === id)

const stateOf = (wake: WakeRecord): string => String(wake.letter.metadata["state"])
const turnOf = (wake: WakeRecord): number => Number(wake.letter.metadata["turn"])

const finalRow = (trace: Trace, id: string): Option.Option<PaneWorker> =>
  Option.fromUndefinedOr(trace.world.store.workers.find((w) => w.id === id))

const finalStatus = (trace: Trace, key: string): Option.Option<ToolCall> =>
  Option.fromUndefinedOr(trace.calls.findLast((call) => call.probe && call.command === "status" && call.worker === key))

/**
 * Each tool call's bound, from the shell design's deadlines (SPEC v2: "returns within a stated bound"):
 * start ≤ 2 × store, follow_up / steer / restart / stop ≤ ask, status ≤ ask + tail, reattach ≤ store + ask.
 * The slack is two scheduler ticks: a reply is observed at the tick after it lands.
 */
export const BOUND_MS: Readonly<Record<CommandName, number>> = {
  start: 2 * DEADLINES_MS.storeDeadline,
  follow_up: DEADLINES_MS.askDeadline,
  steer: DEADLINES_MS.askDeadline,
  restart: DEADLINES_MS.askDeadline,
  stop: DEADLINES_MS.askDeadline,
  stop_close: DEADLINES_MS.askDeadline,
  status: DEADLINES_MS.askDeadline + DEADLINES_MS.tailDeadline,
  reattach: DEADLINES_MS.storeDeadline + DEADLINES_MS.askDeadline,
}
const SLACK_MS = 2 * TICK_MS

const slow = (call: ToolCall): Option.Option<number> =>
  Option.filter(Option.map(call.endedAt, (end) => end - call.startedAt), (elapsed) => elapsed > BOUND_MS[call.command] + SLACK_MS)

/** 1. Every tool call returns within its bound with a success or a typed error (checked by its _tag). */
const liveness = (trace: Trace): ReadonlyArray<Violation> =>
  trace.calls.flatMap((call) => {
    if (call.outcome === "hang") return [v(1, `${call.command}#${call.id} (${call.worker}) did not answer within ${trace.boundMs} ms`)]
    if (call.outcome === "defect") return [v(1, `${call.command}#${call.id} (${call.worker}) died with an untyped defect: ${call.error}`)]
    if (call.outcome === "failure" && call.error === "untyped") return [v(1, `${call.command}#${call.id} failed with an untyped error`)]
    return Option.match(slow(call), {
      onNone: () => [],
      onSome: (elapsed) => [v(1, `${call.command}#${call.id} (${call.worker}) answered after ${elapsed} ms; its bound is ${BOUND_MS[call.command]} ms`)],
    })
  })

const SPLIT_UNKNOWN = /split.?result.?unknown/i

/** Ruling (2): until orphan adoption exists, an orphan split is acceptable only when the shell reported it. */
/** The worker key a token names (TK-<worker>-<n>), so a fault named by its token says whose it is. */
const workerOfToken = (token: string): string => Option.getOrElse(Option.fromUndefinedOr(/^TK-([a-z0-9]+)-\d+$/.exec(token)?.[1]), () => "?")

const TOKEN_IN = /\bTK-[a-z0-9]+-\d+\b/

/** The worker a pane belongs to: the first token typed into it or passed to its split ("?" when none was). */
const paneWorker = (world: WorldState, blockId: string): string => {
  const texts = [...world.writes.filter((write) => write.blockId === blockId && write.proc >= 0).map((write) => write.data), ...world.splits.filter((split) => split.blockId === blockId).flatMap((split) => split.input.command)]
  return Option.getOrElse(Option.map(Option.fromUndefinedOr(texts.flatMap((text) => Option.toArray(tokenIn(text)))[0]), workerOfToken), () => "?")
}

const tokenIn = (text: string): Option.Option<string> => Option.fromNullishOr(TOKEN_IN.exec(text)).pipe(Option.flatMap((match) => Option.fromUndefinedOr(match[0])))

const orphanReported = (trace: Trace): boolean =>
  trace.world.wakes.some((wake) => SPLIT_UNKNOWN.test(wake.letter.text)) ||
  trace.calls.some((call) => SPLIT_UNKNOWN.test(call.error) || call.reply.some((w) => SPLIT_UNKNOWN.test(w.update)))

const orphanPanes = (trace: Trace): ReadonlyArray<Violation> => {
  const referenced = new Set(trace.world.store.workers.map((w) => w.blockId))
  if (orphanReported(trace)) return []
  return trace.world.panes
    .filter((pane) => pane.owned && pane.alive && !pane.closed && !referenced.has(pane.blockId))
    .map((pane) => v(2, `${paneWorker(trace.world, pane.blockId)}: pane ${pane.blockId} was split by the unit and is running, but no worker record owns it and no "split result unknown" was reported (orphan)`))
}

/** 2. A success is an accepted turn; a typed failure has no side effect on turns. */
const owned = (trace: Trace, ref: Reference): ReadonlyArray<Violation> => {
  const rejected = [...ref.rejected].flatMap((token) => {
    const typed = typings(trace.world, token).length
    const stored = trace.world.store.workers.some((w) => (w.pendingTurns ?? []).some((turn) => mentions(turn.brief, token)))
    if (typed > 0) return [v(2, `${workerOfToken(token)}: ${token} was refused to the caller, yet typed ${typed}x`)]
    if (stored) return [v(2, `${workerOfToken(token)}: ${token} was refused to the caller, yet the store queues it`)]
    return []
  })
  const counters = [...ref.workers.values()].flatMap((worker) =>
    Option.match(finalRow(trace, worker.id), {
      onNone: () => [],
      onSome: (row) => {
        if (row.turn <= worker.turns.length) return []
        return [v(2, `${worker.key}: the store records turn ${row.turn}, but the caller saw only ${worker.turns.length} turn(s) accepted`)]
      },
    }),
  )
  return [...rejected, ...counters, ...orphanPanes(trace)]
}

/** The numbers a turn may go by: its acceptance index and the number the model last told the caller. */
const numbersOf = (trace: Trace, worker: RefWorker, turn: RefTurn): ReadonlySet<number> =>
  new Set([turn.index, ...[...toldNumbers(trace, worker, Infinity)].flatMap(([n, token]) => Option.toArray(Option.some(n).pipe(Option.filter(() => token === turn.token))))])

/**
 * Ruling (3): "not typed" is <pane-agent-result state="not_typed" turn="N"> with the text "Turn N was not
 * typed: <reason>" (PendingWake.kind "not_typed"). Nothing else counts as the report.
 */
const notTypedReports = (trace: Trace, worker: RefWorker, turn: RefTurn): number => {
  const numbers = numbersOf(trace, worker, turn)
  return new Set(
    wakesOf(trace.world, worker.id)
      .filter((wake) => stateOf(wake) === "not_typed" && numbers.has(turnOf(wake)) && /Turn \d+ was not typed: /.test(wake.letter.text))
      .map((wake) => wake.letter.id),
  ).size
}

const dischargedByStop = (worker: RefWorker, turn: RefTurn, typedAt: Option.Option<number>): boolean =>
  Option.exists(worker.stoppedAt, (stop) => stop >= turn.acceptedAt && !Option.exists(typedAt, (at) => at < stop))

/** Tokens whose turn met the usage limit: a "not typed" report there is about the resume (ruling 5), not the brief. */
const limitedTokens = (world: WorldState): ReadonlySet<string> => new Set(world.runs.filter((run) => run.limited).flatMap((run) => Option.toArray(run.token)))

const HELD = /(\d+) (?:queued )?turn(?:s|\(s\))? (?:(?:is|are|was|were) )?held/i

const goneWakes = (trace: Trace, worker: RefWorker): ReadonlyArray<WakeRecord> => wakesOf(trace.world, worker.id).filter((wake) => stateOf(wake) === "pane_gone")

/** The held count a pane_gone wake states ("N turn(s) held"), if it states one. */
const heldCount = (wake: WakeRecord): Option.Option<number> =>
  Option.fromNullishOr(HELD.exec(wake.letter.text)).pipe(Option.flatMap((match) => Option.fromUndefinedOr(match[1])), Option.map(Number))

/**
 * Ruling (9): a turn still queued when its pane died is HELD, not owed a report: it is accepted at quiescence when
 * the final row is pane_gone and still queues it, the pane is gone in the world, and a pane_gone wake states the
 * held count.
 */
const heldAtQuiescence = (trace: Trace, worker: RefWorker, turn: RefTurn): boolean =>
  Option.exists(finalRow(trace, worker.id), (row) => {
    const held = (row.pendingTurns ?? []).filter((queued) => mentions(queued.brief, turn.token)).length > 0
    const stated = goneWakes(trace, worker).some((wake) => Option.contains(heldCount(wake), (row.pendingTurns ?? []).length))
    return row.state === "pane_gone" && held && Option.isSome(goneAt(trace.world, row.blockId)) && stated
  })

/** Ruling (9): after a pane_gone wake, a stop must report each held turn not_typed, never drop it silently. */
const heldAtStop = (trace: Trace, worker: RefWorker, turn: RefTurn): boolean =>
  Option.exists(worker.stoppedAt, (stop) => turn.acceptedAt <= stop && goneWakes(trace, worker).some((wake) => wake.at <= stop))

/** Ruling (9): nothing is reported not_typed at pane_gone itself; only a later stop or restart may report it. */
const notTypedAtGone = (trace: Trace, worker: RefWorker): ReadonlyArray<Violation> =>
  wakesOf(trace.world, worker.id)
    .filter((wake) => stateOf(wake) === "not_typed")
    .flatMap((wake) => {
      const gone = goneWakes(trace, worker).filter((g) => g.at <= wake.at)
      const answered = gone.some((g) => worker.supersedes.some((command) => command.issuedAt >= g.at && command.issuedAt <= wake.at))
      if (gone.length === 0 || answered) return []
      return [v(3, `${worker.key}: turn ${turnOf(wake)} was reported "not typed" at pane_gone, before any stop or restart (ruling 9)`)]
    })

/** The turn number each reply stated for a token (the shell's own commitment), for ordering overlapping calls. */
const statedNumbers = (trace: Trace, worker: RefWorker): ReadonlyMap<string, number> =>
  new Map([...toldNumbers(trace, worker, Infinity)].map(([n, token]) => [token, n]))

/**
 * Which of two accepted turns must be typed first: issue order when the earlier call ended before the later one
 * began (happens-before); for overlapping calls, the turn numbers the replies stated; else the order they ended.
 */
const firstOf = (a: RefTurn, b: RefTurn, stated: ReadonlyMap<string, number>): boolean => {
  if (a.acceptedAt <= b.issuedAt) return true
  if (b.acceptedAt <= a.issuedAt) return false
  const na = Option.fromUndefinedOr(stated.get(a.token))
  const nb = Option.fromUndefinedOr(stated.get(b.token))
  if (Option.isSome(na) && Option.isSome(nb)) return na.value < nb.value
  return a.acceptedAt <= b.acceptedAt
}

const fifo = (trace: Trace, worker: RefWorker): ReadonlyArray<Violation> => {
  const stated = statedNumbers(trace, worker)
  const typed = worker.turns
    .filter((turn) => turn.mode === "follow_up" || turn.mode === "start")
    .flatMap((turn) => Option.toArray(Option.fromUndefinedOr(typings(trace.world, turn.token)[0])).map((at) => ({ turn, at })))
  return typed.flatMap((a, i) =>
    typed.slice(i + 1).flatMap((b) => {
      const aFirst = firstOf(a.turn, b.turn, stated)
      if (aFirst && b.at < a.at) return [v(3, `${worker.key}: turn ${b.turn.index} typed before turn ${a.turn.index} (not FIFO)`)]
      if (!aFirst && a.at < b.at) return [v(3, `${worker.key}: turn ${a.turn.index} typed before turn ${b.turn.index} (not FIFO)`)]
      return []
    }),
  )
}

/** 3. Every accepted turn is typed exactly once, FIFO per worker, or reported "not typed" exactly once; never both. */
const typing = (trace: Trace, ref: Reference): ReadonlyArray<Violation> =>
  [...ref.workers.values()].flatMap((worker) => {
    const out: Array<Violation> = []
    const limited = limitedTokens(trace.world)
    for (const turn of worker.turns) {
      const typed = typings(trace.world, turn.token)
      const reported = notTypedReports(trace, worker, turn)
      if (typed.length > 1) out.push(v(3, `${worker.key} turn ${turn.index} (${turn.token}) typed ${typed.length} times`))
      if (typed.length > 0 && reported > 0 && !limited.has(turn.token)) out.push(v(3, `${worker.key} turn ${turn.index} (${turn.token}) was typed and also reported "not typed"`))
      if (reported > 1) out.push(v(3, `${worker.key} turn ${turn.index} (${turn.token}) was reported "not typed" ${reported} times`))
      if (!turn.certain || typed.length > 0) continue
      if (dischargedByStop(worker, turn, Option.none())) {
        if (reported === 0 && heldAtStop(trace, worker, turn)) out.push(v(3, `${worker.key} turn ${turn.index} (${turn.token}) was held while the pane was gone and dropped by stop without a "not typed" report (ruling 9)`))
        continue
      }
      if (reported === 0 && !heldAtQuiescence(trace, worker, turn)) out.push(v(3, `${worker.key} turn ${turn.index} (${turn.token}, ${turn.mode}) was accepted but never typed and never reported "not typed"`))
    }
    return [...out, ...fifo(trace, worker), ...notTypedAtGone(trace, worker)]
  })

const doneWakesCarrying = (trace: Trace, worker: RefWorker, token: string) =>
  wakesOf(trace.world, worker.id).filter((wake) => stateOf(wake) === "done" && mentions(wake.letter.text, answerOf(token)))

/**
 * The settle window: how long after a turn's end in the pane the model needs to confirm it (one poll, one
 * quiet wait and a read at the sim's quiet settings). A stop, steer or restart the caller issued before the
 * turn ended, or within this window after, races the settle: its reply is the turn's terminal report.
 */
export const SETTLE_WINDOW_MS = 60

const READS: ReadonlyArray<string> = ["pane.read", "pane.readTail"]

/** Ok reads of a block that saw its done screen in [from, to] (by any process, or only by processes alive at the end). */
const doneReads = (trace: Trace, blockId: string, from: number, to: number, liveOnly: boolean): ReadonlyArray<EffectRecord> =>
  trace.effects.filter(
    (e) => READS.includes(e.boundary) && e.fault === "ok" && e.detail === `${blockId}:done` && e.at >= from && e.at <= to && (!liveOnly || !trace.world.deadProcs.has(e.proc)),
  )

/** When a run's done frame stopped being readable: the next run in that pane, the pane's death, or never. */
const frameUntil = (trace: Trace, run: Run): number => {
  const end = Option.getOrElse(run.endedAt, () => 0)
  const next = trace.world.runs.filter((other) => other.blockId === run.blockId && other.startedAt >= end && other.id !== run.id).map((other) => other.startedAt)
  return Math.min(...next, Option.getOrElse(goneAt(trace.world, run.blockId), () => Infinity))
}

/**
 * How long a fault-free gap after a disruption gives a correct shell its chance: its bounded call returns within a
 * read deadline, then it reads the frame and settles within the settle window. Once such a gap has passed, not
 * having read is the shell's failure, not the fault's.
 */
export const OBSERVE_GAP_MS = DEADLINES_MS.readDeadline + SETTLE_WINDOW_MS

/** The calls by which a shell observes a pane's turn end: its liveness, its quiet wait and its reads. */
const OBSERVING: ReadonlyArray<string> = ["pane.read", "pane.readTail", "pane.alive", "pane.waitForQuiet"]

/** Faults that still hold their call when the turn ends (a hang until its deadline, a timeout, a late landing, a crash). */
const LASTING: ReadonlyArray<string> = ["hang", "timeout", "late", "crash"]

const observes = (e: EffectRecord, blockId: string): boolean => OBSERVING.includes(e.boundary) && e.detail.startsWith(`${blockId}:`)

/** The processes watching a run's pane: the last to observe it by the run's end, and every one observing it after. */
const watchersOf = (trace: Trace, blockId: string, end: number): ReadonlySet<number> => {
  const observing = trace.effects.filter((e) => observes(e, blockId))
  const before = Option.fromUndefinedOr(observing.filter((e) => e.at <= end).at(-1))
  return new Set([...Option.toArray(before), ...observing.filter((e) => e.at >= end)].map((e) => e.proc))
}

/**
 * When a watching process died: the crash fault it took, else (a crash the driver forced, which records no fault)
 * the first process start after its last effect, which is its recovery. A process still alive has no death.
 */
const deathOf = (trace: Trace, proc: number): Option.Option<number> => {
  const crash = Option.fromUndefinedOr(trace.effects.find((e) => e.proc === proc && e.fault === "crash"))
  if (Option.isSome(crash)) return Option.some(crash.value.at)
  if (!trace.world.deadProcs.has(proc)) return Option.none()
  const last = Math.max(...trace.effects.filter((e) => e.proc === proc).map((e) => e.at))
  return Option.map(Option.fromUndefinedOr(trace.effects.find((e) => e.boundary === "process.start" && e.at >= last && e.proc !== proc)), (e) => e.at)
}

interface Disruption {
  readonly at: number
  readonly lasting: boolean
}

/**
 * Adjudication 4a/4b/4c, scoped (review r5 B1): the disruptions that can keep THIS run's end from being observed are a
 * fault on an observing call of its pane and a crash of a process watching it, while its frame showed. A fault on
 * another worker, another pane or the store is none of them.
 */
const disruptionsOf = (trace: Trace, run: Run, end: number, frameEnd: number): ReadonlyArray<Disruption> => {
  const faults = trace.effects.filter((e) => observes(e, run.blockId) && e.fault !== "ok").map((e) => ({ at: e.at, lasting: LASTING.includes(e.fault) }))
  const deaths = [...watchersOf(trace, run.blockId, end)].flatMap((proc) => Option.toArray(deathOf(trace, proc))).map((at) => ({ at, lasting: true }))
  return [...faults, ...deaths].filter((d) => d.at <= frameEnd).sort((a, b) => a.at - b.at)
}

/**
 * The last disruption of the excuse chain that starts at the run's end, if one starts there. It starts with a
 * lasting disruption still holding at the end (from a read deadline before), or with one within the settle window
 * after it (a fault-free run settles in that window); each next one follows the last within OBSERVE_GAP_MS. The
 * first fault-free gap longer than that ends the chain: a correct shell has read by then.
 */
const excuseEnd = (disruptions: ReadonlyArray<Disruption>, end: number): Option.Option<number> => {
  const holding = disruptions.flatMap((d) => [d.at].filter(() => d.lasting && d.at >= end - DEADLINES_MS.readDeadline && d.at < end))
  let last = Math.max(...holding, -Infinity)
  if (holding.length === 0) last = end
  let gap = [SETTLE_WINDOW_MS, OBSERVE_GAP_MS][Number(holding.length > 0)] ?? SETTLE_WINDOW_MS
  let linked = holding.length > 0
  for (const d of disruptions.filter((item) => item.at >= end)) {
    if (d.at - last > gap) break
    last = d.at
    gap = OBSERVE_GAP_MS
    linked = true
  }
  return Option.filter(Option.some(last), () => linked)
}

export interface Observability {
  /** No correct shell could have observed the run's end while its frame showed (ruling 10, adjudication 4a/4b). */
  readonly unobservable: boolean
  /** By when a correct shell has settled the run; a stop, steer or restart issued by then races the settle (4c). Never unbounded. */
  readonly settleBy: number
}

/**
 * Was this turn's end unobservable to a correct shell? The ONE answer 4a, 4b and 4c use (review r5 B1). An excuse is
 * a bounded, causally connected interval, never a flag: the chain of this pane's disruptions from the run's end
 * (`excuseEnd`). The end was unobservable only when no ok read saw the done frame and the chain lasted until the
 * frame was gone (the pane's death or its next run), with no gap longer than OBSERVE_GAP_MS before that. A frame
 * still showing is never unobservable: faults stop and a correct shell reads it. A stop, steer or restart races the
 * settle until the chain's last disruption plus OBSERVE_GAP_MS (or an ok read plus the settle window, if earlier);
 * with no chain the window stays the fault-free 60 ms.
 */
export const observability = (trace: Trace, run: Run): Observability => {
  const end = Option.getOrElse(run.endedAt, () => 0)
  const frameEnd = frameUntil(trace, run)
  const seen = doneReads(trace, run.blockId, end, frameEnd, false).length > 0
  const firstLiveRead = Option.fromUndefinedOr(doneReads(trace, run.blockId, end, Infinity, true)[0])
  const readSettle = Option.match(firstLiveRead, { onNone: () => Infinity, onSome: (e) => Math.max(e.at, end) + SETTLE_WINDOW_MS })
  return Option.match(excuseEnd(disruptionsOf(trace, run, end, frameEnd), end), {
    onNone: () => ({ unobservable: false, settleBy: end + SETTLE_WINDOW_MS }),
    onSome: (last) => ({
      unobservable: !seen && frameEnd - last <= OBSERVE_GAP_MS,
      settleBy: Math.max(end + SETTLE_WINDOW_MS, Math.min(last + OBSERVE_GAP_MS, readSettle)),
    }),
  })
}

const uncapturable = (trace: Trace, run: Run): boolean => observability(trace, run).unobservable

const notCapturedWakes = (trace: Trace, worker: RefWorker, turn: RefTurn): ReadonlyArray<WakeRecord> => {
  const numbers = numbersOf(trace, worker, turn)
  return wakesOf(trace.world, worker.id).filter((wake) => stateOf(wake) === "answer_not_captured" && numbers.has(turnOf(wake)))
}

const fileHoldsAnswer = (trace: Trace, run: Run, token: string): boolean =>
  Option.exists(run.resultFile, (path) => Option.exists(Option.fromUndefinedOr(trace.world.files.get(path)), (entry) => entry.content.trim() === answerOf(token)))

/** Ruling (10) and adjudication 4b: the truthful terminal reports for a turn whose end no read could capture. */
const unreadReported = (trace: Trace, worker: RefWorker, turn: RefTurn, run: Run): boolean => {
  if (!uncapturable(trace, run)) return false
  if (notCapturedWakes(trace, worker, turn).length > 0) return true
  const end = Option.getOrElse(run.endedAt, () => 0)
  const died = goneAt(trace.world, run.blockId)
  return Option.isSome(died) && !fileHoldsAnswer(trace, run, turn.token) && goneWakes(trace, worker).some((wake) => wake.at >= end)
}

/** Adjudication 4c: a stop, steer or restart races the settle when issued by `settleBy` (60 ms without a disruption chain). */
const superseded = (trace: Trace, worker: RefWorker, turn: RefTurn, run: Run): boolean => {
  const limit = observability(trace, run).settleBy
  return worker.supersedes.some((command) => command.at >= turn.acceptedAt && command.issuedAt <= limit)
}

/** Ruling (10): a not-captured report for a turn whose end a correct shell could observe (`observability`) is false. */
const falseNotCaptured = (trace: Trace, worker: RefWorker, turn: RefTurn, run: Run): ReadonlyArray<Violation> => {
  if (notCapturedWakes(trace, worker, turn).length === 0 || uncapturable(trace, run)) return []
  return [v(4, `${worker.key} turn ${turn.index} (${turn.token}) was reported "answer_not_captured", but a read saw its done frame or its pane's reads had a fault-free chance to (ruling 10)`)]
}

/** 4. One settle per turn and one wake per (turn, kind) as the receiver counts them (distinct delivery ids). */
const wakes = (trace: Trace, ref: Reference): ReadonlyArray<Violation> =>
  [...ref.workers.values()].flatMap((worker) => {
    const out: Array<Violation> = []
    const byKey = new Map<string, Set<string>>()
    for (const wake of wakesOf(trace.world, worker.id)) {
      const key = `${turnOf(wake)}:${stateOf(wake)}`
      byKey.set(key, new Set([...(byKey.get(key) ?? []), wake.letter.id]))
    }
    for (const [key, ids] of byKey) if (ids.size > 1) out.push(v(4, `${worker.key}: ${ids.size} distinct wakes for (turn, kind) ${key}`))
    const undelivered = Option.exists(finalRow(trace, worker.id), (row) => row.state === "wake_undelivered")
    for (const turn of worker.turns) {
      const run = completedRun(trace.world, turn.token)
      if (Option.isNone(run)) continue
      out.push(...falseNotCaptured(trace, worker, turn, run.value))
      if (undelivered || superseded(trace, worker, turn, run.value) || unreadReported(trace, worker, turn, run.value)) continue
      const done = doneWakesCarrying(trace, worker, turn.token).length
      if (done === 0) out.push(v(4, `${worker.key} turn ${turn.index} (${turn.token}) ended in the pane, but no done wake ever carried its answer`))
    }
    return out
  })

const ESC = String.fromCharCode(27)

/** The first bytes of a write, control characters spelled out. */
const printable = (data: string): string => data.slice(0, 40).split(ESC).join("\\e").split("\r").join("\\r").split("\n").join("\\n")

const promptWrite = (trace: Trace): ReadonlyArray<Violation> =>
  orchestratorWrites(trace.world)
    .filter((write) => PROMPT_SCREENS.includes(write.screen))
    .map((write) => v(5, `${paneWorker(trace.world, write.blockId)}: wrote "${printable(write.data)}" into ${write.blockId} while it showed a ${write.screen} prompt (t=${write.at})`))

const named = (trace: Trace): ReadonlySet<string> => {
  if (trace.calls.some((call) => call.command === "start" && call.worker.startsWith("named"))) return new Set([OWNER_BLOCK])
  return new Set()
}

const HEADING = /\[[^\]]*from ([^\]]+)\]/i

/** 5. No write during a prompt; writes and closes only on panes the unit created or the caller named; the sender is "the orchestrator". */
const safety = (trace: Trace): ReadonlyArray<Violation> => {
  const allowed = named(trace)
  const foreign = orchestratorWrites(trace.world)
    .filter((write) => !write.owned && !allowed.has(write.blockId))
    .map((write) => v(5, `${paneWorker(trace.world, write.blockId)}: wrote into ${write.blockId}, a pane the unit did not create and the caller did not name`))
  const closes = trace.world.closes.filter((close) => !close.owned).map((close) => v(5, `${paneWorker(trace.world, close.blockId)}: closed ${close.blockId}, a pane the unit did not create`))
  const senders = orchestratorWrites(trace.world).flatMap((write) =>
    Option.fromNullishOr(HEADING.exec(write.data)).pipe(
      Option.map((match) => match[1]),
      Option.filter((sender) => sender !== "the orchestrator"),
      Option.match({ onNone: () => [], onSome: (sender) => [v(5, `typed text names its sender as "${sender}"`)] }),
    ),
  )
  return [...promptWrite(trace), ...foreign, ...closes, ...senders]
}

const commandToken = (call: ToolCall, w: PaneWorker): Option.Option<string> =>
  Option.filter(call.token, (token) => !(w.pendingTurns ?? []).some((turn) => mentions(turn.brief, token)))

const toldBy = (call: ToolCall, worker: RefWorker): ReadonlyArray<readonly [string, number]> =>
  call.reply.flatMap((w) => [
    ...Option.toArray(commandToken(call, w)).map((token) => [token, w.turn] as const),
    ...(w.pendingTurns ?? []).flatMap((queued) => worker.turns.filter((turn) => mentions(queued.brief, turn.token)).map((turn) => [turn.token, queued.turn] as const)),
  ])

/**
 * The turn number the model last told the caller for each token before `at` (a reply's own turn for the
 * command's token, or a queued entry naming the token), so a wake's turn is judged by the model's own words.
 */
const toldNumbers = (trace: Trace, worker: RefWorker, at: number): ReadonlyMap<number, string> => {
  const told = new Map<string, number>()
  const answered = trace.calls.filter((call) => call.worker === worker.key && call.outcome === "success" && Option.getOrElse(call.endedAt, () => Infinity) <= at)
  for (const call of answered) for (const [token, number] of toldBy(call, worker)) told.set(token, number)
  return new Map([...told].map(([token, number]) => [number, token]))
}

const doneTruth = (trace: Trace, worker: RefWorker): ReadonlyArray<Violation> =>
  wakesOf(trace.world, worker.id)
    .filter((wake) => stateOf(wake) === "done")
    .flatMap((wake) => {
      const text = wake.letter.text
      if (text.includes(`\n${PLACEHOLDER}\n`) || text.includes(STALE_CONTENT)) return [v(6, `${worker.key}: done wake ${wake.letter.id} carries a placeholder or stale answer, not the turn's final answer`)]
      const toldToken = Option.fromUndefinedOr(toldNumbers(trace, worker, wake.at).get(turnOf(wake)))
      const byOrder = Option.filter(Option.fromUndefinedOr(worker.turns[turnOf(wake) - 1]), (turn) => numberingKnown(worker, turn.index)).pipe(Option.map((turn) => turn.token))
      const token = Option.orElse(toldToken, () => byOrder)
      if (Option.isNone(token)) return []
      const run = completedRun(trace.world, token.value)
      if (Option.isNone(run) || Option.getOrElse(run.value.endedAt, () => Infinity) > wake.at) {
        return [v(6, `${worker.key}: done wake for turn ${turnOf(wake)} (${token.value}) at t=${wake.at}, but that turn had not ended in the pane`)]
      }
      if (!mentions(text, answerOf(token.value))) return [v(6, `${worker.key}: done wake for turn ${turnOf(wake)} (${token.value}) does not carry that turn's answer`)]
      return []
    })

const goneTruth = (trace: Trace, worker: RefWorker): ReadonlyArray<Violation> => {
  const wakeClaims = wakesOf(trace.world, worker.id)
    .filter((wake) => stateOf(wake) === "pane_gone")
    .map((wake) => ({ at: wake.at, block: String(wake.letter.metadata["blockId"]), what: `pane_gone wake ${wake.letter.id}` }))
  const replyClaims = trace.calls
    .filter((call) => call.worker === worker.key && call.outcome === "success")
    .flatMap((call) => call.reply.filter((w) => w.state === "pane_gone").map((w) => ({ at: Option.getOrElse(call.endedAt, () => call.startedAt), block: w.blockId, what: `${call.command}#${call.id} reply` })))
  return [...wakeClaims, ...replyClaims].flatMap((claim) => {
    const died = goneAt(trace.world, claim.block)
    if (Option.exists(died, (at) => at <= claim.at)) return []
    return [v(6, `${worker.key}: ${claim.what} says pane_gone at t=${claim.at}, but pane ${claim.block} is alive in the world`)]
  })
}

const statusTruth = (trace: Trace, worker: RefWorker): ReadonlyArray<Violation> =>
  trace.calls
    .filter((call) => call.worker === worker.key && call.command === "status" && call.outcome === "success")
    .flatMap((call) => {
      const at = Option.getOrElse(call.endedAt, () => call.startedAt)
      const claims = call.reply.filter((w) => w.state === "done")
      const latest = latestTurnAt(worker, call.startedAt)
      if (claims.length === 0 || Option.isNone(latest) || !latest.value.certain) return []
      const ended = Option.exists(completedRun(trace.world, latest.value.token), (run) => Option.getOrElse(run.endedAt, () => Infinity) <= at)
      if (ended) return []
      return [v(6, `${worker.key}: status#${call.id} says done at t=${at}, but turn ${latest.value.index} (${latest.value.token}) has not ended in the pane`)]
    })

/** Ruling (3): WorkerState stays within its existing literals (worker.ts at 44f5ed09). */
const WORKER_STATES: ReadonlyArray<string> = ["starting", "working", "needs_input", "rex_unreachable", "wake_undelivered", "pane_gone", "done", "failed", "stopped"]

const knownStates = (trace: Trace, worker: RefWorker): ReadonlyArray<Violation> => {
  const shown = [
    ...trace.world.storeWrites.filter((write) => write.worker.id === worker.id).map((write) => write.worker.state),
    ...trace.calls.filter((call) => call.worker === worker.key).flatMap((call) => call.reply.map((w) => w.state)),
  ]
  return [...new Set(shown)].flatMap((state) => {
    if (WORKER_STATES.includes(state)) return []
    return [v(6, `${worker.key}: shows state "${state}", not one of the worker states`)]
  })
}

const quiescentTruth = (trace: Trace, worker: RefWorker): ReadonlyArray<Violation> => {
  const row = finalRow(trace, worker.id)
  const out: Array<Violation> = [...knownStates(trace, worker)]
  if (Option.exists(row, (w) => w.state === "working" || w.state === "starting")) {
    out.push(v(6, `${worker.key}: at quiescence the store says ${Option.match(row, { onNone: () => "", onSome: (w) => w.state })}, but no typed turn is open in the pane`))
  }
  const status = Option.flatMap(finalStatus(trace, worker.key), (call) => Option.fromUndefinedOr(call.reply[0]))
  if (Option.isSome(row) && Option.isSome(status) && (status.value.state !== row.value.state || status.value.turn !== row.value.turn)) {
    out.push(v(6, `${worker.key}: at quiescence status says ${status.value.state}/turn ${status.value.turn} but the store says ${row.value.state}/turn ${row.value.turn}`))
  }
  return out
}

const ANSWER_TOKEN = /ANSWER-(TK-[a-z0-9]+-\d+)/g

/** A done wake that re-delivers an answer already delivered for another turn reports a turn that never ran. */
const redelivered = (trace: Trace, worker: RefWorker): ReadonlyArray<Violation> => {
  const firstTurn = new Map<string, number>()
  const out: Array<Violation> = []
  for (const wake of wakesOf(trace.world, worker.id).filter((w) => stateOf(w) === "done")) {
    for (const match of wake.letter.text.matchAll(ANSWER_TOKEN)) {
      const token = match[1] ?? ""
      Option.match(Option.fromUndefinedOr(firstTurn.get(token)), {
        onNone: () => firstTurn.set(token, turnOf(wake)),
        onSome: (earlier) => {
          if (earlier !== turnOf(wake)) out.push(v(6, `${worker.key}: done wake for turn ${turnOf(wake)} at t=${wake.at} carries the answer of turn ${earlier} (${token}), a turn already reported`))
        },
      })
    }
  }
  return out
}

/** 6. Every state a wake, a reply or the row shows is true of the world at that moment. */
const truth = (trace: Trace, ref: Reference): ReadonlyArray<Violation> =>
  [...ref.workers.values()].flatMap((worker) => [
    ...doneTruth(trace, worker),
    ...redelivered(trace, worker),
    ...goneTruth(trace, worker),
    ...statusTruth(trace, worker),
    ...quiescentTruth(trace, worker),
  ])

const optionsKept = (trace: Trace, worker: RefWorker): ReadonlyArray<Violation> => {
  const rows = trace.world.storeWrites.filter((write) => write.worker.id === worker.id)
  const lost = rows.filter((write) => (write.worker.skipPermissions ?? true) !== worker.options.skipPermissions || !(write.worker.addDirs ?? ["/sim/extra"]).includes("/sim/extra"))
  const resumes = trace.world.splits.filter((split) => split.input.command.includes("--continue") && rows.some((row) => row.worker.blockId === split.blockId))
  const flagLost = resumes.filter((split) => split.input.command.includes("--dangerously-skip-permissions") !== worker.options.skipPermissions || !split.input.command.includes("/sim/extra"))
  return [
    ...lost.slice(0, 1).map((write) => v(7, `${worker.key}: a store write at t=${write.at} lost an option (skipPermissions ${worker.options.skipPermissions} or addDir /sim/extra)`)),
    ...flagLost.slice(0, 1).map((split) => v(7, `${worker.key}: the restart command dropped an option: ${split.input.command.join(" ")}`)),
  ]
}

/** 7. Options, queued turns and pending wakes survive every transition, restart and crash; no row is lost. */
const noLoss = (trace: Trace, ref: Reference): ReadonlyArray<Violation> => {
  const ids = new Set(trace.world.storeWrites.map((write) => write.worker.id))
  const final = new Set(trace.world.store.workers.map((w) => w.id))
  const rows = [...ids].flatMap((id) => {
    if (final.has(id)) return []
    return [v(7, `worker row ${id} was written and later lost from the store`)]
  })
  return [...rows, ...[...ref.workers.values()].flatMap((worker) => optionsKept(trace, worker))]
}

const stuckRow = (trace: Trace, worker: RefWorker): ReadonlyArray<Violation> =>
  Option.match(finalRow(trace, worker.id), {
    onNone: () => [],
    onSome: (row) => {
      const idle = Option.exists(Option.fromUndefinedOr(trace.world.panes.find((p) => p.blockId === row.blockId)), (pane) => pane.alive && !PROMPT_SCREENS.includes(pane.screen))
      const out: Array<Violation> = []
      const wakesLeft = (row.pendingWakes ?? []).filter((wake) => wake.undelivered !== true)
      if (wakesLeft.length > 0) out.push(v(8, `${worker.key}: ${wakesLeft.length} wake(s) still pending in the outbox at quiescence`))
      if (idle && row.state !== "stopped" && (row.pendingTurns ?? []).length > 0) out.push(v(8, `${worker.key}: ${(row.pendingTurns ?? []).length} queued turn(s) never typed though the pane is idle`))
      return out
    },
  })

/** 8. After faults stop the worker settles, and a fresh follow_up on an idle worker is accepted (it is not wedged). */
const progress = (trace: Trace, ref: Reference): ReadonlyArray<Violation> => {
  const wedged = trace.calls
    .filter((call) => call.probe && call.command === "follow_up" && call.outcome === "failure")
    .map((call) => v(8, `${call.worker}: with faults off and the pane idle, a follow_up still fails (${call.error}): the worker is wedged`))
  return [...wedged, ...[...ref.workers.values()].flatMap((worker) => stuckRow(trace, worker))]
}

/** 9 (SPEC v2 addition, ruling 5). A limited turn gets one "limited" wake and is resumed exactly once after its reset, or reported "not typed". */
const LIMITED_TEXT = /<pane-agent-result state="limited" turn="\d+" reset="[^"]+">/
const CONTINUE = /\bcontinue\b/i

const ownerOf = (ref: Reference, token: string): Option.Option<readonly [RefWorker, RefTurn]> =>
  Option.fromUndefinedOr(
    [...ref.workers.values()].flatMap((worker) => worker.turns.filter((turn) => turn.token === token).map((turn) => [worker, turn] as const))[0],
  )

/** The `continue` writes into the run's pane from its limit until the pane's next limit (if any). */
const continueWrites = (trace: Trace, run: Run) => {
  const end = Option.getOrElse(run.endedAt, () => 0)
  const next = Option.fromUndefinedOr(trace.world.runs.find((other) => other.blockId === run.blockId && other.limited && other.id > run.id))
  const until = Option.getOrElse(Option.flatMap(next, (other) => other.endedAt), () => Infinity)
  return orchestratorWrites(trace.world).filter((write) => write.blockId === run.blockId && write.at >= end && write.at < until && CONTINUE.test(write.data) && !TOKEN.test(write.data))
}

const limitReports = (trace: Trace, worker: RefWorker, turn: RefTurn): number => {
  const numbers = numbersOf(trace, worker, turn)
  return new Set(
    wakesOf(trace.world, worker.id)
      .filter((wake) => stateOf(wake) === "limited" && numbers.has(turnOf(wake)) && LIMITED_TEXT.test(wake.letter.text))
      .map((wake) => wake.letter.id),
  ).size
}

const limitedRun = (trace: Trace, worker: RefWorker, turn: RefTurn, run: Run): ReadonlyArray<Violation> => {
  const end = Option.getOrElse(run.endedAt, () => 0)
  const resetAt = Option.getOrElse(run.resetAt, () => end + LIMIT_MS)
  const writes = continueWrites(trace, run)
  const early = writes.filter((write) => write.at < resetAt).length
  const resumes = writes.length - early
  const what = `${worker.key} turn ${turn.index} (${turn.token}) hit the usage limit at t=${end}`
  const out: Array<Violation> = []
  if (early > 0) out.push(v(9, `${what}; "continue" was typed ${early} time(s) before its reset at t=${resetAt}`))
  if (resumes > 0 && notTypedReports(trace, worker, turn) > 0) out.push(v(9, `${what}; it was resumed after its reset and also reported "not typed" (ruling 8)`))
  if (worker.supersedes.some((command) => command.at >= turn.acceptedAt && command.issuedAt <= resetAt)) return out
  if (limitReports(trace, worker, turn) === 0) out.push(v(9, `${what}, but no "limited" wake reported it`))
  if (resumes > 1) out.push(v(9, `${what}; resumed ${resumes} times after its reset at t=${resetAt} (once is the rule)`))
  if (resumes === 0 && notTypedReports(trace, worker, turn) === 0) out.push(v(9, `${what}; never resumed after its reset at t=${resetAt} and never reported "not typed"`))
  return out
}

const usageLimit = (trace: Trace, ref: Reference): ReadonlyArray<Violation> =>
  trace.world.runs
    .filter((run) => run.limited && Option.isSome(run.endedAt))
    .flatMap((run) =>
      Option.match(Option.flatMap(run.token, (token) => ownerOf(ref, token)), {
        onNone: () => [],
        onSome: ([worker, turn]) => limitedRun(trace, worker, turn, run),
      }),
    )

export const checkAll = (trace: Trace, ref: Reference = referenceOfTrace(trace)): ReadonlyArray<Violation> => [
  ...liveness(trace),
  ...owned(trace, ref),
  ...typing(trace, ref),
  ...wakes(trace, ref),
  ...safety(trace),
  ...truth(trace, ref),
  ...noLoss(trace, ref),
  ...progress(trace, ref),
  ...usageLimit(trace, ref),
]

export const formatViolations = (violations: ReadonlyArray<Violation>): string =>
  violations.map((item) => `  [I${item.invariant} ${INVARIANTS[item.invariant]}] ${item.detail}`).join("\n")

/** A detail with its numbers, tokens and ids stripped; worker keys (w1, named1) stay, so a fault on another worker differs. */
export const strippedDetail = (detail: string): string =>
  detail
    .replace(/\bmsg_[A-Za-z0-9_]+/g, "<msg>")
    .replace(/\bpa_[A-Za-z0-9_]+/g, "<id>")
    .replace(/\bblock:[A-Za-z-]+\d*/g, "<block>")
    .replace(/\bTK-[a-z0-9]+-\d+\b/g, "<tok>")
    .replace(/(?<![A-Za-z])\d+/g, "N")

/** A violation's signature (SPEC v2 ruling 7, widened): its invariant and its shaped detail (the worker is in the detail). */
export const signatureOf = (violation: Violation): string => `I${violation.invariant} ${strippedDetail(violation.detail)}`
