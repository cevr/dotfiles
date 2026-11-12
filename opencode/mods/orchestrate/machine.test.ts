// The batch machine one root runs, as the plugin's ledger decides it
// (machine.ts): a model-based test. A small reference model of the skill's
// machine (the shadow below: sets of units by state, whether a verifier
// runs, the last verdicts' findings and where each was folded) and the
// Machine decider take the same generated command sequences; each step must
// agree on the outcome (accepted, or refused by which rule), and the
// invariants are checked on every state the decider reaches:
//
//   I1  never two verifiers at once, unless the start departed from it;
//   I2  a verifier that starts without a departure names a batch, and covers
//       every landed unit (with none landed, every ready one: a land by hand);
//   I3  a land that passes without a departure names every ready unit, and
//       comes only when the cadence is met or no implementor is running;
//   I4  no land passes while a landed batch has no verdict (no verifier yet,
//       or its verifier still runs), or while a finding of the last verdict
//       is folded into no unit, or into one it does not land that is not
//       still implementing (that one rides with its unit's land), unless it
//       departed;
//   I5  a unit is in `verify` only while a verifier runs;
//   I6  an implementor's start is never refused: the next batch fans out
//       while a verifier runs (the pipeline);
//   L1  the guard never deadlocks a compliant root: the verifier's verdict
//       comes in, each finding is folded into a unit that hands back ready,
//       and once the oldest ready unit has waited the cadence's time,
//       landing every ready unit passes;
//   L2  every refused command passes when it states a departure, and records
//       it under the rule it broke.
//
// Then the stories of the audited roots and of the pipeline, the notes that
// ride on a start's answer, and the brief a compacted root gets. That each
// rule's words are the skill's own is git/machine-words.test.ts (this
// folder's root files read no file).
import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import {
  briefOf,
  type Cadence,
  type Command,
  type Event,
  HandBack,
  handBackOf,
  Land,
  Landed,
  type LandTarget,
  machine,
  type MachineState,
  notesOf,
  ReportRead,
  reportOf,
  type Rule,
  RULES,
  Spawned,
  Start,
  startOf,
  unitOfEntry,
  unitOfName,
  verifierPromptOf,
} from "./machine.ts"

const CADENCE: Cadence = { ready: 3, waitMs: 30 * 60_000 }
const M = machine(CADENCE)
const MIN = 60_000

/** What one decision gave: the events it recorded, or the rule that refused it. */
type Outcome = { readonly events: ReadonlyArray<Event> } | { readonly refused: Rule; readonly message: string }

const decide = (state: MachineState, command: Command, now: number): Promise<Outcome> =>
  Effect.runPromise(
    M.decide(state, command, now).pipe(
      Effect.match({
        onFailure: (refusal): Outcome => ({ refused: refusal.rule, message: refusal.message }),
        onSuccess: (events): Outcome => ({ events }),
      }),
    ),
  )
const evolve = (state: MachineState, events: ReadonlyArray<Event>) => events.reduce(M.evolve, state)

// ── The reference model ──

type ShadowState = "implement" | "ended" | "ready" | "landed" | "verify"
interface Shadow {
  readonly units: Map<string, { state: ShadowState; since: number; direct: boolean }>
  verifier: string | undefined
  /** What the running verifier covers, as it started: no unit's later round changes it. */
  covering: ReadonlyArray<string>
  /** The units landed with no verifier started over them yet, whatever round each is on since. */
  readonly pending: Set<string>
  /** The `changes` verdicts whose report did not read: their findings are not known. */
  readonly unresolved: Set<string>
  /** The last verdicts' findings not landed yet: the batch, and the unit each was folded into. */
  readonly findings: Map<string, { batch: string; into: string | undefined }>
  /** Findings folded into units that landed, for the next verifier. */
  readonly carried: Map<string, { batch: string; into: string }>
}
const BATCH = /^batch-/
const inState = (shadow: Shadow, ...states: ReadonlyArray<ShadowState>) => [...shadow.units].filter(([, unit]) => states.includes(unit.state)).map(([name]) => name)
const matched = (shadow: Shadow, rifts: ReadonlyArray<LandTarget>) => {
  const ready = inState(shadow, "ready")
  return ready.filter((unit) => rifts.some((rift) => unitOfEntry(rift, [...shadow.units.keys()]) === unit))
}
/**
 * What a batch verifier covers: what landed and has no verifier yet, whatever round each is on since; with
 * nothing landed (a land by hand, which the plugin does not see), what is ready, so its start stands for their land.
 */
const coverOf = (shadow: Shadow) => (shadow.pending.size > 0 ? [...shadow.pending] : inState(shadow, "ready"))
/** A verdict is pending: a verifier runs, or a landed batch has none yet. Read from batches, not unit slots. */
const verdictDue = (shadow: Shadow) => shadow.verifier !== undefined || shadow.pending.size > 0
/** The cadence is not met and an implementor still runs: waiting is what the machine says. */
const notDue = (shadow: Shadow, now: number) => {
  const ready = inState(shadow, "ready")
  if (ready.length === 0 || ready.length >= CADENCE.ready) return false
  const oldest = Math.min(...ready.map((unit) => shadow.units.get(unit)!.since))
  return now - oldest < CADENCE.waitMs && inState(shadow, "implement").length > 0
}
/** The findings a land of `lands` leaves unfolded: none folded, or folded into a unit it does not take that is not still implementing (that one rides with its unit's land). */
const unfolded = (shadow: Shadow, lands: ReadonlyArray<string>) =>
  [...shadow.findings]
    .filter(([, finding]) => finding.into === undefined || (!lands.includes(finding.into) && shadow.units.get(finding.into)?.state !== "implement"))
    .map(([key]) => key)
/** The rules `command` breaks on `shadow`, in the order they are checked. */
const broken = (shadow: Shadow, command: Command, now: number): ReadonlyArray<Rule> => {
  if (command._tag === "Start" && command.role === "verifier") {
    const rules: Array<Rule> = []
    if (!BATCH.test(command.name) && shadow.units.size > 0) rules.push("VerifierPerUnit")
    if (shadow.verifier !== undefined) rules.push("VerifierRunning")
    if (shadow.pending.size === 0 && notDue(shadow, now)) rules.push("BatchNotDue")
    return rules
  }
  if (command._tag === "Land") {
    const lands = matched(shadow, command.rifts)
    if (lands.length === 0) return []
    const rules: Array<Rule> = []
    if (verdictDue(shadow)) rules.push("VerdictPending")
    if (unfolded(shadow, lands).length > 0 || shadow.unresolved.size > 0) rules.push("FindingUnfolded")
    if (inState(shadow, "ready").length > lands.length) rules.push("LandPartial")
    if (notDue(shadow, now)) rules.push("BatchNotDue")
    return rules
  }
  return []
}
/** The shadow after an accepted `command`. */
const apply = (shadow: Shadow, command: Command, now: number): void => {
  switch (command._tag) {
    case "Start": {
      if (command.role === "implementor") {
        shadow.units.set(command.name, { state: "implement", since: now, direct: command.direct })
        // Its own unit's findings, and those its folds name, are folded into it.
        for (const [key, finding] of shadow.findings) {
          const of = key.split("/")[0]!
          if (of === command.name || (command.folds ?? []).some((ref) => ref === key || ref === of)) finding.into = command.name
        }
      }
      if (command.role !== "verifier") return
      if (!BATCH.test(command.name) && shadow.units.size === 0) return
      const named = shadow.units.get(command.name)
      const cover = !BATCH.test(command.name) && named !== undefined && (named.state === "ready" || shadow.pending.has(command.name)) ? [command.name] : coverOf(shadow)
      for (const unit of cover) {
        const slot = shadow.units.get(unit)
        // A covered unit whose next round took its slot over keeps that round's state.
        if (slot !== undefined && (slot.state === "landed" || (slot.state === "ready" && !shadow.pending.has(unit)))) shadow.units.set(unit, { ...slot, state: "verify", since: now })
      }
      for (const unit of cover) shadow.pending.delete(unit)
      shadow.verifier = command.name
      // A second verifier (one that departed) takes over the first one's cover too.
      shadow.covering = [...new Set([...shadow.covering, ...cover])]
      return
    }
    case "HandBack": {
      if (command.role === "implementor") {
        const unit = shadow.units.get(command.name)
        if (unit === undefined || unit.state !== "implement") return
        shadow.units.set(command.name, { ...unit, state: command.verdict === "ready" ? "ready" : "ended", since: now })
        return
      }
      if (command.role !== "verifier" || shadow.verifier !== command.name) return
      for (const unit of inState(shadow, "verify")) {
        // A dead verifier gave no verdict: its units are landed and unverified again.
        if (command.verdict === "none") shadow.units.set(unit, { ...shadow.units.get(unit)!, state: "landed", since: now })
        else shadow.units.delete(unit)
      }
      shadow.verifier = undefined
      // A dead verifier's batch still waits for a verdict.
      if (command.verdict === "none") for (const unit of shadow.covering) shadow.pending.add(unit)
      shadow.covering = []
      if (command.verdict === "none") return
      shadow.carried.clear()
      // A `changes` whose findings did not read is unresolved, never an empty set.
      if (command.verdict === "changes" && command.findings === undefined) shadow.unresolved.add(command.name)
      if (command.verdict === "changes") for (const key of command.findings ?? []) shadow.findings.set(key, { batch: command.name, into: undefined })
      return
    }
    case "ReportRead":
      if (!shadow.unresolved.delete(command.batch)) return
      for (const key of command.findings) shadow.findings.set(key, { batch: command.batch, into: undefined })
      return
    case "Land":
      return
    case "Landed": {
      const lands = matched(shadow, command.rifts)
      for (const unit of lands) {
        if (shadow.units.get(unit)!.direct) shadow.units.delete(unit)
        else {
          shadow.units.set(unit, { ...shadow.units.get(unit)!, state: "landed", since: now })
          shadow.pending.add(unit)
        }
      }
      if (lands.length === 0) return
      shadow.unresolved.clear()
      for (const [key, finding] of shadow.findings) {
        if (finding.into === undefined) shadow.findings.delete(key)
        else if (lands.includes(finding.into)) {
          shadow.carried.set(key, { batch: finding.batch, into: finding.into })
          shadow.findings.delete(key)
        }
      }
    }
  }
}

// ── The generator: a seeded stream, so a failure names its seed ──

const rng = (seed: number) => () => {
  seed = (seed + 0x6d2b79f5) | 0
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}
const UNITS = ["alpha", "beta", "gamma", "delta", "eps"] as const
/** A unit's Rift as a land names it: by name, branch, path, a later round's Rift, its branch read, or `{ path, unit }`. */
const riftFor = (unit: string, pick: number): LandTarget =>
  [
    unit,
    `feat/${unit}`,
    `p5/${unit}`,
    `/home/me/.rifts/repo/${unit}`,
    `${unit}-${2 + (pick % 3)}`,
    { rift: `/home/me/.rifts/repo/scratch-${pick}`, branch: `feat/${unit}-${2 + (pick % 3)}` },
    { rift: `/home/me/.rifts/repo/scratch-${pick}`, unit },
  ][pick % 7]!

const command = (random: () => number, shadow: Shadow): Command => {
  const pick = <A,>(list: ReadonlyArray<A>): A => list[Math.floor(random() * list.length)]!
  const departs = random() < 0.08 ? { departs: "the owner asked for this one alone" } : {}
  const roll = random()
  if (roll < 0.3) {
    // Now and then a fold: a finding by its key, or every finding of a unit, maybe one that is no open finding's.
    const open = [...shadow.findings.keys()]
    const folds = random() < 0.4 ? [random() < 0.15 || open.length === 0 ? `${pick(UNITS)}/M9` : random() < 0.5 ? pick(open) : pick(open).split("/")[0]!] : []
    return Start.make({ role: "implementor", name: pick(UNITS), round: 1 + Math.floor(random() * 5), direct: random() < 0.1, ...(folds.length === 0 ? {} : { folds }) })
  }
  if (roll < 0.55) return HandBack.make({ role: "implementor", name: pick(UNITS), verdict: pick(["ready", "ready", "ready", "blocked", "none"] as const) })
  if (roll < 0.68) {
    const name = random() < 0.7 ? `batch-${1 + Math.floor(random() * 3)}` : pick(UNITS)
    return Start.make({ role: "verifier", name, round: 1, direct: false, ...departs })
  }
  if (roll < 0.78) {
    const verdict = pick(["accepted", "changes", "changes", "stuck", "none"] as const)
    const findings = inState(shadow, "verify").flatMap((unit) => (random() < 0.5 ? [`${unit}/M${1 + Math.floor(random() * 2)}`] : []))
    // A `changes` whose report did not read carries no findings (now and then saying why): unresolved, not empty.
    const read = random() < 0.75
    const unread = !read && random() < 0.5 ? { unread: { report: "/nonexistent/loop-probe-x/findings.md", why: "it is missing" } } : {}
    return HandBack.make({ role: "verifier", name: shadow.verifier ?? "batch-1", verdict, ...(verdict === "changes" && read ? { findings } : unread) })
  }
  if (roll < 0.8) return ReportRead.make({ batch: pick([...shadow.unresolved, "batch-1"]), findings: random() < 0.5 ? [] : [`${pick(UNITS)}/M3`] })
  const ready = inState(shadow, "ready")
  // Mostly the whole ready set, sometimes a part of it or a Rift that is no unit's.
  const some = ready.filter(() => random() < 0.8)
  const rifts = [...(random() < 0.6 ? ready : some).map((unit) => riftFor(unit, Math.floor(random() * 7))), ...(random() < 0.1 ? ["scratch"] : [])]
  if (roll < 0.92) return Land.make({ rifts, ...departs })
  return Landed.make({ rifts })
}

const SEQUENCES = 1500
const STEPS = 45

const statesOf = (state: MachineState) => Object.fromEntries(Object.entries(state.units).map(([name, unit]) => [name, unit.state]))
const findingsOf = (state: MachineState) => Object.fromEntries(Object.entries(state.findings ?? {}).map(([key, finding]) => [key, `${finding.batch}:${finding.into ?? "-"}`]))
const shadowFindings = (shadow: Shadow) => Object.fromEntries([...shadow.findings].map(([key, finding]) => [key, `${finding.batch}:${finding.into ?? "-"}`]))
const carriedOf = (state: MachineState) => Object.fromEntries(Object.entries(state.carried ?? {}).map(([key, finding]) => [key, `${finding.batch}:${finding.into}`]))
const shadowCarried = (shadow: Shadow) => Object.fromEntries([...shadow.carried].map(([key, finding]) => [key, `${finding.batch}:${finding.into}`]))

describe("the machine against its reference model", () => {
  test(`${SEQUENCES} generated runs agree on every outcome and keep the invariants`, async () => {
    for (let seed = 1; seed <= SEQUENCES; seed++) {
      const random = rng(seed)
      const shadow: Shadow = { units: new Map(), verifier: undefined, covering: [], pending: new Set(), unresolved: new Set(), findings: new Map(), carried: new Map() }
      let state = M.initial
      let now = 1_800_000_000_000
      for (let step = 0; step < STEPS; step++) {
        now += Math.floor(random() * 20 * MIN)
        const next = command(random, shadow)
        const where = `seed ${seed} step ${step} ${JSON.stringify(next)}`
        const rules = broken(shadow, next, now)
        const departs = "departs" in next && next.departs !== undefined
        const outcome = await decide(state, next, now)
        // I6: an implementor's start is never refused.
        if (next._tag === "Start" && next.role === "implementor") expect([where, "events" in outcome]).toEqual([where, true])

        if (rules.length > 0 && !departs) {
          // Refused by the first rule it breaks, in the rule's own words; the state stays.
          expect([where, outcome]).toEqual([where, { refused: rules[0]!, message: expect.stringContaining(RULES[rules[0]!].words) }])
          // L2: the same command, stating a departure, passes and records each rule it broke.
          const again = await decide(state, { ...next, departs: "why" } as Command, now)
          expect([where, "events" in again]).toEqual([where, true])
          if ("events" in again)
            expect([where, again.events.filter((event) => event._tag === "Departed").map((event) => (event as { rule: Rule }).rule)]).toEqual([where, [...rules]])
          continue
        }
        expect([where, "events" in outcome]).toEqual([where, true])
        if (!("events" in outcome)) continue
        const departed = outcome.events.filter((event) => event._tag === "Departed").map((event) => (event as { rule: Rule }).rule)
        expect([where, departed]).toEqual([where, departs ? [...rules] : []])

        const readyBefore = inState(shadow, "ready")
        const pendingBefore = verdictDue(shadow)
        const coverBefore = coverOf(shadow)
        const unfoldedBefore = next._tag === "Land" ? [...unfolded(shadow, matched(shadow, next.rifts)), ...shadow.unresolved] : []
        apply(shadow, next, now)
        state = evolve(state, outcome.events)

        // The decider's state is the shadow's.
        const units = statesOf(state)
        expect([where, units]).toEqual([where, Object.fromEntries([...shadow.units].map(([name, unit]) => [name, unit.state]))])
        expect([where, state.verifier?.batch]).toEqual([where, shadow.verifier])
        expect([where, [...(state.unverified ?? [])].sort(), Object.keys(state.unresolved ?? {}).sort()]).toEqual([where, [...shadow.pending].sort(), [...shadow.unresolved].sort()])
        expect([where, findingsOf(state), carriedOf(state)]).toEqual([where, shadowFindings(shadow), shadowCarried(shadow)])
        // I5: a unit is in `verify` only while a verifier runs.
        if (state.verifier === undefined) expect([where, Object.values(units).includes("verify")]).toEqual([where, false])
        // I2: a verifier that starts with no departure names a batch and covers all that was ready or landed.
        const started = outcome.events.find((event) => event._tag === "VerifierStarted") as { batch: string; units: ReadonlyArray<string> } | undefined
        if (started !== undefined && departed.length === 0 && coverBefore.length > 0) {
          expect([where, BATCH.test(started.batch)]).toEqual([where, true])
          expect([where, [...started.units].sort()]).toEqual([where, [...coverBefore].sort()])
        }
        // I3, I4: a land that passes with no departure took every ready unit, with no verdict pending and every finding folded into it.
        if (next._tag === "Land" && departed.length === 0 && matched({ ...shadow }, next.rifts).length > 0) {
          expect([where, matched(shadow, next.rifts).sort()]).toEqual([where, [...readyBefore].sort()])
          expect([where, pendingBefore, unfoldedBefore]).toEqual([where, false, []])
        }
      }

      // L1: a compliant root is never stuck. The verdict comes in, each finding is folded into a unit that hands back ready, and every ready unit lands.
      const end = `seed ${seed} at its end`
      const step = async (next: Command) => {
        const done = await decide(state, next, now)
        expect([end, JSON.stringify(next), "events" in done]).toEqual([end, JSON.stringify(next), true])
        if ("events" in done) state = evolve(state, done.events)
      }
      if (state.verifier !== undefined) await step(HandBack.make({ role: "verifier", name: state.verifier.batch, verdict: "accepted" }))
      if ((state.unverified ?? []).length > 0 || Object.values(state.units).some((unit) => unit.state === "landed")) {
        await step(Start.make({ role: "verifier", name: "batch-9", round: 1, direct: false }))
        await step(HandBack.make({ role: "verifier", name: "batch-9", verdict: "accepted" }))
      }
      // A verdict whose report did not read: the report is made readable, and read again.
      for (const batch of Object.keys(state.unresolved ?? {})) await step(ReportRead.make({ batch, findings: [`fixer/${batch}`] }))
      const open = Object.keys(state.findings ?? {})
      if (open.length > 0) {
        await step(Start.make({ role: "implementor", name: "fixer", round: 1, direct: false, folds: open }))
        await step(HandBack.make({ role: "implementor", name: "fixer", verdict: "ready" }))
      }
      // Each finding folded into a unit still implementing lands when that unit hands back ready.
      for (const [name, unit] of Object.entries(state.units)) if (unit.state === "implement") await step(HandBack.make({ role: "implementor", name, verdict: "ready" }))
      const ready = Object.entries(state.units).filter(([, unit]) => unit.state === "ready").map(([name]) => name)
      if (ready.length > 0) {
        const land = await decide(state, Land.make({ rifts: ready }), now + CADENCE.waitMs)
        expect([end, land]).toEqual([end, { events: [] }])
      }
    }
  }, 120_000)
})

describe("the machine's stories", () => {
  const T0 = 1_800_000_000_000
  const run = async (steps: ReadonlyArray<readonly [Command, number]>) => {
    let state = M.initial
    let last: Outcome = { events: [] }
    for (const [next, at] of steps) {
      last = await decide(state, next, T0 + at)
      if ("events" in last) state = evolve(state, last.events)
    }
    return { state, last }
  }
  const impl = (name: string, round = 1) => Start.make({ role: "implementor", name, round, direct: false })
  const ready = (name: string) => HandBack.make({ role: "implementor", name, verdict: "ready" })

  test("the Mac root's habit: landing the one unit that just handed back, while two more implement, is refused with the cadence", async () => {
    const { last } = await run([[impl("alpha"), 0], [impl("beta"), 0], [impl("gamma"), 0], [ready("alpha"), 5 * MIN], [Land.make({ rifts: ["feat/alpha"] }), 6 * MIN]])
    expect(last).toMatchObject({ refused: "BatchNotDue" })
    if ("refused" in last) {
      expect(last.message).toContain(RULES.BatchNotDue.words)
      expect(last.message).toContain("alpha")
      expect(last.message).toContain("beta, gamma")
      expect(last.message).toContain("departs")
    }
  })

  test("the Bite root's habit: a verifier for one unit, while the root runs units, is refused with the batch rule", async () => {
    const { last } = await run([[impl("pr-21583", 11), 0], [ready("pr-21583"), MIN], [Start.make({ role: "verifier", name: "pr-21583", round: 11, direct: false }), 2 * MIN]])
    expect(last).toMatchObject({ refused: "VerifierPerUnit" })
    if ("refused" in last) expect(last.message).toContain("verifier batch-<k> r1")
  })

  test("a land that leaves a ready unit out names it", async () => {
    const { last } = await run([[impl("alpha"), 0], [impl("beta"), 0], [ready("alpha"), MIN], [ready("beta"), MIN], [Land.make({ rifts: ["alpha"] }), 2 * MIN]])
    expect(last).toMatchObject({ refused: "LandPartial" })
    if ("refused" in last) expect(last.message).toContain("beta")
  })

  test("a second land is refused until the first one's verdict is in: before its verifier starts, and while it runs", async () => {
    const first: ReadonlyArray<readonly [Command, number]> = [[impl("alpha"), 0], [ready("alpha"), MIN], [Land.make({ rifts: ["alpha"] }), 2 * MIN], [Landed.make({ rifts: ["alpha"] }), 3 * MIN], [impl("beta"), 4 * MIN], [ready("beta"), 5 * MIN]]
    expect((await run([...first, [Land.make({ rifts: ["beta"] }), 6 * MIN]])).last).toMatchObject({ refused: "VerdictPending" })
    const verifying: ReadonlyArray<readonly [Command, number]> = [...first, [Start.make({ role: "verifier", name: "batch-1", round: 1, direct: false }), 6 * MIN]]
    const running = await run([...verifying, [Land.make({ rifts: ["beta"] }), 7 * MIN]])
    expect(running.last).toMatchObject({ refused: "VerdictPending" })
    if ("refused" in running.last) expect(running.last.message).toContain("Verifier batch-1 still runs")
    const verdict = await run([...verifying, [HandBack.make({ role: "verifier", name: "batch-1", verdict: "accepted" }), 8 * MIN], [Land.make({ rifts: ["beta"] }), 9 * MIN]])
    expect(verdict.last).toEqual({ events: [] })
  })

  test("the pipeline: the next batch fans out while a verifier runs; the verdict folds into a running implementor and a new fix unit; the next batch lands and its verifier checks the folds", async () => {
    const verifier = (name: string) => Start.make({ role: "verifier", name, round: 1, direct: false })
    const steps: Array<readonly [Command, number]> = [
      [impl("auth"), 0],
      [impl("billing"), 0],
      [ready("auth"), MIN],
      [ready("billing"), MIN],
      [Land.make({ rifts: ["auth", "billing"] }), 2 * MIN],
      [Landed.make({ rifts: ["auth", "billing"] }), 2 * MIN],
      [verifier("batch-1"), 3 * MIN],
      // Batch 2 fans out while batch-1's verifier runs: no rule holds an implementor.
      [impl("search"), 4 * MIN],
      [impl("export"), 4 * MIN],
      [ready("search"), 5 * MIN],
    ]
    const fanned = await run(steps)
    expect("events" in fanned.last).toBe(true)
    expect(fanned.state.units.search?.state).toBe("ready")
    // A land while the verifier runs is refused: the verdict is not in.
    expect((await run([...steps, [Land.make({ rifts: ["search"] }), 6 * MIN]])).last).toMatchObject({ refused: "VerdictPending" })
    steps.push([HandBack.make({ role: "verifier", name: "batch-1", verdict: "changes", findings: ["auth/M1", "billing/M1"] }), 40 * MIN])
    // The verdict is in, its findings are not folded: refused, naming each.
    const unfolded = await run([...steps, [Land.make({ rifts: ["search"] }), 41 * MIN]])
    expect(unfolded.last).toMatchObject({ refused: "FindingUnfolded" })
    if ("refused" in unfolded.last) {
      expect(unfolded.last.message).toContain(RULES.FindingUnfolded.words)
      expect(unfolded.last.message).toContain("auth/M1 (not folded)")
      expect(unfolded.last.message).toContain('departs: "<why>"')
    }
    // auth/M1 goes to export's running implementor, as a round message; billing/M1 to a new fix unit.
    steps.push([Start.make({ role: "implementor", name: "export", round: 1, direct: false, folds: ["auth/M1"] }), 42 * MIN])
    steps.push([Start.make({ role: "implementor", name: "billing-fix1", round: 1, direct: false, folds: ["billing/M1"] }), 42 * MIN])
    const folded = await run(steps)
    expect(folded.state.findings).toEqual({ "auth/M1": { batch: "batch-1", into: "export" }, "billing/M1": { batch: "batch-1", into: "billing-fix1" } })
    expect(briefOf(folded.state, T0 + 43 * MIN, CADENCE)).toContain("next batch: units search (ready), export (implement), billing-fix1 (implement); folded findings: batch-1 auth/M1 → export, batch-1 billing/M1 → billing-fix1")
    // Folded into units still implementing: they hold no land; search lands alone, and both findings stay open, riding
    // with their units.
    expect((await run([...steps, [Land.make({ rifts: ["search"] }), 70 * MIN]])).last).toEqual({ events: [] })
    const alone = await run([...steps, [Land.make({ rifts: ["search"] }), 70 * MIN], [Landed.make({ rifts: ["search"] }), 70 * MIN]])
    expect(alone.last).toMatchObject({ events: [{ _tag: "BatchLanded", units: ["search"] }] })
    expect(alone.state.findings).toEqual({ "auth/M1": { batch: "batch-1", into: "export" }, "billing/M1": { batch: "batch-1", into: "billing-fix1" } })
    expect(alone.state.carried).toBeUndefined()
    steps.push([ready("export"), 50 * MIN], [ready("billing-fix1"), 51 * MIN])
    const landed = await run([...steps, [Land.make({ rifts: ["search", "export", "billing-fix1"] }), 52 * MIN], [Landed.make({ rifts: ["search", "export", "billing-fix1"] }), 52 * MIN]])
    expect(landed.last).toMatchObject({ events: [{ _tag: "BatchLanded" }] })
    expect(landed.state.findings).toBeUndefined()
    expect(landed.state.carried).toEqual({ "auth/M1": { batch: "batch-1", into: "export" }, "billing/M1": { batch: "batch-1", into: "billing-fix1" } })
    // Batch 2's one verifier covers its units and checks batch-1's findings as folded; its prompt names them.
    const start = verifier("batch-2")
    expect(notesOf(landed.state, start, T0 + 53 * MIN, CADENCE).join("\n")).toContain("auth/M1 → export, billing/M1 → billing-fix1")
    expect(verifierPromptOf(landed.state, start)).toContain("- batch-1 auth/M1 → export")
    const two = await decide(landed.state, start, T0 + 53 * MIN)
    expect(two).toEqual({ events: [expect.objectContaining({ _tag: "VerifierStarted", batch: "batch-2", units: ["search", "export", "billing-fix1"], findings: ["auth/M1 → export", "billing/M1 → billing-fix1"] })] })
    if ("events" in two) {
      const after = evolve(landed.state, two.events)
      expect(briefOf(after, T0 + 54 * MIN, CADENCE)).toContain("batch-2 verifying: search, export, billing-fix1; checks as folded: auth/M1 → export, billing/M1 → billing-fix1")
      const done = evolve(after, [{ _tag: "VerifierEnded", batch: "batch-2", verdict: "accepted", at: T0 + 60 * MIN }])
      expect(done).toEqual({ units: {} })
    }
  })

  test("a finding folded into a long redesign still implementing holds no land of three independent ready units; it rides with the redesign's later land, whose verifier is told it; one not folded, or folded into an ended unit, still holds the land", async () => {
    const verifier = (name: string) => Start.make({ role: "verifier", name, round: 1, direct: false })
    const steps: Array<readonly [Command, number]> = [
      [impl("redesign"), 0],
      [ready("redesign"), MIN],
      [Land.make({ rifts: ["redesign"] }), 2 * MIN],
      [Landed.make({ rifts: ["redesign"] }), 2 * MIN],
      [verifier("batch-1"), 3 * MIN],
      [HandBack.make({ role: "verifier", name: "batch-1", verdict: "changes", findings: ["redesign/M1"] }), 20 * MIN],
      [impl("a"), 21 * MIN],
      [impl("b"), 21 * MIN],
      [impl("c"), 21 * MIN],
      [ready("a"), 30 * MIN],
      [ready("b"), 30 * MIN],
      [ready("c"), 30 * MIN],
    ]
    // Not folded at all: the land is held.
    expect((await run([...steps, [Land.make({ rifts: ["a", "b", "c"] }), 31 * MIN]])).last).toMatchObject({ refused: "FindingUnfolded" })
    // Folded into the redesign's next round, still implementing: a, b and c land, with no departure.
    steps.push([impl("redesign", 2), 30 * MIN])
    const riding = await run(steps)
    expect(briefOf(riding.state, T0 + 31 * MIN, CADENCE)).toContain(
      "riding with a unit still implementing: batch-1 redesign/M1 → redesign (holds no land; each lands with its unit, and that land's verifier must name it as folded)",
    )
    expect(notesOf(riding.state, impl("d"), T0 + 31 * MIN, CADENCE).join("\n")).toContain("a batch is due (3 ready): a, b, c")
    expect((await run([...steps, [Land.make({ rifts: ["a", "b", "c"] }), 31 * MIN]])).last).toEqual({ events: [] })
    steps.push([Land.make({ rifts: ["a", "b", "c"] }), 31 * MIN], [Landed.make({ rifts: ["a", "b", "c"] }), 31 * MIN])
    const three = await run(steps)
    expect(three.last).toMatchObject({ events: [{ _tag: "BatchLanded", units: ["a", "b", "c"] }] })
    expect(three.state.findings).toEqual({ "redesign/M1": { batch: "batch-1", into: "redesign" } })
    // Batch 2's verifier checks a, b and c; the riding finding is not its.
    steps.push([verifier("batch-2"), 32 * MIN])
    const two = await run(steps)
    expect(two.last).toEqual({ events: [expect.not.objectContaining({ findings: expect.anything() })] })
    steps.push([HandBack.make({ role: "verifier", name: "batch-2", verdict: "accepted" }), 40 * MIN])
    // The redesign hands back and lands; its batch's verifier is told the finding, in its prompt.
    steps.push([ready("redesign"), 90 * MIN], [Land.make({ rifts: ["redesign"] }), 91 * MIN], [Landed.make({ rifts: ["redesign"] }), 91 * MIN])
    const later = await run(steps)
    expect(later.state.carried).toEqual({ "redesign/M1": { batch: "batch-1", into: "redesign" } })
    expect(verifierPromptOf(later.state, verifier("batch-3"))).toContain("- batch-1 redesign/M1 → redesign")
    expect(await decide(later.state, verifier("batch-3"), T0 + 92 * MIN)).toEqual({
      events: [expect.objectContaining({ _tag: "VerifierStarted", batch: "batch-3", units: ["redesign"], findings: ["redesign/M1 → redesign"] })],
    })
    // Folded into a unit whose implementor ended without ready: it rides with nothing, and holds the land.
    const ended = await run([
      ...steps.slice(0, 12),
      [impl("redesign", 2), 30 * MIN],
      [HandBack.make({ role: "implementor", name: "redesign", verdict: "blocked" }), 25 * MIN],
      [Land.make({ rifts: ["a", "b", "c"] }), 31 * MIN],
    ])
    expect(ended.last).toMatchObject({ refused: "FindingUnfolded" })
    if ("refused" in ended.last) expect(ended.last.message).toContain("redesign/M1 → redesign")
  })

  test("a unit's own next round folds its findings by itself; a fold naming no open finding is said, not refused", async () => {
    const steps: ReadonlyArray<readonly [Command, number]> = [
      [impl("auth"), 0],
      [ready("auth"), MIN],
      [Landed.make({ rifts: ["auth"] }), 2 * MIN],
      [Start.make({ role: "verifier", name: "batch-1", round: 1, direct: false }), 3 * MIN],
      [HandBack.make({ role: "verifier", name: "batch-1", verdict: "changes", findings: ["auth/B1", "auth/M2"] }), 4 * MIN],
    ]
    const { state } = await run(steps)
    const next = impl("auth", 2)
    expect(notesOf(state, next, T0 + 5 * MIN, CADENCE).join("\n")).toContain("folded into auth: auth/B1, auth/M2")
    expect((await run([...steps, [next, 5 * MIN]])).state.findings).toEqual({ "auth/B1": { batch: "batch-1", into: "auth" }, "auth/M2": { batch: "batch-1", into: "auth" } })
    const stray = Start.make({ role: "implementor", name: "search", round: 1, direct: false, folds: ["auth/M9"] })
    expect(notesOf(state, stray, T0 + 5 * MIN, CADENCE).join("\n")).toContain("no open finding is named auth/M9")
    expect(notesOf(state, stray, T0 + 5 * MIN, CADENCE).join("\n")).toContain("not folded yet: auth/B1, auth/M2")
  })

  test("a land that departs with a finding unfolded passes, and the finding goes with the departure", async () => {
    const { state, last } = await run([
      [impl("auth"), 0],
      [ready("auth"), MIN],
      [Landed.make({ rifts: ["auth"] }), 2 * MIN],
      [Start.make({ role: "verifier", name: "batch-1", round: 1, direct: false }), 3 * MIN],
      [HandBack.make({ role: "verifier", name: "batch-1", verdict: "changes", findings: ["auth/M1"] }), 4 * MIN],
      [impl("search"), 5 * MIN],
      [ready("search"), 6 * MIN],
      [Land.make({ rifts: ["search"], departs: "the owner takes auth/M1 as a known limit" }), 7 * MIN],
      [Landed.make({ rifts: ["search"] }), 8 * MIN],
    ])
    expect(last).toMatchObject({ events: [{ _tag: "BatchLanded" }] })
    expect(state.findings).toBeUndefined()
    const departed = await run([[impl("auth"), 0], [ready("auth"), MIN], [Landed.make({ rifts: ["auth"] }), 2 * MIN], [Start.make({ role: "verifier", name: "batch-1", round: 1, direct: false }), 3 * MIN], [HandBack.make({ role: "verifier", name: "batch-1", verdict: "changes", findings: ["auth/M1"] }), 4 * MIN], [impl("search"), 5 * MIN], [ready("search"), 6 * MIN], [Land.make({ rifts: ["search"], departs: "known limit" }), 7 * MIN]])
    expect(departed.last).toEqual({ events: [expect.objectContaining({ _tag: "Departed", rule: "FindingUnfolded", why: "known limit" })] })
  })

  // Round 1, M2 (the verifier's property, promoted): the pending verdict is the batch's and its verifier's, not
  // a unit slot's. Its oracle is independent of the machine's state: a verdict is pending from the land until the
  // verifier hands back, whatever the covered units do meanwhile.
  test("every restart subset of a landed batch's 1–3 units, before its verifier starts or while it runs, leaves the verdict pending; the verdict lets the next land through and keeps the later rounds", async () => {
    const violations: Array<unknown> = []
    let cases = 0
    for (const phase of ["landed", "verifying"] as const)
      for (let size = 1; size <= 3; size++)
        for (let mask = 1; mask < 1 << size; mask++)
          for (const other of [false, true]) {
            cases++
            const covered = Array.from({ length: size }, (_, i) => `unit-${i}`)
            const restarted = covered.filter((_, i) => mask & (1 << i))
            const steps: Array<readonly [Command, number]> = []
            for (const name of covered) steps.push([impl(name), 0], [ready(name), MIN])
            steps.push([Land.make({ rifts: covered }), 2 * MIN], [Landed.make({ rifts: covered }), 2 * MIN])
            if (phase === "verifying") steps.push([Start.make({ role: "verifier", name: "batch-1", round: 1, direct: false }), 3 * MIN])
            // The next round of each restarted unit hands back ready; a distinct unit of the next batch too, now and then.
            for (const name of [...restarted, ...(other ? ["fresh"] : [])]) steps.push([impl(name, 2), 4 * MIN], [ready(name), 5 * MIN])
            const lands = [...restarted, ...(other ? ["fresh"] : [])]
            const where = { phase, size, mask, other }
            const pending = await run([...steps, [Land.make({ rifts: lands }), 6 * MIN]])
            if (!("refused" in pending.last) || pending.last.refused !== "VerdictPending") violations.push({ ...where, outcome: pending.last })
            // The verdict comes in (the verifier started now, when it had not yet): the land passes, and no later round was taken out by name.
            const verdict: Array<readonly [Command, number]> = [
              ...steps,
              ...(phase === "landed" ? [[Start.make({ role: "verifier", name: "batch-1", round: 1, direct: false }), 6 * MIN] as const] : []),
              [HandBack.make({ role: "verifier", name: "batch-1", verdict: "accepted" }), 7 * MIN],
            ]
            const after = await run(verdict)
            if (lands.some((name) => after.state.units[name]?.state !== "ready")) violations.push({ ...where, lost: after.state.units })
            const passed = await run([...verdict, [Land.make({ rifts: lands }), 8 * MIN]])
            if (!("events" in passed.last)) violations.push({ ...where, after: passed.last })
          }
    expect(cases).toBe(44)
    expect(violations).toEqual([])
  })

  test("a checkpoint from before the verifier kept its cover still holds the land while its verifier runs and its units restart", async () => {
    const old: MachineState = { units: { auth: { state: "verify", round: 1, since: T0, direct: false } }, verifier: { batch: "batch-1", since: T0 } }
    const restarted = evolve(old, [
      { _tag: "UnitStarted", unit: "auth", round: 2, direct: false, at: T0 + MIN },
      { _tag: "UnitHandedBack", unit: "auth", ready: true, at: T0 + 2 * MIN },
    ])
    expect(await decide(restarted, Land.make({ rifts: ["auth"] }), T0 + 3 * MIN)).toMatchObject({ refused: "VerdictPending" })
    const died = evolve(restarted, [{ _tag: "VerifierEnded", batch: "batch-1", verdict: "none", at: T0 + 4 * MIN }])
    expect(await decide(died, Land.make({ rifts: ["auth"] }), T0 + 5 * MIN)).toMatchObject({ refused: "VerdictPending" })
  })

  // Round 1, M1: a `changes` whose report did not read is unresolved, never an empty set of findings.
  test("a changes verdict whose report did not read holds the next land until the report reads and its findings fold, or the land departs", async () => {
    const landed: ReadonlyArray<readonly [Command, number]> = [
      [impl("auth"), 0],
      [ready("auth"), MIN],
      [Landed.make({ rifts: ["auth"] }), 2 * MIN],
      [Start.make({ role: "verifier", name: "batch-1", round: 1, direct: false }), 3 * MIN],
    ]
    const unread = { report: "/nonexistent/loop-probe-x/missing-findings.md", why: "the report /nonexistent/loop-probe-x/missing-findings.md does not read" }
    const steps: Array<readonly [Command, number]> = [
      ...landed,
      [HandBack.make({ role: "verifier", name: "batch-1", verdict: "changes", unread }), 4 * MIN],
      [impl("search"), 5 * MIN],
      [ready("search"), 6 * MIN],
    ]
    const held = await run([...steps, [Land.make({ rifts: ["search"] }), 7 * MIN]])
    expect(held.state.unresolved).toEqual({ "batch-1": unread })
    expect(held.last).toMatchObject({ refused: "FindingUnfolded" })
    if ("refused" in held.last) {
      expect(held.last.message).toContain("The findings of batch-1's `changes` are not known")
      expect(held.last.message).toContain("Read its report at /nonexistent/loop-probe-x/missing-findings.md")
      expect(held.last.message).toContain('departs: "<why>"')
    }
    expect(briefOf(held.state, T0 + 7 * MIN, CADENCE)).toContain("findings not known: batch-1 changes")
    expect(notesOf(held.state, impl("export"), T0 + 7 * MIN, CADENCE).join("\n")).toContain("the findings of batch-1's changes are not known")
    // A `changes` that names no report at all is unresolved the same way.
    const unnamed = await run([...landed, [HandBack.make({ role: "verifier", name: "batch-1", verdict: "changes" }), 4 * MIN]])
    expect(unnamed.state.unresolved?.["batch-1"]?.report).toBeUndefined()
    expect(Object.keys(unnamed.state.unresolved ?? {})).toEqual(["batch-1"])
    // A report read to no finding at all is resolved: nothing holds the land.
    const empty = await run([...landed, [HandBack.make({ role: "verifier", name: "batch-1", verdict: "changes", findings: [] }), 4 * MIN], [impl("search"), 5 * MIN], [ready("search"), 6 * MIN], [Land.make({ rifts: ["search"] }), 7 * MIN]])
    expect(empty.last).toEqual({ events: [] })
    // Recovery: the report reads at last; its finding opens, folds into search's next round, and the land passes.
    const read = await run([...steps, [ReportRead.make({ batch: "batch-1", findings: ["auth/M1"] }), 8 * MIN]])
    expect(read.last).toMatchObject({ events: [{ _tag: "ReportResolved", batch: "batch-1", findings: ["auth/M1"] }] })
    expect(read.state.unresolved).toBeUndefined()
    expect(read.state.findings).toEqual({ "auth/M1": { batch: "batch-1" } })
    const folded = await run([
      ...steps,
      [ReportRead.make({ batch: "batch-1", findings: ["auth/M1"] }), 8 * MIN],
      [Start.make({ role: "implementor", name: "search", round: 2, direct: false, folds: ["auth/M1"] }), 9 * MIN],
      [ready("search"), 10 * MIN],
      [Land.make({ rifts: ["search"] }), 11 * MIN],
    ])
    expect(folded.last).toEqual({ events: [] })
    // A report read again for no unresolved verdict changes nothing.
    expect((await run([...landed, [ReportRead.make({ batch: "batch-1", findings: ["auth/M1"] }), 4 * MIN]])).last).toEqual({ events: [] })
    // Or the land departs: it passes, says so, and the debt goes with it.
    const departed = await run([...steps, [Land.make({ rifts: ["search"], departs: "the owner reads batch-1's report himself" }), 7 * MIN], [Landed.make({ rifts: ["search"] }), 8 * MIN]])
    expect(departed.state.unresolved).toBeUndefined()
    const decided = await run([...steps, [Land.make({ rifts: ["search"], departs: "why" }), 7 * MIN]])
    expect(decided.last).toEqual({ events: [expect.objectContaining({ _tag: "Departed", rule: "FindingUnfolded" })] })
  })

  test("a pilot alone, three ready, and the oldest's thirty minutes all pass; a direct unit closes at its land", async () => {
    expect((await run([[impl("pilot"), 0], [ready("pilot"), MIN], [Land.make({ rifts: ["pilot"] }), 2 * MIN]])).last).toEqual({ events: [] })
    const three = [[impl("a1"), 0], [impl("b1"), 0], [impl("c1"), 0], [impl("d1"), 0], [ready("a1"), MIN], [ready("b1"), MIN], [ready("c1"), MIN]] as const
    expect((await run([...three, [Land.make({ rifts: ["a1", "b1", "c1"] }), 2 * MIN]])).last).toEqual({ events: [] })
    expect((await run([[impl("alpha"), 0], [impl("beta"), 0], [ready("alpha"), MIN], [Land.make({ rifts: ["alpha"] }), 31 * MIN]])).last).toEqual({ events: [] })
    const direct = await run([[Start.make({ role: "implementor", name: "docs", round: 1, direct: true }), 0], [ready("docs"), MIN], [Landed.make({ rifts: ["docs"] }), 2 * MIN]])
    expect(direct.state.units).toEqual({})
  })

  test("a root that runs no units is left alone: its verifier, by any name, starts", async () => {
    expect((await run([[Start.make({ role: "verifier", name: "review-of-pr", round: 1, direct: false }), 0]])).last).toEqual({ events: [] })
  })

  test("a Rift is its unit's by the unit the land names, its branch, else its own name; anything else is no unit", () => {
    // By name, branch, workrift's Rift name or path: the last segment, by the name rule.
    expect(unitOfEntry("auth", ["auth", "web"])).toBe("auth")
    expect(unitOfEntry("feat/auth", ["auth", "web"])).toBe("auth")
    expect(unitOfEntry("p5/auth", ["auth", "web"])).toBe("auth")
    expect(unitOfEntry("feat-auth", ["auth", "web"])).toBe("auth")
    expect(unitOfEntry("/home/me/.rifts/repo/auth/", ["auth"])).toBe("auth")
    // A later round's numbered Rift or branch is its unit's, unless the full name is a unit.
    expect(unitOfEntry("reset-use-3", ["reset-use", "land-upstream"])).toBe("reset-use")
    expect(unitOfEntry("feat/land-upstream-2", ["reset-use", "land-upstream"])).toBe("land-upstream")
    expect(unitOfEntry("/u/.rifts/dotfiles/land-upstream-2", ["reset-use", "land-upstream"])).toBe("land-upstream")
    expect(unitOfEntry("auth-2", ["auth", "auth-2"])).toBe("auth-2")
    expect(unitOfEntry("fix-auth", ["auth", "fix-auth"])).toBe("fix-auth")
    // Unknown is none: another prefix, another word, a suffix that is no round.
    expect(unitOfEntry("wf10-auth", ["auth"])).toBeUndefined()
    expect(unitOfEntry("fix-auth", ["auth"])).toBeUndefined()
    expect(unitOfEntry("author", ["auth"])).toBeUndefined()
    expect(unitOfEntry("auth-2x", ["auth"])).toBeUndefined()
    // Two readings naming two units: none, never a guess.
    expect(unitOfName("feat-web-2", ["web-2", "feat-web"])).toBeUndefined()
    expect(unitOfName("feat-web-2", ["web", "feat-web"])).toBeUndefined()
    expect(unitOfName("feat-web", ["web", "feat-web"])).toBe("feat-web")
    // The branch read from the Rift decides, whatever the Rift is called; a branch of no unit is none.
    expect(unitOfEntry({ rift: "/u/.rifts/app/scratch-17", branch: "feat/web-3" }, ["api", "web"])).toBe("web")
    expect(unitOfEntry({ rift: "/u/.rifts/app/api", branch: "feat/web" }, ["api", "web"])).toBe("web")
    expect(unitOfEntry({ rift: "/u/.rifts/app/web", branch: "integrate" }, ["api", "web"])).toBeUndefined()
    // The unit the land names is the unit, when it is one.
    expect(unitOfEntry({ rift: "/u/.rifts/app/scratch", unit: "web" }, ["api", "web"])).toBe("web")
    expect(unitOfEntry({ rift: "/u/.rifts/app/web", unit: "nope" }, ["api", "web"])).toBeUndefined()
  })

  test("a later round in a Rift of another name lands as its unit by its branch or the unit the land names; one it cannot place is no unit's, and the land is partial", async () => {
    const verifier = (name: string) => Start.make({ role: "verifier", name, round: 1, direct: false })
    const steps: Array<readonly [Command, number]> = [
      [impl("reset-use", 2), 0],
      [impl("land-upstream"), 0],
      [ready("reset-use"), MIN],
      [ready("land-upstream"), MIN],
      [Land.make({ rifts: ["reset-use", "land-upstream"] }), 2 * MIN],
      [Landed.make({ rifts: ["reset-use", "land-upstream"] }), 2 * MIN],
      [verifier("batch-f"), 3 * MIN],
      [HandBack.make({ role: "verifier", name: "batch-f", verdict: "changes", findings: ["reset-use/B1", "reset-use/M1", "land-upstream/M1"] }), 40 * MIN],
      [impl("reset-use", 4), 41 * MIN],
      [impl("land-upstream", 2), 41 * MIN],
      [ready("reset-use"), 50 * MIN],
      [ready("land-upstream"), 50 * MIN],
    ]
    const own = [
      { rift: "/u/.rifts/dotfiles/scratch-17", branch: "feat/reset-use-4" },
      { rift: "/u/.rifts/dotfiles/lu-second-try", unit: "land-upstream" },
    ]
    const landed = await run([...steps, [Land.make({ rifts: own }), 51 * MIN], [Landed.make({ rifts: own }), 51 * MIN]])
    expect(landed.last).toEqual({ events: [expect.objectContaining({ _tag: "BatchLanded", units: ["reset-use", "land-upstream"] })] })
    // By names alone: `lu-second-try` is no unit's, never reset-use's or another's, so the land leaves land-upstream out.
    const partial = await run([...steps, [Land.make({ rifts: ["reset-use-3", "lu-second-try"], departs: "probe" }), 51 * MIN]])
    expect(partial.last).toEqual({ events: ["FindingUnfolded", "LandPartial"].map((rule) => expect.objectContaining({ _tag: "Departed", rule })) })
    const refused = await run([...steps, [Land.make({ rifts: ["reset-use-3", { rift: "/u/.rifts/dotfiles/lu", unit: "nope" }] }), 51 * MIN]])
    expect("refused" in refused.last && refused.last.message).toContain('rifts: ["reset-use-3", { path: "/u/.rifts/dotfiles/lu", unit: "nope" }], departs')
  })

  test("property: over arbitrary unit names and numbered rounds, a land's entry is its own unit's, an exact name's, or none; with no name another's extension, always its own", async () => {
    const random = rng(1112)
    const pick = <A,>(list: ReadonlyArray<A>): A => list[Math.floor(random() * list.length)]!
    // Names from a tiny alphabet, with numbered and `feat-` parts, so names collide: `a`, `a-2`, `feat-a`, `a-b`.
    const name = () =>
      [random() < 0.15 ? "feat" : undefined, ...Array.from({ length: 1 + Math.floor(random() * 3) }, () => (random() < 0.2 ? String(2 + Math.floor(random() * 4)) : pick(["a", "b", "ab"])))]
        .filter((part) => part !== undefined)
        .join("-")
    const extends_ = (longer: string, shorter: string) => longer.startsWith(`feat-${shorter}`) || new RegExp(`^${shorter.replace(/[^a-z0-9]/g, "\\$&")}-\\d+$`).test(longer)
    let independentTrials = 0
    for (let trial = 0; trial < 400; trial++) {
      const units = [...new Set(Array.from({ length: 1 + Math.floor(random() * 5) }, name))].filter((unit) => !/^\d|-\d+$/.test(unit) || random() < 0.5)
      if (units.length === 0) continue
      const independent = units.every((u) => !u.startsWith("feat-") && units.every((v) => u === v || !extends_(v, u)))
      if (independent) independentTrials++
      for (const unit of units) {
        const round = 2 + Math.floor(random() * 11)
        const other = pick(units)
        const forms: ReadonlyArray<LandTarget> = [
          unit,
          `feat/${unit}`,
          `p5/${unit}`,
          `/h/.rifts/r/${unit}`,
          `${unit}-${round}`,
          `feat/${unit}-${round}`,
          `feat-${unit}`,
          `feat-${unit}-${round}`,
          `/h/.rifts/r/${unit}-${round}`,
          { rift: `/h/.rifts/r/scratch-${round}`, branch: `feat/${unit}-${round}` },
          // A Rift called for another unit, on this unit's branch: the branch decides.
          { rift: `/h/.rifts/r/${other}`, branch: `feat/${unit}` },
          { rift: `/h/.rifts/r/${other}-${round}`, unit },
        ]
        for (const form of forms) {
          const got = unitOfEntry(form, units)
          const read = typeof form === "string" ? form.split("/").at(-1)! : form.unit === undefined ? form.branch!.split("/").at(-1)! : undefined
          const where = JSON.stringify([trial, units, unit, form])
          // A name that is exactly another unit's is that unit's; else never a unit it does not spell exactly
          // (itself, or as workrift's `feat-<name>`): its own, or none.
          const spelled = read === undefined ? [] : [read, ...(read.startsWith("feat-") ? [read.slice("feat-".length)] : [])]
          if (read !== undefined && read !== unit && units.includes(read)) expect([where, got]).toEqual([where, read])
          else expect([where, got === unit || got === undefined || spelled.includes(got) ? "own, spelled or none" : got]).toEqual([where, "own, spelled or none"])
          if (independent) expect([where, got]).toEqual([where, unit])
        }
      }
      if (!independent) continue
      // Through the machine: every unit ready, landed by Rifts in any form, is one batch of exactly them.
      const steps: Array<readonly [Command, number]> = units.flatMap((unit) => [[impl(unit, 1 + Math.floor(random() * 4)), 0] as const, [ready(unit), MIN] as const])
      const rifts = units.map((unit) => riftFor(unit, Math.floor(random() * 7)))
      const landed = await run([...steps, [Land.make({ rifts }), 31 * MIN], [Landed.make({ rifts }), 31 * MIN]])
      const batch = "events" in landed.last ? landed.last.events.map((event) => (event._tag === "BatchLanded" ? [...event.units].sort() : event._tag)) : landed.last
      expect([trial, rifts, batch]).toEqual([trial, rifts, [[...units].sort()]])
    }
    expect(independentTrials).toBeGreaterThan(50)
  })

  test("the notes ride on a start's answer: a due batch, a landed batch with no verifier, a fourth round", async () => {
    const due = await run([[impl("a1"), 0], [impl("b1"), 0], [impl("c1"), 0], [ready("a1"), MIN], [ready("b1"), MIN], [ready("c1"), MIN]])
    const batchDue = notesOf(due.state, impl("d1"), T0 + 2 * MIN, CADENCE).join("\n")
    expect(batchDue).toContain("a batch is due (3 ready): a1, b1, c1")
    const landed = await run([[impl("alpha"), 0], [ready("alpha"), MIN], [Landed.make({ rifts: ["alpha"] }), 2 * MIN]])
    expect(notesOf(landed.state, impl("beta"), T0 + 3 * MIN, CADENCE).join("\n")).toContain("landed and not verified: alpha")
    expect(notesOf(M.initial, impl("alpha", 4), T0, CADENCE).join("\n")).toContain("round 4 of alpha")
    expect(notesOf(M.initial, impl("alpha", 2), T0, CADENCE)).toEqual([])
  })

  test("a call reads as its step: the role it runs as, its unit or batch, its round, (direct) and (departs: …)", () => {
    expect(startOf("verifier", "verifier batch-2 r1")).toEqual(Start.make({ role: "verifier", name: "batch-2", round: 1, direct: false }))
    expect(startOf("implementor", "implementor docs r3 (direct)")).toEqual(Start.make({ role: "implementor", name: "docs", round: 3, direct: true }))
    expect(startOf("verifier", "verifier alpha r1 (departs: the owner asked for alpha alone)")).toEqual(
      Start.make({ role: "verifier", name: "alpha", round: 1, direct: false, departs: "the owner asked for alpha alone" }),
    )
    expect(startOf("verifier", "alpha verifier r2 (departs: owner)")).toMatchObject({ name: "alpha", round: 2, departs: "owner" })
    expect(startOf("implementor", "verifier alpha r1")).toBeUndefined()
    expect(startOf("worker", "Fix the verifier's timeout")).toBeUndefined()
    expect(handBackOf("verifier", "**verifier batch-1 r1: accepted** /tmp/run/batch-1-findings.md")).toEqual(HandBack.make({ role: "verifier", name: "batch-1", verdict: "accepted" }))
    expect(handBackOf("implementor", "implementor alpha r2: ready /u/round-2-request.md")).toMatchObject({ verdict: "ready" })
    expect(handBackOf("implementor", "verifier alpha r2: accepted x")).toBeUndefined()
    expect(startOf("implementor", "implementor billing r1 (folds: auth/M2, search) (departs: owner)")).toEqual(
      Start.make({ role: "implementor", name: "billing", round: 1, direct: false, folds: ["auth/M2", "search"], departs: "owner" }),
    )
    expect(reportOf("**verifier batch-1 r1: changes** `/tmp/run/batch-1-findings.md`.")).toBe("/tmp/run/batch-1-findings.md")
    expect(reportOf("verifier batch-1 r1: accepted, see notes")).toBeUndefined()
    expect(reportOf("not a hand-back /tmp/x.md")).toBeUndefined()
  })

  test("a step's session is kept until its hand-back, and a refusal says how to depart", async () => {
    const { state } = await run([[impl("alpha"), 0], [Spawned.make({ role: "implementor", name: "alpha", child: "ses_a" }), 0]])
    expect(state.units.alpha?.child).toBe("ses_a")
    const back = await run([[impl("alpha"), 0], [Spawned.make({ role: "implementor", name: "alpha", child: "ses_a" }), 0], [ready("alpha"), MIN]])
    expect(back.state.units.alpha?.child).toBeUndefined()
    const land = await run([[impl("alpha"), 0], [impl("beta"), 0], [ready("alpha"), MIN], [Land.make({ rifts: ["alpha"] }), 2 * MIN]])
    if ("refused" in land.last) expect(land.last.message).toContain('departs: "<why>"')
  })

  test("the brief a compacted root gets names every unit by its state, what runs and what is due", async () => {
    const { state } = await run([[impl("a1"), 0], [impl("b1"), 0], [impl("c1"), 0], [impl("d1"), 0], [ready("a1"), MIN], [ready("b1"), 2 * MIN], [ready("c1"), 3 * MIN]])
    const brief = briefOf(state, T0 + 10 * MIN, CADENCE)
    expect(brief).toContain("implement: d1")
    expect(brief).toContain("ready: a1 (9 min), b1 (8 min), c1 (7 min)")
    expect(brief).toContain("a batch is due (3 ready)")
    expect(briefOf(M.initial, T0, CADENCE)).toBe("")
  })
})
