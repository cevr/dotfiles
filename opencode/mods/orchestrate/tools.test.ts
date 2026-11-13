// The `orchestrate` tool's domain (tools.ts), as the model reads it: the one description and its order, every
// call an answer or a refusal names (each decodes and passes the input rule), the input rule over its whole
// domain, and the rule that names a unit's Rift. The next call's property runs on the real decider in
// cmd/orchestrate/orch-tools.sim.test.ts, which has an Effect test runner.
import { describe, expect, test } from "bun:test"
import { Option, Schema } from "effect"
import {
  BatchLanded,
  FindingFolded,
  type Event as MachineEvent,
  type MachineState,
  machine,
  UnitHandedBack,
  UnitStarted,
  VerifierEnded,
  VerifierStarted,
} from "./machine.ts"
import {
  ACTIONS,
  type Action,
  aliasLine,
  FIELDS,
  type Field,
  inputRefusal,
  type Lane,
  LAND_NEXT,
  landAnswer,
  landCallOf,
  laneAnswer,
  laneBranchOf,
  nameRefusal,
  nextLine,
  nextOf,
  NO_UNITS,
  nothingToVerify,
  ORCHESTRATE_DESCRIPTION,
  OrchestrateInput,
  ownerOf,
  parentRefusal,
  REQUIRED,
  resolveLand,
  riftOfUnit,
  STEP_ORDER,
  statusAnswer,
  UNDECIDED,
  verifyAnswer,
} from "./tools.ts"

// ── The generator: a seeded stream, so a failure names its seed ──

const rng = (seed: number) => {
  let state = seed
  return () => {
    state = (state + 0x6d2b79f5) | 0
    let t = Math.imul(state ^ (state >>> 15), 1 | state)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
const SEEDS = Array.from({ length: 200 }, (_, n) => n + 1)
const pickOf =
  (random: () => number) =>
  <A,>(list: ReadonlyArray<A>, fallback: A): A =>
    Option.getOrElse(Option.fromUndefinedOr(list[Math.floor(random() * list.length)]), () => fallback)

/** A unit name of `[a-z][a-z0-9-]*`. */
const unitName = (random: () => number): string => {
  const letters = "abcdefghijklmnopqrstuvwxyz"
  const rest = "abcdefghijklmnopqrstuvwxyz0123456789-"
  const length = Math.floor(random() * 8)
  return `${letters[Math.floor(random() * letters.length)]}${Array.from({ length }, () => rest[Math.floor(random() * rest.length)]).join("")}`
}

const UNITS = ["alpha", "beta", "gamma", "db", "db-2", "feat-x"]

/** A machine state, as a generated run of the machine's own events folds it (`evolve`: pure). */
const stateOf = (random: () => number): MachineState => {
  const pick = pickOf(random)
  const decider = machine()
  let state = decider.initial
  let at = 0
  for (const _ of Array.from({ length: Math.floor(random() * 14) })) {
    at += Math.floor(random() * 20 * 60_000)
    const unit = pick(UNITS, "alpha")
    const roll = random()
    const event: MachineEvent = pick(
      [
        UnitStarted.make({ unit, round: 1 + Math.floor(random() * 3), direct: false, rift: `/code/.rifts/app/${unit}`, at }),
        UnitStarted.make({ unit, round: 1, direct: false, at }),
        UnitHandedBack.make({ unit, ready: roll < 0.7, said: pick(["ready", "blocked"], "ready"), at }),
        BatchLanded.make({ units: Object.keys(state.units).filter(() => random() < 0.6), at }),
        VerifierStarted.make({ batch: `batch-${1 + Math.floor(random() * 4)}`, units: Object.keys(state.units).filter(() => random() < 0.5), at }),
        VerifierEnded.make({ batch: Option.getOrElse(Option.map(Option.fromUndefinedOr(state.verifier), (verifier) => verifier.batch), () => "batch-1"), verdict: "changes", findings: [`${unit}/M1`], at }),
        VerifierEnded.make({ batch: Option.getOrElse(Option.map(Option.fromUndefinedOr(state.verifier), (verifier) => verifier.batch), () => "batch-1"), verdict: "accepted", at }),
        FindingFolded.make({ finding: `${pick(UNITS, "alpha")}/M1`, into: unit, at }),
      ],
      UnitStarted.make({ unit, round: 1, direct: false, at }),
    )
    state = decider.evolve(state, event)
  }
  return state
}

/** A Rift as the rift RPC answers it. */
const laneAt = (path: string, branch: Option.Option<string>, head = "abc1234", state = "clean"): Lane =>
  Option.match(branch, { onNone: () => ({ path, head, state }), onSome: (named) => ({ path, branch: named, head, state }) })

// ── Reading the calls a text names ──

/** Each `orchestrate({ … })` call in `text`, from its `{` to its matching `}`. */
const callsIn = (text: string): ReadonlyArray<string> => {
  const found: Array<string> = []
  let from = text.indexOf("orchestrate({")
  while (from >= 0) {
    const open = from + "orchestrate(".length
    let depth = 0
    let quoted = false
    let end = -1
    for (let index = open; index < text.length && end < 0; index++) {
      const char = text[index]
      if (quoted && char === "\\") index++
      else if (char === '"') quoted = !quoted
      else if (!quoted && (char === "{" || char === "[")) depth++
      else if (!quoted && (char === "}" || char === "]")) {
        depth--
        if (depth === 0) end = index
      }
    }
    found.push(text.slice(open, end + 1))
    from = text.indexOf("orchestrate({", end)
  }
  return found
}

/** A call's object literal as JSON: its bare keys quoted. */
const jsonOf = (literal: string): string => {
  let out = ""
  let quoted = false
  for (let index = 0; index < literal.length; index++) {
    const char = literal[index] ?? ""
    if (quoted && char === "\\") {
      out += char + (literal[index + 1] ?? "")
      index++
      continue
    }
    if (char === '"') quoted = !quoted
    const key = Option.filter(Option.fromNullishOr(/^[a-z]+(?=:)/i.exec(literal.slice(index))?.[0]), () => !quoted && /[{,\s]/.test(literal[index - 1] ?? ""))
    if (Option.isSome(key)) {
      out += `"${key.value}"`
      index += key.value.length - 1
      continue
    }
    out += char
  }
  return out
}

// A field the schema lacks fails the decode, as the model would read it as a field the call takes.
const decodeCall = (text: string) => Schema.decodeUnknownOption(Schema.fromJsonString(OrchestrateInput))(text, { onExcessProperty: "error" })

/** Each call `text` names, decoded, or the literal that does not decode. */
const decodedIn = (text: string) => callsIn(text).map((literal) => ({ literal, decoded: decodeCall(jsonOf(literal)) }))

/** Every call in `text` decodes through `OrchestrateInput` and passes the input rule. */
const expectCallsDecode = (text: string) => {
  for (const { literal, decoded } of decodedIn(text)) {
    expect({ literal, decodes: Option.isSome(decoded) }).toEqual({ literal, decodes: true })
    expect({ literal, refused: Option.flatMap(decoded, inputRefusal) }).toEqual({ literal, refused: Option.none() })
  }
}

// ── The description ──

describe("the orchestrate tool's description", () => {
  const paragraphs = ORCHESTRATE_DESCRIPTION.split("\n\n")
  const headings = paragraphs.map((paragraph) => Option.getOrElse(Option.fromNullishOr(/^([a-z]+):/.exec(paragraph)?.[1]), () => ""))

  test("tells the six steps in the loop's order, each action once as the heading of its paragraph", () => {
    const steps = STEP_ORDER.map((step) => headings.indexOf(step))
    expect(steps.every((at) => at > 0)).toBe(true)
    expect([...steps].sort((a, b) => a - b)).toEqual(steps)
    expect(ACTIONS.map((action) => [action, headings.filter((heading) => heading === action).length])).toEqual(ACTIONS.map((action) => [action, 1]))
    expect(paragraphs[0]).toContain("lane → implement → ready → land → verify → fold")
  })

  test("names the two subagent calls with their description forms", () => {
    expect(paragraphs[headings.indexOf("implement")]).toContain('subagent({ agent: "implementor", description: "implementor <unit> r1 (rift: <path>)"')
    expect(paragraphs[headings.indexOf("verify")]).toContain('subagent({ agent: "verifier", description: "verifier batch-<k> r1"')
  })

  test("is at most 4,000 characters, with no line over 700", () => {
    expect(ORCHESTRATE_DESCRIPTION.length).toBeLessThanOrEqual(4000)
    expect(ORCHESTRATE_DESCRIPTION.split("\n").filter((line) => line.length > 700)).toEqual([])
  })

  test("says what a land takes and does not wait for, that a lane is never made twice, and whom rift is for", () => {
    const sentences = ORCHESTRATE_DESCRIPTION.split(/(?<=[.:;])\s+/)
    for (const sentence of [
      "A land with no units lands every ready unit in one call.",
      "A land does not wait for the deep run or the post-land step:",
      "A lane that exists is answered, never made again by hand.",
      "The rift tool is for a session that runs no units;",
    ])
      expect(sentences).toContain(sentence)
  })

  test("every call it names decodes and passes the input rule, and none is a rift land or create", () => {
    expect(callsIn(ORCHESTRATE_DESCRIPTION).length).toBeGreaterThanOrEqual(4)
    expectCallsDecode(ORCHESTRATE_DESCRIPTION)
    expect(ORCHESTRATE_DESCRIPTION).not.toContain('rift({ action: "land"')
    expect(ORCHESTRATE_DESCRIPTION).not.toContain('rift({ action: "create"')
  })
})

// ── The answers and refusals ──

/** Every text tools.ts writes, over a generated state, lanes and input. */
const textsOf = (random: () => number): ReadonlyArray<string> => {
  const pick = pickOf(random)
  const state = stateOf(random)
  const unit = pick([...UNITS, unitName(random)], "alpha")
  const lanes = UNITS.flatMap((name) => Option.toArray(Option.liftPredicate(laneAt(`/code/.rifts/app/${name}`, Option.some(`feat/${name}`)), () => random() < 0.6)))
  const lane = pick(lanes, laneAt(`/code/.rifts/app/${unit}`, Option.none()))
  const next = nextOf(state, Math.floor(random() * 3_600_000), { ready: 3, waitMs: 30 * 60_000 })
  const input = inputOf(random)
  const units = UNITS.flatMap((name) => Option.toArray(Option.liftPredicate(pick([name, { unit: name, path: `/x/${name}` }], name), () => random() < 0.4)))
  const land = resolveLand({ action: "land", units }, lanes, state, next)
  const defaulted = resolveLand({ action: "land" }, lanes, state, next)
  return [
    ...Option.toArray(inputRefusal(input)),
    ...Option.toArray(nameRefusal(input)),
    ...ACTIONS.map(parentRefusal),
    laneAnswer(unit, lane, random() < 0.5),
    landAnswer("Landed 1 Rift(s) as one push."),
    verifyAnswer(`batch-${Math.floor(random() * 9)}`, lane, random() < 0.5, pick(["given", "origin"] as const, "origin")),
    nothingToVerify(state, next),
    NO_UNITS,
    statusAnswer("implement: alpha", [[unit, Option.some(lane)], ["beta", Option.none()]], next),
    aliasLine("create"),
    aliasLine("land"),
    UNDECIDED,
    LAND_NEXT,
    nextLine(next),
    landCallOf(units, Option.some("the owner asked")),
    ...refusedOf(land),
    ...refusedOf(defaulted),
    riftOfUnitText(unit, lanes, state),
  ]
}

/** A resolution's refusal, when it refused. */
const refusedOf = (resolved: { readonly refused: string } | { readonly rifts: ReadonlyArray<unknown> }): ReadonlyArray<string> => {
  if ("refused" in resolved) return [resolved.refused]
  return []
}

/** A found Rift's path, when one was found. */
const pathOf = (found: { readonly refused: string } | { readonly found: { readonly path: string } }): ReadonlyArray<string> => {
  if ("found" in found) return [found.found.path]
  return []
}

const riftOfUnitText = (unit: string, lanes: ReadonlyArray<Lane>, state: MachineState) => {
  const found = riftOfUnit(unit, lanes, state)
  if ("refused" in found) return found.refused
  return landCallOf([found.found])
}

describe("every call an answer or a refusal names", () => {
  test("decodes through OrchestrateInput and passes the input rule, over generated states, lanes and inputs", () => {
    let calls = 0
    for (const seed of SEEDS) {
      const texts = textsOf(rng(seed))
      for (const text of texts) {
        calls += callsIn(text).length
        expectCallsDecode(text)
        expect(text).not.toContain('rift({ action: "land"')
      }
    }
    expect(calls).toBeGreaterThan(SEEDS.length * 10)
  })
})

// ── The input rule ──

/** A generated value for a field: a unit name, a list of units, a batch, a commit, a reason. */
const valueOf = (field: Field, random: () => number) => {
  const pick = pickOf(random)
  const name = unitName(random)
  if (field === "units") return [name, { unit: pick(UNITS, "alpha"), path: `/code/.rifts/app/${name}` }].filter(() => random() < 0.7)
  if (field === "batch") return `batch-${1 + Math.floor(random() * 20)}`
  if (field === "head") return pick(["abc1234", "origin/HEAD", "f00dfeed"], "abc1234")
  if (field === "source") return pick(["/code/app", "../app", "."], ".")
  if (field === "departs") return "the owner asked for this one alone"
  if (field === "run") return pick(["pc", "p5", "pipeline-codify"], "pc")
  if (field === "branch") return `${pick(["feat", "fix", "pc"], "feat")}/${name}`
  return name
}

const ALL: ReadonlyArray<Field> = ["unit", "run", "branch", "source", "units", "departs", "batch", "head"]

/** A generated call: an action, and any subset of the fields with generated values. */
const inputOf = (random: () => number): OrchestrateInput => {
  const action = pickOf(random)(ACTIONS, "status")
  const fields = ALL.filter(() => random() < 0.3)
  return Schema.decodeUnknownSync(OrchestrateInput)(Object.fromEntries([["action", action], ...fields.map((field) => [field, valueOf(field, random)])]))
}

const present = (input: OrchestrateInput): ReadonlyArray<Field> => ALL.filter((field) => Object.hasOwn(input, field))

describe("the input rule", () => {
  test("over its whole domain: a call runs if and only if every field it carries is its action's and it carries the ones its action needs", () => {
    for (const seed of Array.from({ length: 2000 }, (_, n) => n + 1)) {
      const input = inputOf(rng(seed))
      const fields = present(input)
      const action: Action = input.action
      const takes: ReadonlyArray<Field> = FIELDS[action]
      const needs: ReadonlyArray<Field> = REQUIRED[action]
      const runs = fields.every((field) => takes.includes(field)) && needs.every((field) => fields.includes(field))
      const refusal = inputRefusal(input)
      expect({ seed, input, runs: Option.isNone(refusal) }).toEqual({ seed, input, runs })
      // A refused call names an action that takes its stray field, with a call that decodes.
      const stray = fields.find((field) => !takes.includes(field))
      if (Option.isSome(refusal) && stray !== void 0) {
        expect(refusal.value).toContain(`${stray} belongs to ${ownerOf(stray)}`)
        expect(FIELDS[ownerOf(stray)]).toContain(stray)
      }
      Option.map(refusal, expectCallsDecode)
    }
  })

  test("a lane typed for a land, a land typed for a lane, and each with no other field", () => {
    const decode = Schema.decodeUnknownSync(OrchestrateInput)
    expect(inputRefusal(decode({ action: "land", unit: "billing" }))).toEqual(Option.some(expect.stringContaining("land takes no unit: unit belongs to lane")))
    expect(inputRefusal(decode({ action: "lane", units: ["billing"] }))).toEqual(Option.some(expect.stringContaining("lane takes no units: units belongs to land")))
    expect(inputRefusal(decode({ action: "lane" }))).toEqual(Option.some(expect.stringContaining("lane needs unit")))
    expect(inputRefusal(decode({ action: "land" }))).toEqual(Option.none())
    expect(inputRefusal(decode({ action: "verify" }))).toEqual(Option.some(expect.stringContaining("verify needs batch")))
    expect(inputRefusal(decode({ action: "status", head: "abc1234" }))).toEqual(Option.some(expect.stringContaining("status takes no head: head belongs to verify")))
    expect(nameRefusal(decode({ action: "lane", unit: "Bad Name" }))).toEqual(Option.some(expect.stringContaining("is no unit name")))
    expect(nameRefusal(decode({ action: "verify", batch: "7" }))).toEqual(Option.some(expect.stringContaining("is no batch")))
  })
})

// ── The lane name rule ──

/** The Rift a lane makes on the Mac: named for the unit, on its default branch. */
const laneOf = (unit: string): Lane => laneAt(`/code/.rifts/app/${unit}`, Option.some(laneBranchOf({ unit })))

/** A state whose units implement, started on their lanes (`(rift: <path>)`) or with no Rift named. */
const implementing = (units: ReadonlyArray<string>, started: boolean): MachineState =>
  units.reduce(
    (state, unit, at) =>
      machine().evolve(
        state,
        Option.match(Option.liftPredicate(laneOf(unit).path, () => started), {
          onNone: () => UnitStarted.make({ unit, round: 1, direct: false, at }),
          onSome: (rift) => UnitStarted.make({ unit, round: 1, direct: false, rift, at }),
        }),
      ),
    machine().initial,
  )

describe("the lane name rule", () => {
  test("for any unit names, the Rift lane makes is the one land resolves its unit to, never another's; started on it, always", () => {
    for (const seed of SEEDS) {
      const random = rng(seed)
      const units = [...new Set(Array.from({ length: 1 + Math.floor(random() * 5) }, () => unitName(random)))]
      const lanes = units.map(laneOf)
      for (const started of [true, false]) {
        const state = implementing(units, started)
        const resolved = units.map((unit) => [unit, riftOfUnit(unit, lanes, state)] as const)
        for (const [unit, found] of resolved) {
          // Started on its lane, the ledger names it; else the name rule may find none or two, and then refuses.
          if ("found" in found) expect({ seed, unit, path: found.found.path }).toEqual({ seed, unit, path: laneOf(unit).path })
          else {
            expect({ seed, unit, started }).toEqual({ seed, unit, started: false })
            expect(found.refused).toContain(`{ unit: "${unit}", path:`)
          }
        }
        // Two units never resolve to one Rift.
        const paths = resolved.flatMap(([, found]) => pathOf(found))
        expect(new Set(paths).size).toBe(paths.length)
      }
      // A unit alone always resolves to its lane by the name rule.
      const alone = units.slice(0, 1)
      for (const unit of alone) expect(riftOfUnit(unit, lanes.slice(0, 1), implementing(alone, false))).toEqual({ found: { unit, path: laneOf(unit).path } })
    }
  })

  test("the branch is the one given, else <run>/<unit>, else feat/<unit>", () => {
    expect(laneBranchOf({ unit: "billing" })).toBe("feat/billing")
    expect(laneBranchOf({ unit: "billing", run: "pc" })).toBe("pc/billing")
    expect(laneBranchOf({ unit: "billing", run: "pc", branch: "fix/bill" })).toBe("fix/bill")
  })

  test("a land with no units takes every ready unit, each with its Rift; one with no Rift is refused with the { unit, path } form", () => {
    const decider = machine()
    const started = implementing(["alpha", "beta"], true)
    const ready = [UnitHandedBack.make({ unit: "alpha", ready: true, said: "ready", at: 5 }), UnitHandedBack.make({ unit: "beta", ready: true, said: "ready", at: 6 })].reduce(
      decider.evolve,
      started,
    )
    const next = nextOf(ready, 6, { ready: 3, waitMs: 30 * 60_000 })
    expect(resolveLand({ action: "land" }, [], ready, next)).toEqual({ rifts: [{ unit: "alpha", path: laneOf("alpha").path }, { unit: "beta", path: laneOf("beta").path }] })
    const bare = decider.evolve(implementing(["gamma"], false), UnitHandedBack.make({ unit: "gamma", ready: true, said: "ready", at: 7 }))
    expect(resolveLand({ action: "land" }, [], bare, next)).toEqual({ refused: expect.stringContaining('Name its Rift: orchestrate({ action: "land", units: [{ unit: "gamma", path: "<its Rift>" }] })') })
    expect(resolveLand({ action: "land" }, [], machine().initial, next)).toEqual({ refused: expect.stringContaining("no unit is ready to land") })
    // A named unit the machine does not hold is refused, though a Rift reads as it: its land would decide nothing.
    expect(resolveLand({ action: "land", units: ["alpha", "delta"] }, [laneOf("delta")], ready, next)).toEqual({ refused: expect.stringContaining("the machine holds no unit delta") })
  })
})
