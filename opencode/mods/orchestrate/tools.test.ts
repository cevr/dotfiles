// The `orchestrate` tool's domain (tools.ts), as the model reads it: the one description and its order, every
// call an answer or a refusal names (each decodes and passes the input rule), the input rule over its whole
// domain, the rule that names a unit's Rift, a land's resolution from the run tables and the Rift list, and
// status. The tool on a simulated host runs in cmd/orchestrate/orch-tools.sim.test.ts.
import { describe, expect, test } from "bun:test"
import { Option, Schema } from "effect"
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
  laneDecision,
  lanesOf,
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
    expect(paragraphs[headings.indexOf("implement")]).toContain('subagent({ agent: "implementor", description: "implementor <unit> r1 (rift: <path>)"')
    expect(paragraphs[headings.indexOf("verify")]).toContain('subagent({ agent: "verifier", description: "verifier <batch> r1"')
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

/** A run table of `units`, each in a generated state. */
const runOf = (random: () => number, units: ReadonlyArray<string>): Run => {
  const pick = pickOf(random)
  return { name: "app", units: units.map((unit) => ({ unit, state: pick(["implement", "ready", "blocked", "verify", "merged abc1234", "plan"], "ready") })) }
}

/** Every text tools.ts writes, over generated run tables, lanes and input. */
const textsOf = (random: () => number): ReadonlyArray<string> => {
  const pick = pickOf(random)
  const runs = [runOf(random, UNITS.filter(() => random() < 0.7))]
  const unit = pick([...UNITS, unitName(random)], "alpha")
  const workrift = random() < 0.5
  const lanes = UNITS.flatMap((name) => Option.toArray(Option.liftPredicate(laneOf(name, workrift), () => random() < 0.6)))
  const lane = pick(lanes, laneAt(`/code/.rifts/app/${unit}`, Option.none()))
  const input = inputOf(random)
  const units = UNITS.flatMap((name) => Option.toArray(Option.liftPredicate(pick<LandUnit>([name, { unit: name, path: `/x/${name}` }], name), () => random() < 0.4)))
  return [
    ...Option.toArray(inputRefusal(input)),
    ...Option.toArray(nameRefusal(input)),
    ...ACTIONS.map(parentRefusal),
    laneAnswer(unit, lane, random() < 0.5),
    landAnswer([warningOf(unit, "blocked")], "Landed 1 Rift(s) as one push."),
    verifyAnswer(`batch-${Math.floor(random() * 9)}`, lane, random() < 0.5, pick(["given", "origin"] as const, "origin")),
    NO_UNITS,
    statusAnswer(runs, lanes, workrift),
    LAND_NEXT,
    nextLine(runs, lanes, workrift),
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

describe("every call an answer or a refusal names", () => {
  test("decodes through OrchestrateInput and passes the input rule, over generated run tables, lanes and inputs", () => {
    let calls = 0
    for (const seed of SEEDS) {
      const texts = textsOf(rng(seed))
      for (const text of texts) {
        calls += callsIn(text).length
        expectCallsDecode(text)
        expect(text).not.toContain('rift({ action: "land"')
        expect(text).not.toContain("machine")
      }
    }
    expect(calls).toBeGreaterThan(SEEDS.length * 8)
  })
})

// ── The input rule ──

/** A generated value for a field: a unit name, a list of units, a batch, a commit, a reason. */
const valueOf = (field: Field, random: () => number) => {
  const pick = pickOf(random)
  const name = unitName(random)
  if (field === "units") return [name, { unit: pick(UNITS, "alpha"), path: `/code/.rifts/app/${name}` }].filter(() => random() < 0.7)
  if (field === "batch") return pick([`batch-${1 + Math.floor(random() * 20)}`, name, "main-abc1234"], "batch-1")
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
    expect(inputRefusal(decode({ action: "land", departs: "an old root's reason" }))).toEqual(Option.none())
    expect(inputRefusal(decode({ action: "verify" }))).toEqual(Option.some(expect.stringContaining("verify needs batch")))
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
  Option.getOrElse(Option.map(Option.liftPredicate(laneBranchOf({ unit }), () => workrift), (branch) => branch.replaceAll("/", "-")), () => unit)

/** The Rift a lane makes for `unit` on its default branch: named for the unit on the Mac, for its branch (`feat-<unit>`) on the workbox. */
const laneOf = (unit: string, workrift: boolean): Lane => {
  const branch = laneBranchOf({ unit })
  return laneAt(`/code/.rifts/app/${riftNameOf(unit, workrift)}`, Option.some(branch))
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
      expect(resolveLand({ action: "land", units: ["feat-y"] }, runs, [y], workrift)).toEqual({ refused: expect.stringContaining("no Rift of the warm source reads as feat-y") })
      expect(resolveLand({ action: "land" }, runs, [y], workrift)).toEqual({ rifts: [{ unit: "y", path: y.path }], warnings: [] })
    }
  })

  test("the branch is the one given, else <run>/<unit>, else feat/<unit>", () => {
    expect(laneBranchOf({ unit: "billing" })).toBe("feat/billing")
    expect(laneBranchOf({ unit: "billing", run: "pc" })).toBe("pc/billing")
    expect(laneBranchOf({ unit: "billing", run: "pc", branch: "fix/bill" })).toBe("fix/bill")
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
    const other = laneAt("/code/.rifts/app/db-2", Option.some("p5/db"))
    const db = laneOf("db", false)
    const resolved = resolveLand({ action: "land", units: ["db"] }, runs, [db, other], false)
    expect(resolved).toEqual({ refused: expect.stringContaining(`2 Rifts read as db: ${db.path}, ${other.path}`) })
    expect(resolved).toEqual({ refused: expect.stringContaining('{ unit: "db", path: "<its Rift>" }') })
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
    expect(nextLine([], [], false)).toBe("next: none (no unit is ready with a lane or implementing).")
    expect(statusAnswer([{ name: "app", units: [] }], [alpha], false)).toBe(NO_UNITS)
  })
})
