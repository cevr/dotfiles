// The `orchestrate` tool's domain (tools.ts), as the model reads it: the one description and its order, every
// call an answer or a refusal names (each decodes and passes the input rule), the input rule over its whole
// domain, the rule that names a unit's Rift, a land's resolution from the run tables and the Rift list, and
// status. The tool on a simulated host runs in cmd/orchestrate/orch-tools.sim.test.ts.
import { describe, expect, test } from "bun:test"
import { Array as Arr, Match, Option, Predicate, Schema } from "effect"
import type { Run } from "./idle.ts"
import {
  ACTIONS,
  type Action,
  FIELDS,
  type Field,
  inputRefusal,
  type Lane,
  LAND_NEXT,
  type LandUnit,
  landAnswer,
  landCallOf,
  laneAnswer,
  laneBranchOf,
  laneNote,
  lanePathOf,
  laneDecision,
  lanesOf,
  implementorDescriptionOf,
  namingWarnings,
  PURPOSE_MAX,
  purposeHint,
  reusedOf,
  strayOf,
  laneWarnings,
  isInternal,
  workriftFolderOf,
  type MainBatch,
  type MainSince,
  mainBatchPathOf,
  mainBatchText,
  mainRunDirOf,
  mainVerifyAnswer,
  mainVerifyName,
  changesWarningOf,
  changesWarnings,
  dueWarning,
  findingsVerdictOf,
  holdsVerdict,
  batchHeadOf,
  inRange,
  isDue,
  landsOf,
  nextOf,
  pushedOf,
  requestHeadOf,
  roundIn,
  type UnitFiles,
  VERIFY_CALL,
  VERIFY_EVERY,
  VERIFY_MAX_AGE_MS,
  type Verified,
  verifyBaseOf,
  readyWithLane,
  lanesRefusal,
  nameRefusal,
  nextLine,
  NO_UNITS,
  nothingToLand,
  ORCHESTRATE_DESCRIPTION,
  OrchestrateInput,
  ownerOf,
  parentRefusal,
  REQUIRED,
  type Resolved,
  resolveLand,
  STEP_ORDER,
  statusAnswer,
  verifyAnswer,
  warningOf,
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

  test("tells the five steps in the loop's order, each action once as the heading of its paragraph", () => {
    const steps = STEP_ORDER.map((step) => headings.indexOf(step))
    expect(steps.every((at) => at > 0)).toBe(true)
    expect([...steps].sort((a, b) => a - b)).toEqual(steps)
    expect(ACTIONS.map((action) => [action, headings.filter((heading) => heading === action).length])).toEqual(ACTIONS.map((action) => [action, 1]))
    expect(paragraphs[0]).toContain("lane → implement → ready → land → verify")
    expect(ORCHESTRATE_DESCRIPTION).not.toMatch(/machine|ledger|fold/)
  })

  test("names the two subagent calls with their description forms", () => {
    expect(paragraphs[headings.indexOf("implement")]).toContain('subagent({ agent: "implementor", description: "implementor <unit> r1 — <purpose> (lane: <path>)"')
    expect(paragraphs[headings.indexOf("verify")]).toContain('subagent({ agent: "verifier", description: "verifier <batch> r1"')
  })

  test("a lane's answer ends with the (lane: <path>) note its implementor's description takes; the note's reader takes the old (rift: <path>) too", () => {
    const lane: Lane = { path: "/code/.work/app/auth", branch: "run/auth", head: "abc1234", state: "clean" }
    const answer = laneAnswer("auth", lane, true)
    expect(answer.split("\n").slice(-2)).toEqual([
      'Start its implementor: subagent({ agent: "implementor", description: "implementor auth r1 (lane: /code/.work/app/auth)", prompt, background: true }).',
      "(lane: /code/.work/app/auth)",
    ])
    expect(laneNote(lane.path)).toBe("(lane: /code/.work/app/auth)")
    expect(answer).not.toContain("(rift:")
    expect([lanePathOf(answer), lanePathOf("implementor auth r1 (rift: /code/.rifts/app/auth)"), lanePathOf("implementor auth r1 (Opus)")]).toEqual([
      Option.some("/code/.work/app/auth"),
      Option.some("/code/.rifts/app/auth"),
      Option.none(),
    ])
  })

  test("is at most 4,000 characters, with no line over 700", () => {
    expect(ORCHESTRATE_DESCRIPTION.length).toBeLessThanOrEqual(4000)
    expect(ORCHESTRATE_DESCRIPTION.split("\n").filter((line) => line.length > 700)).toEqual([])
  })

  test("says what a land takes and does not wait for, that a lane is never made twice, and whom rift is for", () => {
    const sentences = ORCHESTRATE_DESCRIPTION.split(/(?<=[.:;])\s+/)
    for (const sentence of [
      "A named unit that is not ready lands with a warning.",
      "A land does not wait for the deep run or the post-land step:",
      "they run in the background and wake you only when one fails or needs action:",
      "no notice means green.",
      "A lane that exists is answered, never made again by hand.",
      "The work tool is for a session that runs no units;",
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

/** A run table of `units`, each in a generated state. */
const runOf = (random: () => number, units: ReadonlyArray<string>): Run => {
  const pick = pickOf(random)
  return { name: "app", units: units.map((unit) => ({ unit, state: pick(["implement", "ready", "blocked", "verify", "merged abc1234", "plan"], "ready") })) }
}

/** The clock the verify-due tests read: a Wednesday afternoon. */
const NOW = Date.parse("2026-11-04T15:00:00Z")
const HOUR = 3_600_000

/** A 40-hex commit name from a number. */
const shaOf = (n: number): string => n.toString(16).padStart(40, "0")

/** A generated default branch since the last verify: any land count, a last verify of any age or none. */
const sinceOf = (random: () => number): MainSince => {
  const last = Option.map(Option.liftPredicate(random(), (draw) => draw >= 0.3), (): Verified => ({ file: "/run/verify-x/batch-x.md", head: shaOf(1 + Math.floor(random() * 99)), at: NOW - Math.floor(random() * 48) * HOUR }))
  return { branch: Option.getOrElse(Arr.get(["main", "master"], Math.floor(random() * 2)), () => "main"), head: shaOf(1000), base: shaOf(7), lands: Math.floor(random() * 9), last }
}

/** A land's unit by its name. */
const landNameOf = (unit: LandUnit): string =>
  Match.value(unit).pipe(
    Match.when(Predicate.isString, (name) => name),
    Match.orElse((named) => named.unit),
  )

/** Some of `value` when the draw is at least `below`. */
const sometimes = <A,>(random: () => number, below: number, value: () => A): Option.Option<A> => Option.map(Option.liftPredicate(random(), (draw) => draw >= below), value)

/** A generated verify of main. */
const batchOf = (random: () => number): MainBatch => ({
  name: mainVerifyName(shaOf(1000)),
  base: shaOf(7),
  head: shaOf(1000),
  last: sinceOf(random).last,
  merges: Array.from({ length: Math.floor(random() * 4) }, (_, n) => ({ sha: shaOf(500 + n), parent: shaOf(400 + n), subject: `Merge branch 'feat/u${n}'` })),
  units: Array.from({ length: Math.floor(random() * 3) }, (_, n) => ({ unit: `u${n}`, dir: `/run/u${n}`, round: 1 + n, spec: `/run/u${n}/spec.md`, request: `/run/u${n}/round-${1 + n}-request.md` })),
  heads: sometimes(random, 0.5, () => ({ dotfiles: shaOf(1000), fork: shaOf(77) })),
})

/** Every text tools.ts writes, over generated run tables, lanes and input. */
const textsOf = (random: () => number): ReadonlyArray<string> => {
  const pick = pickOf(random)
  const runs = [runOf(random, UNITS.filter(() => random() < 0.7))]
  const unit = pick([...UNITS, unitName(random)], "alpha")
  const workrift = random() < 0.5
  const lanes = UNITS.flatMap((name) => Option.toArray(Option.liftPredicate(laneOf(name, workrift), () => random() < 0.6)))
  const lane = pick(lanes, laneAt(`/code/.work/app/${unit}`, Option.none()))
  const input = inputOf(random)
  const units = UNITS.flatMap((name) => Option.toArray(Option.liftPredicate(pick<LandUnit>([name, { unit: name, path: `/x/${name}` }], name), () => random() < 0.4)))
  return [
    ...Option.toArray(inputRefusal(input)),
    ...Option.toArray(nameRefusal(input)),
    ...ACTIONS.map(parentRefusal),
    laneAnswer(unit, lane, random() < 0.5),
    landAnswer([warningOf(unit, "blocked")], "Landed 1 workspace(s) as one push."),
    verifyAnswer(`batch-${Math.floor(random() * 9)}`, lane, random() < 0.5, pick(["given", "origin"] as const, "origin")),
    NO_UNITS,
    statusAnswer(runs, lanes, workrift),
    statusAnswer(runs, lanes, workrift, Option.some(sinceOf(random)), NOW),
    LAND_NEXT,
    nextLine(runs, lanes, workrift),
    nextLine(runs, lanes, workrift, Option.some(sinceOf(random)), NOW),
    ...Option.toArray(dueWarning(sinceOf(random), NOW)),
    changesWarningOf(unit, 1 + Math.floor(random() * 3), `/run/${unit}/round-1-findings.md`),
    mainVerifyAnswer(batchOf(random), Option.some("/run/verify-main-abc1234/batch-main-abc1234.md"), lane, random() < 0.5, pick(["given", "origin"] as const, "origin")),
    mainVerifyAnswer(batchOf(random), Option.none(), lane, random() < 0.5, "origin"),
    nothingToLand(runs),
    landCallOf(units),
    lanesRefusal(unit, [laneOf(unit, false), laneOf(`${unit}-2`, false)]),
    ...resolvedTexts(resolveLand({ action: "land", units }, runs, lanes, workrift)),
    ...resolvedTexts(resolveLand({ action: "land" }, runs, lanes, workrift)),
  ]
}

/** What a land's resolution says: its refusal, its nothing-to-land answer or its warnings. */
const resolvedTexts = (resolved: Resolved): ReadonlyArray<string> => {
  if ("refused" in resolved) return [resolved.refused]
  if ("nothing" in resolved) return [resolved.nothing]
  return resolved.warnings
}

// This domain's import fence keeps the simulator helper out.
const assertWitness = <A>(name: string, expected: A, run: (cause: boolean) => A) => {
  const observed = run(true)
  const withoutCause = run(false)
  const label = `W: ${name}`
  expect(observed, label).toEqual(expected)
  expect(() => expect(withoutCause, label).toEqual(expected), `${label}: removing the cause must fail the same observation`).toThrow()
  return name
}

describe("every call an answer or a refusal names", () => {
  const checkTexts = (texts: ReadonlyArray<string>) => {
    for (const text of texts) {
      expectCallsDecode(text)
      expect(text).not.toContain('rift({ action: "land"')
      expect(text).not.toContain("machine")
    }
  }
  test("decodes through OrchestrateInput and passes the input rule, over generated run tables, lanes and inputs", () => {
    for (const seed of SEEDS) checkTexts(textsOf(rng(seed)))
    // A separate corpus: varying the random seed range cannot change these draws.
    for (const index of Arr.range(0, 199)) {
      const deliberate = textsOf(() => 0.12 + (index / 200) * 0.1)
      checkTexts(deliberate)
    }
  })
  const renders = Arr.range(0, 199).map((index) => ({ index, name: `render ${index}: eight land calls and a missing-purpose hint` }))
  test("W: every render emits eight land calls and its missing-purpose hint", () => {
    const ran: Array<string> = []
    for (const { index, name } of renders) {
      const rendered = (purpose: Option.Option<string>) => {
        const units = Arr.makeBy(8, (n) => `table-${index}-unit-${n}`)
        const unit = `needs-purpose-${index}`
        const lane = laneOf(unit, false)
        return [
          ...units.map((name) => landCallOf([name])),
          laneAnswer(unit, Option.match(purpose, { onNone: () => lane, onSome: (text) => ({ ...lane, purpose: text }) }), false),
        ]
      }
      ran.push(assertWitness(name, 9, (cause) => {
        const purpose = Option.filter(Option.some("checks the observed commands"), () => !cause)
        const lines = rendered(purpose)
        checkTexts(lines)
        const count = lines.flatMap(callsIn).length
        if (!cause) expect(count, "control setup: the eight land calls remain").toBe(8)
        return count
      }))
    }
    expect(ran.toSorted(), "render cases completed").toEqual(renders.map((each) => each.name).toSorted())
  })
})

// ── The input rule ──

/** A generated value for a field: a unit name, a list of units, a batch, a commit, a reason. */
const valueOf = (field: Field, random: () => number) => {
  const pick = pickOf(random)
  const name = unitName(random)
  if (field === "units") return [name, { unit: pick(UNITS, "alpha"), path: `/code/.work/app/${name}` }].filter(() => random() < 0.7)
  if (field === "batch") return pick([`batch-${1 + Math.floor(random() * 20)}`, name, "main-abc1234"], "batch-1")
  if (field === "head") return pick(["abc1234", "origin/HEAD", "f00dfeed"], "abc1234")
  if (field === "source") return pick(["/code/app", "../app", "."], ".")
  if (field === "departs") return "the owner asked for this one alone"
  if (field === "run") return pick(["pc", "p5", "pipeline-codify"], "pc")
  if (field === "branch") return `${pick(["feat", "fix", "pc"], "feat")}/${name}`
  if (field === "purpose") return pick(["Land notices only when red", "Bill each seat once", ""], "Bill each seat once")
  return name
}

const ALL: ReadonlyArray<Field> = ["unit", "run", "branch", "source", "purpose", "units", "departs", "batch", "head"]

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
    expect(inputRefusal(decode({ action: "land", departs: "an old root's reason" }))).toEqual(Option.none())
    expect(inputRefusal(decode({ action: "verify" }))).toEqual(Option.none())
    expect(inputRefusal(decode({ action: "status", head: "abc1234" }))).toEqual(Option.some(expect.stringContaining("status takes no head: head belongs to verify")))
    expect(nameRefusal(decode({ action: "lane", unit: "Bad Name" }))).toEqual(Option.some(expect.stringContaining("is no unit name")))
    expect(nameRefusal(decode({ action: "verify", batch: "Batch 7" }))).toEqual(Option.some(expect.stringContaining("is no batch")))
    // A verifier is named for a batch, a unit or a commit of main: none is refused for its kind.
    for (const batch of ["batch-7", "billing", "main-abc1234"]) expect(nameRefusal(decode({ action: "verify", batch }))).toEqual(Option.none())
  })
})

// ── The lane name rule ──

/** A lane's Rift name for `unit`: the unit on the Mac, its branch with `-` for `/` on the workbox. */
const riftNameOf = (unit: string, workrift: boolean): string =>
  Option.getOrElse(Option.map(Option.liftPredicate(laneBranchOf({ unit }), () => workrift), workriftFolderOf), () => unit)

/** The Rift a lane makes for `unit` on its default branch: named for the unit on the Mac, for its branch (`feat-<unit>`) on the workbox. */
const laneOf = (unit: string, workrift: boolean): Lane => {
  const branch = laneBranchOf({ unit })
  return laneAt(`/code/.work/app/${riftNameOf(unit, workrift)}`, Option.some(branch))
}

describe("the lane name rule", () => {
  test("for any unit names, on either host, each unit's lanes are exactly the Rift its lane made, never another's", () => {
    for (const seed of SEEDS) {
      const random = rng(seed)
      const units = [...new Set(Array.from({ length: 1 + Math.floor(random() * 5) }, () => unitName(random)))]
      for (const workrift of [false, true]) {
        const lanes = units.map((unit) => laneOf(unit, workrift))
        for (const unit of units) expect({ seed, workrift, unit, lanes: lanesOf(unit, lanes, workrift) }).toEqual({ seed, workrift, unit, lanes: [laneOf(unit, workrift)] })
        // Lane again: the Rift is answered, never made twice.
        for (const unit of units) {
          const branch = laneBranchOf({ unit })
          const name = riftNameOf(unit, workrift)
          expect({ seed, workrift, unit, decided: laneDecision(unit, branch, name, workrift, lanes) }).toEqual({ seed, workrift, unit, decided: { found: laneOf(unit, workrift) } })
        }
      }
    }
  })

  // orch-tools r4 M1: on the workbox, unit y's Rift is named feat-y (for its branch feat/y); unit feat-y must never be answered it.
  test("units y and feat-y: neither is answered the other's Rift, on the workbox or the Mac", () => {
    for (const workrift of [true, false]) {
      const y = laneOf("y", workrift)
      expect(lanesOf("feat-y", [y], workrift)).toEqual([])
      const branch = laneBranchOf({ unit: "feat-y" })
      const name = riftNameOf("feat-y", workrift)
      expect(laneDecision("feat-y", branch, name, workrift, [y])).toEqual({ make: name })
      const featY = laneOf("feat-y", workrift)
      expect(lanesOf("y", [y, featY], workrift)).toEqual([y])
      expect(lanesOf("feat-y", [y, featY], workrift)).toEqual([featY])
      const runs: ReadonlyArray<Run> = [{ name: "app", units: [{ unit: "y", state: "ready" }, { unit: "feat-y", state: "ready" }] }]
      expect(resolveLand({ action: "land", units: ["feat-y"] }, runs, [y], workrift)).toEqual({ refused: expect.stringContaining("no workspace of the base reads as feat-y") })
      expect(resolveLand({ action: "land" }, runs, [y], workrift)).toEqual({ rifts: [{ unit: "y", path: y.path }], warnings: [] })
    }
  })

  test("the branch is the one given, else <run>/<unit>, else feat/<unit>", () => {
    expect(laneBranchOf({ unit: "billing" })).toBe("feat/billing")
    expect(laneBranchOf({ unit: "billing", run: "pc" })).toBe("pc/billing")
    expect(laneBranchOf({ unit: "billing", run: "pc", branch: "fix/bill" })).toBe("fix/bill")
  })
})

// ── One lane, one unit, one branch, for a lane orchestrate lane made ──

describe("a lane is one unit's for its life, once orchestrate lane made it", () => {
  const decode = Schema.decodeUnknownSync(OrchestrateInput)
  // The Ergo run's measured case (facts.md): the lane ui-input holds branch wf10/ui-hover-areas. Made before the rule,
  // it has no mark; `reused` is the same switch in a lane orchestrate lane made, and marked, on feat/ui-input.
  const stray = laneAt("/code/.work/app/ui-input", Option.some("wf10/ui-hover-areas"))
  const reused: Lane = { ...stray, madeOn: "feat/ui-input" }
  const runs: ReadonlyArray<Run> = [{ name: "app", units: [{ unit: "ui-input", state: "ready" }, { unit: "ui-hover-areas", state: "ready" }] }]
  /** A lane orchestrate lane made on the branch it holds. */
  const marked = (lane: Lane): Lane => ({ ...lane, madeOn: Option.getOrElse(Option.fromUndefinedOr(lane.branch), () => "") })

  test("a lane of a unit whose marked lane now holds another branch is refused, naming both, on either host", () => {
    const mac = laneDecision("ui-input", "feat/ui-input", "ui-input", false, [reused])
    expect(mac).toEqual({ refused: expect.stringContaining("ui-input's lane /code/.work/app/ui-input holds branch wf10/ui-hover-areas, not feat/ui-input, the branch orchestrate lane made it on") })
    expect(mac).toEqual({ refused: expect.stringContaining('orchestrate({ action: "lane", unit: "ui-hover-areas" })') })
    const box: Lane = { ...laneAt("/code/.work/app/feat-ui-input", Option.some("wf10/ui-hover-areas")), madeOn: "feat/ui-input" }
    expect(laneDecision("ui-input", "feat/ui-input", "feat-ui-input", true, [box])).toEqual({ refused: expect.stringContaining("holds branch wf10/ui-hover-areas") })
  })

  test("an unmarked lane holding another branch is taken as before the rule: lane answers it, land lands it, each with the warning and the fix", () => {
    expect(laneDecision("ui-input", "feat/ui-input", "ui-input", false, [stray])).toEqual({ found: stray })
    expect(laneWarnings("ui-input", stray, false)).toEqual([expect.stringContaining("orchestrate: warning: ui-input's lane /code/.work/app/ui-input holds branch wf10/ui-hover-areas, not ui-input's; orchestrate lane did not make it")])
    expect(laneWarnings("ui-input", stray, false)).toEqual([expect.stringContaining('orchestrate({ action: "lane", unit: "ui-hover-areas" })')])
    expect(laneAnswer("ui-input", stray, false, laneWarnings("ui-input", stray, false)).split("\n")[0]).toContain("orchestrate: warning: ui-input's lane")
    for (const units of [["ui-input"], [{ unit: "ui-input", path: stray.path }]]) {
      const landed = resolveLand({ action: "land", units }, runs, [stray], false)
      expect(landed).toEqual({ rifts: [{ unit: "ui-input", path: stray.path }], warnings: [expect.stringContaining("so it is taken as before the one-lane rule")] })
    }
    // A land of no units lands it too, warned; status flags it with a warning, never REUSED, and names the land.
    expect(resolveLand({ action: "land" }, [{ name: "app", units: [{ unit: "ui-input", state: "ready" }] }], [stray], false)).toEqual({
      rifts: [{ unit: "ui-input", path: stray.path }],
      warnings: [expect.stringContaining("orchestrate: warning: ui-input's lane")],
    })
    const text = statusAnswer([{ name: "app", units: [{ unit: "ui-input", state: "ready" }] }], [stray], false)
    expect(text).toContain(`- ui-input: ready · lane ${stray.path} (branch wf10/ui-hover-areas) · warning: it holds branch wf10/ui-hover-areas, not ui-input's; orchestrate lane did not make it, so it lands as asked.`)
    expect(text).not.toContain("REUSED")
    expect(text).toContain('next: orchestrate({ action: "land" })')
    // On the workbox, an unmarked detached lane is warned of and still landed.
    const detached = laneAt("/code/.work/app/feat-ui-input", Option.none(), "def5678")
    expect(resolveLand({ action: "land", units: [{ unit: "ui-input", path: detached.path }] }, runs, [detached], true)).toEqual({
      rifts: [{ unit: "ui-input", path: detached.path }],
      warnings: [expect.stringContaining("is detached at def5678, on no branch")],
    })
  })

  test("a marked lane's second round gets its own lane back, on any prefix of its branch", () => {
    for (const workrift of [false, true]) {
      const own = marked(laneOf("billing", workrift))
      expect(laneDecision("billing", "feat/billing", riftNameOf("billing", workrift), workrift, [own, reused])).toEqual({ found: own })
      expect(laneWarnings("billing", own, workrift)).toEqual([])
    }
    const pc = marked(laneAt("/code/.work/app/billing", Option.some("pc/billing")))
    expect(laneDecision("billing", "custom/billing", "billing", false, [pc])).toEqual({ found: pc })
    // A lane made again under a suffix after its name's lane was removed (`billing-2`) is still billing's.
    const again = marked(laneAt("/code/.work/app/billing-2", Option.some("feat/billing")))
    expect([reusedOf(again), strayOf(again, false)]).toEqual([Option.none(), Option.none()])
    expect(laneDecision("billing", "feat/billing", "billing", false, [again])).toEqual({ found: again })
  })

  test("the unit whose branch a marked reused lane holds is made a lane of its own", () => {
    expect(laneDecision("ui-hover-areas", "feat/ui-hover-areas", "ui-hover-areas", false, [reused])).toEqual({ make: "ui-hover-areas" })
  })

  test("a branch that does not name the unit is refused at the lane, with <prefix>/<unit>", () => {
    expect(nameRefusal(decode({ action: "lane", unit: "billing", branch: "fix/invoices" }))).toEqual(Option.some(expect.stringContaining('branch: "fix/billing"')))
    expect(nameRefusal(decode({ action: "lane", unit: "billing", branch: "invoices" }))).toEqual(Option.some(expect.stringContaining('branch: "feat/billing"')))
    for (const branch of ["cristian/billing", "feat/billing", "billing"]) expect(nameRefusal(decode({ action: "lane", unit: "billing", branch }))).toEqual(Option.none())
  })

  test("a land of a marked reused lane refuses with the fix, by name or by path; a land of no units leaves it out", () => {
    for (const unit of ["ui-input", "ui-hover-areas"]) {
      const resolved = resolveLand({ action: "land", units: [unit] }, runs, [reused], false)
      expect(resolved).toEqual({ refused: expect.stringContaining("a lane is never reused for another unit") })
      expect(resolved).toEqual({ refused: expect.stringContaining('orchestrate({ action: "lane", unit: "ui-hover-areas" })') })
    }
    expect(resolveLand({ action: "land", units: [{ unit: "ui-input", path: reused.path }] }, runs, [reused], false)).toEqual({ refused: expect.stringContaining("holds branch wf10/ui-hover-areas") })
    expect(resolveLand({ action: "land" }, runs, [reused], false)).toEqual({ nothing: expect.stringContaining("no unit is ready with a lane") })
    // Once the unit has its own lane, it lands from it, and the reused one is left alone.
    const own = marked(laneOf("ui-hover-areas", false))
    expect(resolveLand({ action: "land", units: ["ui-hover-areas"] }, runs, [reused, own], false)).toEqual({ rifts: [{ unit: "ui-hover-areas", path: own.path }], warnings: [] })
    expect(readyWithLane(runs, [reused, own], false)).toEqual(["ui-hover-areas"])
  })

  test("a marked lane detached mid-rebase: status flags it, land refuses with finish or abort the rebase, never another unit; lane still answers it", () => {
    const rebasing: Lane = { ...laneAt("/code/.work/app/ui-input", Option.none(), "def5678"), madeOn: "feat/ui-input" }
    const resolved = resolveLand({ action: "land", units: ["ui-input"] }, runs, [rebasing], false)
    expect(resolved).toEqual({ refused: expect.stringContaining("is detached at def5678, off feat/ui-input, the branch orchestrate lane made it on: a rebase or merge stopped part way") })
    expect(resolved).toEqual({ refused: expect.stringContaining("Finish or abort the rebase or merge in progress there") })
    expect(resolved).not.toEqual({ refused: expect.stringContaining("another unit") })
    expect(resolveLand({ action: "land", units: [{ unit: "ui-input", path: rebasing.path }] }, runs, [rebasing], false)).toEqual(resolved)
    expect(statusAnswer(runs, [rebasing], false)).toContain(`lane ${rebasing.path} (detached at def5678) · DETACHED: detached at def5678, off feat/ui-input, the branch orchestrate lane made it on; a land of it refuses until it is back on its branch.`)
    expect(laneDecision("ui-input", "feat/ui-input", "ui-input", false, [rebasing])).toEqual({ found: rebasing })
    expect(laneWarnings("ui-input", rebasing, false)).toEqual([expect.stringContaining("orchestrate: warning: ui-input's lane /code/.work/app/ui-input is detached at def5678")])
  })

  test("a land's and a verify's own workspaces are never flagged, detached or on any branch, marked or not", () => {
    const internal = ["verify-batch-1", "verify-batch-2026-11-20p", "integrate", "post-land", "land-accept", "integrate-2"].flatMap((name) => [
      laneAt(`/code/.work/app/${name}`, Option.none(), "def5678"),
      laneAt(`/code/.work/app/${name}`, Option.some("main")),
      { ...laneAt(`/code/.work/app/${name}`, Option.none(), "def5678"), madeOn: "feat/x" },
    ])
    for (const workrift of [false, true])
      for (const lane of internal) {
        expect([lane.path, reusedOf(lane), strayOf(lane, workrift), laneWarnings("x", lane, workrift)]).toEqual([lane.path, Option.none(), Option.none(), []])
      }
    // Status of units named as they are reads them, unflagged.
    const named: ReadonlyArray<Run> = [{ name: "app", units: ["integrate", "post-land", "land-accept", "verify-batch-1"].map((unit) => ({ unit, state: "implement" })) }]
    const text = statusAnswer(named, internal, false)
    expect([text.includes("REUSED"), text.includes("DETACHED"), text.includes("warning")]).toEqual([false, false, false])
    expect(isInternal(laneAt("/code/.work/app/integrate-notices", Option.some("feat/integrate-notices")))).toBe(false)
  })
})

describe("a lane's purpose", () => {
  const decode = Schema.decodeUnknownSync(OrchestrateInput)
  const lane = { ...laneOf("land-notices", false), purpose: "Land notices only when red" }

  test("is taken by lane alone, one line of at most 80 characters", () => {
    expect(inputRefusal(decode({ action: "lane", unit: "billing", purpose: "Bill each seat once" }))).toEqual(Option.none())
    expect(inputRefusal(decode({ action: "land", purpose: "x" }))).toEqual(Option.some(expect.stringContaining("purpose belongs to lane")))
    expect(nameRefusal(decode({ action: "lane", unit: "billing", purpose: "x".repeat(PURPOSE_MAX) }))).toEqual(Option.none())
    for (const purpose of ["x".repeat(PURPOSE_MAX + 1), "two\nlines", "  "]) expect(nameRefusal(decode({ action: "lane", unit: "billing", purpose }))).toEqual(Option.some(expect.stringContaining("one line of plain words")))
  })

  test("shows in the lane's answer, its implementor's description and status; a lane with none answers the hint", () => {
    const answer = laneAnswer("land-notices", lane, true)
    expect(answer).toContain("Purpose: Land notices only when red")
    expect(answer).toContain(`description: "implementor land-notices r1 — Land notices only when red (lane: ${lane.path})"`)
    expect(answer.split("\n").at(-1)).toBe(`(lane: ${lane.path})`)
    const bare = laneAnswer("land-notices", laneOf("land-notices", false), false)
    expect(bare).toContain(purposeHint("land-notices"))
    expect(bare).toContain(`description: "implementor land-notices r1 (lane: ${lane.path})"`)
    expect(statusAnswer([{ name: "app", units: [{ unit: "land-notices", state: "implement" }] }], [lane], false)).toContain(`lane ${lane.path} (branch feat/land-notices) — Land notices only when red`)
    expect(implementorDescriptionOf("land-notices", 2, lane)).toBe(`implementor land-notices r2 — Land notices only when red (lane: ${lane.path})`)
  })
})

describe("the naming rule warns, never refuses", () => {
  const lanes = (...names: ReadonlyArray<string>) => names.map((name) => laneOf(name, false))

  test("a name ending in a round, one that is only a code, and one with the prefix every other lane shares each warn with what to use", () => {
    expect(namingWarnings("poll-entry-r2", [])).toEqual([expect.stringMatching(/ends in a round: .* Name it poll-entry\.$/)])
    expect(namingWarnings("np12m", [])).toEqual([expect.stringContaining("is only a code")])
    expect(namingWarnings("wf10-ui-input", lanes("wf10-flip", "wf10-nb-cut"))).toEqual([expect.stringContaining("Name it ui-input, and pass the run as run: \"wf10\"")])
    expect(namingWarnings("wf10-wt1a", lanes("wf10-flip", "wf10-nb-cut"))).toHaveLength(2)
  })

  test("a clean name warns of nothing, nor does a prefix one other lane or a verify checkout shares", () => {
    expect(namingWarnings("land-notices-red", lanes("billing", "upstream-sync"))).toEqual([])
    expect(namingWarnings("lane-names", lanes("lane-accept"))).toEqual([])
    expect(namingWarnings("lane-names", [...lanes("lane-accept"), laneAt("/code/.rifts/app/verify-batch-1", Option.none())])).toEqual([])
    expect(namingWarnings("ui-input", lanes("ui-hover", "ui-group"))).toEqual([expect.stringContaining("starts with ui")])
    expect(namingWarnings("partner", lanes("ui-hover", "ui-group"))).toEqual([])
  })

  test("the warnings head the lane's answer, which still makes the lane", () => {
    const answer = laneAnswer("poll-entry-r2", laneOf("poll-entry-r2", false), true, namingWarnings("poll-entry-r2", []))
    expect(answer.split("\n")[0]).toContain("orchestrate: warning: poll-entry-r2 ends in a round")
    expect(answer).toContain("; made now.")
  })
})

// ── The land ──

describe("a land", () => {
  const alpha = laneOf("alpha", false)
  const beta = laneOf("beta", false)
  const runs: ReadonlyArray<Run> = [
    {
      name: "app",
      units: [
        { unit: "alpha", state: "ready" },
        { unit: "beta", state: "blocked" },
        { unit: "gamma", state: "ready" },
      ],
    },
  ]

  test("with no units takes every unit the run tables show ready with one lane; with none, it says what to name", () => {
    expect(resolveLand({ action: "land" }, runs, [alpha, beta], false)).toEqual({ rifts: [{ unit: "alpha", path: alpha.path }], warnings: [] })
    const nothing = resolveLand({ action: "land" }, runs, [beta], false)
    expect(nothing).toEqual({ nothing: expect.stringContaining("no unit is ready with a lane, so nothing landed") })
    expect(nothing).toEqual({ nothing: expect.stringContaining("Ready with no lane or two: alpha, gamma.") })
  })

  test("a named unit not ready lands with a warning; one the tables do not hold, or given as { unit, path }, lands with none", () => {
    expect(resolveLand({ action: "land", units: ["alpha", "beta"] }, runs, [alpha, beta], false)).toEqual({
      rifts: [
        { unit: "alpha", path: alpha.path },
        { unit: "beta", path: beta.path },
      ],
      warnings: [warningOf("beta", "blocked")],
    })
    expect(warningOf("beta", "blocked")).toBe("orchestrate: warning: beta is blocked, not ready; landed as asked.")
    const delta = laneOf("delta", false)
    expect(resolveLand({ action: "land", units: ["delta", { unit: "zeta", path: "/x/zeta" }] }, runs, [delta], false)).toEqual({
      rifts: [
        { unit: "delta", path: delta.path },
        { unit: "zeta", path: "/x/zeta" },
      ],
      warnings: [],
    })
    expect(landAnswer([warningOf("beta", "blocked")], "Landed.").split("\n")[0]).toBe(warningOf("beta", "blocked"))
  })

  test("a name two Rifts read as is never picked: the refusal names both and the { unit, path } form", () => {
    const other = laneAt("/code/.work/app/db-2", Option.some("p5/db"))
    const db = laneOf("db", false)
    const resolved = resolveLand({ action: "land", units: ["db"] }, runs, [db, other], false)
    expect(resolved).toEqual({ refused: expect.stringContaining(`2 workspaces read as db: ${db.path}, ${other.path}`) })
    expect(resolved).toEqual({ refused: expect.stringContaining('{ unit: "db", path: "<its workspace>" }') })
  })
})

describe("status", () => {
  test("lists each run's units, an open one with its lane, and one next line", () => {
    const alpha = laneOf("alpha", false)
    const runs: ReadonlyArray<Run> = [
      {
        name: "app",
        units: [
          { unit: "alpha", state: "ready" },
          { unit: "beta", state: "implement" },
          { unit: "gamma", state: "merged abc1234" },
        ],
      },
    ]
    expect(statusAnswer(runs, [alpha], false)).toBe(
      [
        "orchestrate: run app:",
        `- alpha: ready · lane ${alpha.path} (branch feat/alpha)`,
        "- beta: implement · no lane",
        "- gamma: merged abc1234",
        'next: orchestrate({ action: "land" }) (ready with a lane: alpha).',
      ].join("\n"),
    )
    expect(nextLine(runs, [], false)).toBe("next: wait for the hand-backs of beta (implementing).")
    expect(nextLine([], [], false)).toBe("next: none (no unit is ready with a lane or implementing, and no verify is due).")
    expect(statusAnswer([{ name: "app", units: [] }], [alpha], false)).toBe(NO_UNITS)
  })
})

// ── B4: next reads the derived table ──

const STATES = ["plan", "implement", "ready", "verify", "blocked", "merged abc1234", "dropped", "waiting(pr)"]

describe("next", () => {
  const due: MainSince = { branch: "main", head: shaOf(1000), base: shaOf(7), lands: VERIFY_EVERY, last: Option.none() }
  const nextCases = Arr.range(0, 10).flatMap((index) => (["land", "verify"] as const).map((action) => ({ index, action, name: `next ${index}: ${action}` })))
  test("W: every next case recommends its ready land or due verify", () => {
    const ran: Array<string> = []
    for (const { index, action, name } of nextCases) {
      const unit = `ready-${index}`
      const inputs = (cause: boolean) => {
        if (action === "land") return {
          runs: [{ name: unit, units: [{ unit, state: "ready" }] }],
          lanes: [laneOf(unit, false)].filter(() => cause),
          main: Option.some(due),
        }
        return { runs: [], lanes: [], main: Option.filter(Option.some({ ...due, lands: due.lands + index }), () => cause) }
      }
      ran.push(assertWitness(name, [Option.some(action)], (cause) => {
        const { runs, lanes, main } = inputs(cause)
        const next = nextOf(runs, lanes, false, main, NOW)
        const decoded = decodedIn(next.line)
        const named = decoded.map(({ decoded }) => Option.map(decoded, (input) => input.action))
        if (cause) {
          expect(decoded.map((call) => call.decoded)).toEqual([next.input])
          expectCallsDecode(next.line)
        } else {
          expect(named, "control setup produced the alternate decision").toEqual([Option.some<"verify">("verify")].filter(() => action === "land"))
        }
        return named
      }))
    }
    expect(ran.toSorted()).toEqual(nextCases.map((each) => each.name).toSorted())
  })
  test("B4: over generated derived tables, next names a call that decodes, and a land only for a unit ready with a lane", () => {
    for (const seed of SEEDS) {
      const random = rng(seed)
      const pick = pickOf(random)
      const workrift = random() < 0.5
      const runs: ReadonlyArray<Run> = Array.from({ length: 1 + Math.floor(random() * 2) }, (_, n) => ({
        name: `run${n}`,
        units: UNITS.flatMap((unit) => Option.toArray(Option.liftPredicate(unit, () => random() < 0.6))).map((unit) => ({ unit, state: pick(STATES, "plan") })),
      }))
      const lanes = UNITS.flatMap((name) => Option.toArray(Option.liftPredicate(laneOf(name, workrift), () => random() < 0.5)))
      const since = sometimes(random, 0.3, () => sinceOf(random))
      const next = nextOf(runs, lanes, workrift, since, NOW)
      const calls = decodedIn(next.line)
      expect({ seed, calls: calls.length }).toEqual({ seed, calls: Option.toArray(next.input).length })
      expectCallsDecode(next.line)
      for (const { decoded } of calls) expect({ seed, decoded }).toEqual({ seed, decoded: next.input })
      const ready = readyWithLane(runs, lanes, workrift)
      const units = runs.flatMap((run) => run.units)
      Option.map(next.input, (input) => {
        if (input.action === "land") {
          // A land with no units lands every unit ready with a lane: there is one; one that names units names only those.
          expect({ seed, ready: ready.length > 0 }).toEqual({ seed, ready: true })
          for (const named of input.units ?? []) expect({ seed, named, ready: ready.includes(landNameOf(named)) }).toEqual({ seed, named, ready: true })
        }
        if (input.action === "verify") {
          expect({ seed, ready, due: Option.exists(since, (each) => isDue(each, NOW)) }).toEqual({ seed, ready: [], due: true })
        }
      })
      // Wait and none name no call, and come after a land and a due verify.
      if (Option.isNone(next.input)) {
        expect({ seed, ready, due: Option.exists(since, (each) => isDue(each, NOW)) }).toEqual({ seed, ready: [], due: false })
        const waits = units.some((unit) => unit.state === "implement")
        expect({ waits, line: next.line }).toEqual({
          waits,
          line: Option.match(Option.liftPredicate(waits, (each) => each), {
            onSome: () => expect.stringContaining("next: wait for the hand-backs of"),
            onNone: () => "next: none (no unit is ready with a lane or implementing, and no verify is due).",
          }),
        })
      }
    }
  })
})

// ── Main since the last verify ──

describe("a verify of main", () => {
  const since = (lands: number, last: Option.Option<Verified>): MainSince => ({ branch: "main", head: shaOf(1000), base: shaOf(7), lands, last })
  const verifiedAt = (at: number): Option.Option<Verified> => Option.some({ file: "/run/verify-a/batch-a.md", head: shaOf(42), at })

  test(`is due at ${VERIFY_EVERY} lands, or one land once the last is ${VERIFY_MAX_AGE_MS / HOUR} h old`, () => {
    for (const lands of [0, 1, 4, 5, 9])
      for (const age of [0, 23, 24, 30])
        for (const last of [verifiedAt(NOW - age * HOUR), Option.none<Verified>()]) {
          const due = lands >= VERIFY_EVERY || (lands >= 1 && Option.isSome(last) && age >= 24)
          expect({ lands, age, last: Option.isSome(last), due: isDue(since(lands, last), NOW) }).toEqual({ lands, age, last: Option.isSome(last), due })
          expect(Option.isSome(dueWarning(since(lands, last), NOW))).toBe(due)
        }
    expect(dueWarning(since(5, verifiedAt(NOW - 26 * HOUR)), NOW)).toEqual(
      Option.some(`orchestrate: 5 lands on main since the last verify (${shaOf(42).slice(0, 7)}, 26 h ago): ${VERIFY_CALL}.`),
    )
    expect(dueWarning(since(1, verifiedAt(NOW - 24 * HOUR)), NOW)).toEqual(Option.some(`orchestrate: 1 land on main since the last verify (${shaOf(42).slice(0, 7)}, 24 h ago): ${VERIFY_CALL}.`))
    expect(Option.getOrElse(dueWarning(since(5, Option.none()), NOW), () => "")).toContain(`none recorded; counted from ${shaOf(7).slice(0, 7)}`)
  })

  test("counts a fast-forward land like a merge: the units whose request head the range holds, or the merges when more", () => {
    // ce: since 2541c442, run-state landed by a fast-forward (no merge commit) and skill-modes by a merge: two lands.
    const range = ["a1b2c3d".padEnd(40, "1"), "e4f5a6b".padEnd(40, "2")]
    expect([inRange(range, "e4f5a6b".padEnd(40, "2")), inRange(range, "a1b2c3d"), inRange(range, "a1b2c3e"), inRange(range, shaOf(304))]).toEqual([true, true, false, false])
    expect(landsOf(1, 2)).toBe(2)
    // A merge with no unit dir behind it (a land the run does not hold) still counts.
    expect(landsOf(3, 1)).toBe(3)
    expect(landsOf(0, 0)).toBe(0)
  })

  test("counts from the last verified head; with none, from the fifth first-parent merge back, never the whole history", () => {
    const merges = Array.from({ length: 8 }, (_, n) => ({ sha: shaOf(100 + n), parent: shaOf(200 + n), subject: `m${n}` }))
    expect(verifyBaseOf(shaOf(1000), verifiedAt(NOW), merges)).toBe(shaOf(42))
    expect(verifyBaseOf(shaOf(1000), Option.none(), merges)).toBe(shaOf(105))
    expect(verifyBaseOf(shaOf(1000), Option.none(), merges.slice(0, 3))).toBe(shaOf(202))
    expect(verifyBaseOf(shaOf(1000), Option.none(), [])).toBe(shaOf(1000))
  })

  test("its batch file names Base and Head in full, the fleet's Heads line as git/fleet.ts reads it, the merges and the units", () => {
    const batch: MainBatch = {
      name: mainVerifyName(shaOf(1000)),
      base: shaOf(42),
      head: shaOf(1000),
      last: verifiedAt(NOW),
      merges: [{ sha: shaOf(501), parent: shaOf(500), subject: "Merge branch 'feat/u1'" }],
      units: [{ unit: "u1", dir: "/run/u1", round: 2, spec: "/run/u1/spec.md", request: "/run/u1/round-2-request.md" }],
      heads: Option.some({ dotfiles: shaOf(1000), fork: shaOf(77) }),
    }
    const text = mainBatchText(batch)
    const lines = text.split("\n")
    expect(lines).toContain(`Base: ${shaOf(42)}`)
    expect(lines).toContain(`Head: ${shaOf(1000)}`)
    expect(lines.filter((line) => /^Heads: dotfiles=[0-9a-f]{40} fork=[0-9a-f]{40}$/.test(line))).toEqual([`Heads: dotfiles=${shaOf(1000)} fork=${shaOf(77)}`])
    expect(text).toContain(`- ${shaOf(501).slice(0, 10)} Merge branch 'feat/u1'`)
    expect(text).toContain("- u1 r2: unit dir /run/u1, spec /run/u1/spec.md, request /run/u1/round-2-request.md")
    expect(batchHeadOf(text)).toEqual(Option.some(shaOf(1000)))
    expect(mainBatchText({ ...batch, heads: Option.none() })).not.toMatch(/^heads:/im)
    expect(mainBatchPathOf("/run/", batch.name)).toBe(`/run/verify-main-${shaOf(1000).slice(0, 7)}/batch-main-${shaOf(1000).slice(0, 7)}.md`)
  })

  test("writes into the run dir holding a unit in its range; with none or several, the first orchestrate.dir, else the first run", () => {
    const unit = (dir: string) => ({ unit: "u", dir, round: 1, spec: `${dir}/spec.md`, request: `${dir}/round-1-request.md` })
    const a = "/repo/tmp/orchestrate/a"
    const b = "/repo/tmp/orchestrate/b"
    const flat = "/tmp/opencode"
    expect(mainRunDirOf([a, b, flat], [unit(`${b}/u`)])).toEqual(Option.some(b))
    expect(mainRunDirOf([a, b, flat], [unit(`${a}/u`), unit(`${b}/v`)])).toEqual(Option.some(flat))
    expect(mainRunDirOf([a, b], [])).toEqual(Option.some(a))
    expect(mainRunDirOf([], [])).toEqual(Option.none())
  })
})

describe("a unit's files", () => {
  const files = (request: Option.Option<number>, findings: Option.Option<readonly [number, string]>): UnitFiles => ({
    unit: "u",
    dir: "/run/u",
    request: Option.map(request, (round) => ({ round, path: `/run/u/round-${round}-request.md`, head: Option.some(shaOf(1)) })),
    findings: Option.map(findings, ([round, verdict]) => ({ round, path: `/run/u/round-${round}-findings.md`, verdict: Option.some(verdict) })),
  })

  test("a land warns of a changes verdict not older than the newest request, and of no other", () => {
    expect(changesWarnings([files(Option.some(1), Option.some([1, "changes"]))])).toEqual([changesWarningOf("u", 1, "/run/u/round-1-findings.md")])
    expect(changesWarningOf("u", 1, "/p")).toBe("orchestrate: warning: u lands with r1's changes verdict open (/p).")
    expect(changesWarnings([files(Option.none(), Option.some([2, "changes"]))])).toHaveLength(1)
    expect(changesWarnings([files(Option.some(2), Option.some([1, "changes"]))])).toEqual([])
    expect(changesWarnings([files(Option.some(1), Option.some([1, "accepted"]))])).toEqual([])
    expect(changesWarnings([files(Option.some(1), Option.none())])).toEqual([])
  })

  test("the request's head (its Head:, or a range's right side); the verdict is the findings' first line's", () => {
    expect(requestHeadOf(`Head: ${shaOf(9)}\n`)).toEqual(Option.some(shaOf(9)))
    expect(requestHeadOf("- base 1234567, head commit abcdef01.")).toEqual(Option.some("abcdef01"))
    expect(requestHeadOf("Range 1234567..89abcde, 3 files")).toEqual(Option.some("89abcde"))
    expect(requestHeadOf("no head here")).toEqual(Option.none())
    expect(findingsVerdictOf("\nverifier batch-3 r1: CHANGES /x\nAccepted later")).toEqual(Option.some("changes"))
    expect(findingsVerdictOf("# Findings\naccepted")).toEqual(Option.none())
    expect(holdsVerdict("Verdict: ACCEPTED\n")).toBe(true)
    expect(holdsVerdict("intro\n\nverifier main-abc1234 r1: changes /x\n")).toBe(true)
    expect(holdsVerdict("nothing decided yet\n")).toBe(false)
  })

  test("the land's pushed commit and a unit's round, as the log's move takes them", () => {
    expect(pushedOf("Landed 2 workspace(s) as one push: abc1234 Merge into main to main (merged feat/a, feat/b; by their receipts, no full gate).")).toEqual(Option.some("abc1234"))
    // A rift plugin from before the words changed (a rollback) still names its push.
    expect(pushedOf("Landed 1 Rift(s) as one push: def5678 feat: x to main (merged feat/x; the gate passed in 3s).")).toEqual(Option.some("def5678"))
    expect(pushedOf("Checked 1 workspace(s) as one batch in /x on main since 1234567; rift.push is false")).toEqual(Option.none())
    const runs: ReadonlyArray<Run> = [{ name: "app", units: [{ unit: "a", state: "ready", round: "3" }, { unit: "b", state: "ready" }] }]
    expect([roundIn("a", runs), roundIn("b", runs), roundIn("c", runs)]).toEqual([Option.some(3), Option.some(1), Option.none()])
  })
})
