import { Option } from "effect"
import type { PaneWorker } from "../worker.ts"
import { DEADLINES_MS } from "./doubles.ts"
import { type CommandName, TICK_MS, type ToolCall, type Trace } from "./driver.ts"
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
const orphanReported = (trace: Trace): boolean =>
  trace.world.wakes.some((wake) => SPLIT_UNKNOWN.test(wake.letter.text)) ||
  trace.calls.some((call) => SPLIT_UNKNOWN.test(call.error) || call.reply.some((w) => SPLIT_UNKNOWN.test(w.update)))

const orphanPanes = (trace: Trace): ReadonlyArray<Violation> => {
  const referenced = new Set(trace.world.store.workers.map((w) => w.blockId))
  if (orphanReported(trace)) return []
  return trace.world.panes
    .filter((pane) => pane.owned && pane.alive && !pane.closed && !referenced.has(pane.blockId))
    .map((pane) => v(2, `pane ${pane.blockId} was split by the unit and is running, but no worker record owns it and no "split result unknown" was reported (orphan)`))
}

/** 2. A success is an accepted turn; a typed failure has no side effect on turns. */
const owned = (trace: Trace, ref: Reference): ReadonlyArray<Violation> => {
  const rejected = [...ref.rejected].flatMap((token) => {
    const typed = typings(trace.world, token).length
    const stored = trace.world.store.workers.some((w) => (w.pendingTurns ?? []).some((turn) => mentions(turn.brief, token)))
    if (typed > 0) return [v(2, `${token} was refused to the caller, yet typed ${typed}x`)]
    if (stored) return [v(2, `${token} was refused to the caller, yet the store queues it`)]
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
      if (!turn.certain || typed.length > 0 || dischargedByStop(worker, turn, Option.fromUndefinedOr(typed[0]))) continue
      if (reported === 0) out.push(v(3, `${worker.key} turn ${turn.index} (${turn.token}, ${turn.mode}) was accepted but never typed and never reported "not typed"`))
    }
    const queued = worker.turns.filter((turn) => turn.mode === "follow_up" || turn.mode === "start")
    const order = queued.flatMap((turn) => Option.toArray(Option.fromUndefinedOr(typings(trace.world, turn.token)[0])).map((at) => ({ turn, at })))
    order.slice(1).forEach((cur, i) =>
      Option.map(Option.filter(Option.fromUndefinedOr(order[i]), (prev) => cur.at < prev.at), (prev) =>
        out.push(v(3, `${worker.key}: turn ${cur.turn.index} typed before turn ${prev.turn.index} (not FIFO)`)),
      ),
    )
    return out
  })

const doneWakesCarrying = (trace: Trace, worker: RefWorker, token: string) =>
  wakesOf(trace.world, worker.id).filter((wake) => stateOf(wake) === "done" && mentions(wake.letter.text, answerOf(token)))

/**
 * The settle window: how long after a turn's end in the pane the model needs to confirm it (one poll, one
 * quiet wait and a read at the sim's quiet settings). A stop, steer or restart the caller issued before the
 * turn ended, or within this window after, races the settle: its reply is the turn's terminal report.
 */
export const SETTLE_WINDOW_MS = 60

const superseded = (worker: RefWorker, turn: RefTurn, endedAt: number): boolean =>
  worker.supersedes.some((command) => command.at >= turn.acceptedAt && command.issuedAt <= endedAt + SETTLE_WINDOW_MS)

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
      if (Option.isNone(run) || undelivered || superseded(worker, turn, Option.getOrElse(run.value.endedAt, () => 0))) continue
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
    .map((write) => v(5, `wrote "${printable(write.data)}" into ${write.blockId} while it showed a ${write.screen} prompt (t=${write.at})`))

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
    .map((write) => v(5, `wrote into ${write.blockId}, a pane the unit did not create and the caller did not name`))
  const closes = trace.world.closes.filter((close) => !close.owned).map((close) => v(5, `closed ${close.blockId}, a pane the unit did not create`))
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
