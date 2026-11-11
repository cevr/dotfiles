// The batch machine one root runs, as the plugin's ledger decides it
// (machine.ts): a model-based test. A small reference model of the skill's
// machine (the shadow below: sets of units by state, and whether a verifier
// runs) and the Machine decider take the same generated command sequences;
// each step must agree on the outcome (accepted, or refused by which rule),
// and the invariants are checked on every state the decider reaches:
//
//   I1  never two verifiers at once, unless the start departed from it;
//   I2  a verifier that starts without a departure names a batch, and covers
//       every landed unit (with none landed, every ready one: a land by hand);
//   I3  a land that passes without a departure names every ready unit, and
//       comes only when the cadence is met or no implementor is running;
//   I4  no land passes while an earlier land is unverified, unless it departed;
//   I5  a unit is in `verify` only while a verifier runs;
//   L1  the guard never deadlocks a compliant root: once the oldest ready unit
//       has waited the cadence's time, landing every ready unit passes (after
//       a verifier start for what is landed), and a batch verifier start
//       passes whenever none runs and something is landed;
//   L2  every refused command passes when it states a departure, and records
//       it under the rule it broke.
//
// Then the stories of the audited roots, the notes that ride on a start's
// answer, and the brief a compacted root gets. That each rule's words are the
// skill's own is git/machine-words.test.ts (this folder's root files read no
// file).
import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import {
  briefOf,
  type Cadence,
  type Command,
  type Event,
  HandBack,
  Land,
  Landed,
  machine,
  type MachineState,
  notesOf,
  type Rule,
  RULES,
  Start,
  unitOfRift,
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
}
const BATCH = /^batch-/
const inState = (shadow: Shadow, ...states: ReadonlyArray<ShadowState>) => [...shadow.units].filter(([, unit]) => states.includes(unit.state)).map(([name]) => name)
const matched = (shadow: Shadow, rifts: ReadonlyArray<string>) => {
  const ready = inState(shadow, "ready")
  return ready.filter((unit) => rifts.some((rift) => unitOfRift(rift, [...shadow.units.keys()]) === unit))
}
/**
 * What a batch verifier covers: what is landed; with nothing landed (a land by hand, which the plugin does not
 * see), what is ready, so its start stands for their land.
 */
const coverOf = (shadow: Shadow) => (inState(shadow, "landed").length > 0 ? inState(shadow, "landed") : inState(shadow, "ready"))
/** The cadence is not met and an implementor still runs: waiting is what the machine says. */
const notDue = (shadow: Shadow, now: number) => {
  const ready = inState(shadow, "ready")
  if (ready.length === 0 || ready.length >= CADENCE.ready) return false
  const oldest = Math.min(...ready.map((unit) => shadow.units.get(unit)!.since))
  return now - oldest < CADENCE.waitMs && inState(shadow, "implement").length > 0
}
/** The rules `command` breaks on `shadow`, in the order they are checked. */
const broken = (shadow: Shadow, command: Command, now: number): ReadonlyArray<Rule> => {
  if (command._tag === "Start" && command.role === "verifier") {
    const rules: Array<Rule> = []
    if (!BATCH.test(command.name) && shadow.units.size > 0) rules.push("VerifierPerUnit")
    if (shadow.verifier !== undefined) rules.push("VerifierRunning")
    if (inState(shadow, "landed").length === 0 && notDue(shadow, now)) rules.push("BatchNotDue")
    return rules
  }
  if (command._tag === "Land") {
    const lands = matched(shadow, command.rifts)
    if (lands.length === 0) return []
    const rules: Array<Rule> = []
    if (inState(shadow, "landed").length > 0 && shadow.verifier === undefined) rules.push("BatchUnverified")
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
      if (command.role === "implementor") shadow.units.set(command.name, { state: "implement", since: now, direct: command.direct })
      if (command.role !== "verifier") return
      if (!BATCH.test(command.name) && shadow.units.size === 0) return
      const named = shadow.units.get(command.name)
      const cover = !BATCH.test(command.name) && named !== undefined && (named.state === "ready" || named.state === "landed") ? [command.name] : coverOf(shadow)
      for (const unit of cover) shadow.units.set(unit, { ...shadow.units.get(unit)!, state: "verify", since: now })
      shadow.verifier = command.name
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
      return
    }
    case "Land":
      return
    case "Landed":
      for (const unit of matched(shadow, command.rifts)) {
        if (shadow.units.get(unit)!.direct) shadow.units.delete(unit)
        else shadow.units.set(unit, { ...shadow.units.get(unit)!, state: "landed", since: now })
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
const riftFor = (unit: string, pick: number) => [unit, `feat/${unit}`, `/home/me/.rifts/repo/${unit}`, `run-${unit}`][pick % 4]!

const command = (random: () => number, shadow: Shadow): Command => {
  const pick = <A>(list: ReadonlyArray<A>): A => list[Math.floor(random() * list.length)]!
  const departs = random() < 0.08 ? { departs: "the owner asked for this one alone" } : {}
  const roll = random()
  if (roll < 0.3) return Start.make({ role: "implementor", name: pick(UNITS), round: 1 + Math.floor(random() * 5), direct: random() < 0.1 })
  if (roll < 0.55) return HandBack.make({ role: "implementor", name: pick(UNITS), verdict: pick(["ready", "ready", "ready", "blocked", "none"] as const) })
  if (roll < 0.68) {
    const name = random() < 0.7 ? `batch-${1 + Math.floor(random() * 3)}` : pick(UNITS)
    return Start.make({ role: "verifier", name, round: 1, direct: false, ...departs })
  }
  if (roll < 0.78) return HandBack.make({ role: "verifier", name: shadow.verifier ?? "batch-1", verdict: pick(["accepted", "changes", "stuck", "none"] as const) })
  const ready = inState(shadow, "ready")
  // Mostly the whole ready set, sometimes a part of it or a Rift that is no unit's.
  const some = ready.filter(() => random() < 0.8)
  const rifts = [...(random() < 0.6 ? ready : some).map((unit) => riftFor(unit, Math.floor(random() * 4))), ...(random() < 0.1 ? ["scratch"] : [])]
  if (roll < 0.92) return Land.make({ rifts, ...departs })
  return Landed.make({ rifts })
}

const SEQUENCES = 1500
const STEPS = 45

describe("the machine against its reference model", () => {
  test(`${SEQUENCES} generated runs agree on every outcome and keep the invariants`, async () => {
    for (let seed = 1; seed <= SEQUENCES; seed++) {
      const random = rng(seed)
      const shadow: Shadow = { units: new Map(), verifier: undefined }
      let state = M.initial
      let now = 1_800_000_000_000
      for (let step = 0; step < STEPS; step++) {
        now += Math.floor(random() * 20 * MIN)
        const next = command(random, shadow)
        const where = `seed ${seed} step ${step} ${JSON.stringify(next)}`
        const rules = broken(shadow, next, now)
        const departs = "departs" in next && next.departs !== undefined
        const outcome = await decide(state, next, now)

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
        const landedBefore = inState(shadow, "landed")
        apply(shadow, next, now)
        state = evolve(state, outcome.events)

        // The decider's state is the shadow's.
        const units = Object.fromEntries(Object.entries(state.units).map(([name, unit]) => [name, unit.state]))
        expect([where, units]).toEqual([where, Object.fromEntries([...shadow.units].map(([name, unit]) => [name, unit.state]))])
        expect([where, state.verifier?.batch]).toEqual([where, shadow.verifier])
        // I5: a unit is in `verify` only while a verifier runs.
        if (state.verifier === undefined) expect([where, Object.values(units).includes("verify")]).toEqual([where, false])
        // I2: a verifier that starts with no departure names a batch and covers all that was ready or landed.
        const started = outcome.events.find((event) => event._tag === "VerifierStarted") as { batch: string; units: ReadonlyArray<string> } | undefined
        if (started !== undefined && departed.length === 0 && (readyBefore.length > 0 || landedBefore.length > 0)) {
          expect([where, BATCH.test(started.batch)]).toEqual([where, true])
          expect([where, [...started.units].sort()]).toEqual([where, [...(landedBefore.length > 0 ? landedBefore : readyBefore)].sort()])
        }
        // I3, I4: a land that passes with no departure took every ready unit, with nothing landed left unverified.
        if (next._tag === "Land" && departed.length === 0 && matched({ ...shadow }, next.rifts).length > 0) {
          expect([where, matched(shadow, next.rifts).sort()]).toEqual([where, [...readyBefore].sort()])
          expect([where, landedBefore.length === 0 || shadow.verifier !== undefined]).toEqual([where, true])
        }
      }

      // L1: a compliant root is never stuck. Verify what is landed, wait out the cadence, land every ready unit.
      const end = `seed ${seed} at its end`
      if (state.verifier !== undefined) {
        const done = await decide(state, HandBack.make({ role: "verifier", name: state.verifier.batch, verdict: "accepted" }), now)
        expect([end, "events" in done]).toEqual([end, true])
        if ("events" in done) state = evolve(state, done.events)
      }
      if (Object.values(state.units).some((unit) => unit.state === "landed")) {
        const verify = await decide(state, Start.make({ role: "verifier", name: "batch-9", round: 1, direct: false }), now)
        expect([end, "events" in verify]).toEqual([end, true])
        if ("events" in verify) state = evolve(state, verify.events)
      }
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

  test("a second land with the first one's units unverified is refused until a verifier starts", async () => {
    const first: ReadonlyArray<readonly [Command, number]> = [[impl("alpha"), 0], [ready("alpha"), MIN], [Land.make({ rifts: ["alpha"] }), 2 * MIN], [Landed.make({ rifts: ["alpha"] }), 3 * MIN], [impl("beta"), 4 * MIN], [ready("beta"), 5 * MIN]]
    expect((await run([...first, [Land.make({ rifts: ["beta"] }), 6 * MIN]])).last).toMatchObject({ refused: "BatchUnverified" })
    const verified = await run([...first, [Start.make({ role: "verifier", name: "batch-1", round: 1, direct: false }), 6 * MIN], [Land.make({ rifts: ["beta"] }), 7 * MIN]])
    expect(verified.last).toEqual({ events: [] })
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

  test("a Rift is its unit's by its name, its branch or its path; the longest unit name wins", () => {
    expect(unitOfRift("feat/auth", ["auth", "web"])).toBe("auth")
    expect(unitOfRift("/home/me/.rifts/repo/auth", ["auth"])).toBe("auth")
    expect(unitOfRift("wf10-auth", ["auth"])).toBe("auth")
    expect(unitOfRift("fix-auth", ["auth", "fix-auth"])).toBe("fix-auth")
    expect(unitOfRift("author", ["auth"])).toBeUndefined()
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

  test("the brief a compacted root gets names every unit by its state, what runs and what is due", async () => {
    const { state } = await run([[impl("a1"), 0], [impl("b1"), 0], [impl("c1"), 0], [impl("d1"), 0], [ready("a1"), MIN], [ready("b1"), 2 * MIN], [ready("c1"), 3 * MIN]])
    const brief = briefOf(state, T0 + 10 * MIN, CADENCE)
    expect(brief).toContain("implement: d1")
    expect(brief).toContain("ready: a1 (9 min), b1 (8 min), c1 (7 min)")
    expect(brief).toContain("a batch is due (3 ready)")
    expect(briefOf(M.initial, T0, CADENCE)).toBe("")
  })
})
