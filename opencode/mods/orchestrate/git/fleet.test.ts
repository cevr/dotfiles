import { describe, expect, test } from "bun:test"
import { Option, Result } from "effect"
import { FleetOutcome, fleetLineOf } from "../fleet.ts"
import { batchFileOf, headsOf, sameAs } from "./fleet.ts"

const D1 = "1".repeat(40)
const D2 = "2".repeat(40)
const F1 = "a".repeat(40)
const F2 = "b".repeat(40)

const LINE = `Heads: dotfiles=${D2} fork=${F2}`

/** What `headsOf` answers, as plain data: the commits, or why it refuses. */
const read = (text: string) => Result.match(headsOf(text), { onSuccess: (commits) => ({ commits }), onFailure: (why) => ({ why }) })

describe("the verified target an accepted batch records", () => {
  test("the heads come from the one heads line alone; prose around it, whatever commits it names, is never read", () => {
    const prose = "# batch bf\n\nDotfiles: base 1111111a, head 2222222b. Fork: 5df8da5195 → 0efbe2f0ab (…).\nThe Heads: line below is what publishes.\n"
    expect(read(`${prose}\n${LINE}\n\n- unit alpha: round 1`)).toEqual({ commits: { dotfiles: D2, fork: F2 } })
    expect(read(`${LINE}\r\nmore\r\n`)).toEqual({ commits: { dotfiles: D2, fork: F2 } })
  })

  test("a batch file with no heads line refuses, naming the form, even when its prose names heads", () => {
    for (const text of ["", "Dotfiles: base 1111111a, head 2222222b. Fork prime-look: base 4444444d, head 5555555e.", "Fork unchanged (13a380890b)."])
      expect([text, read(text)]).toEqual([text, { why: "has no heads line; write one, exactly `Heads: dotfiles=<40-hex sha> fork=<40-hex sha>`" }])
  })

  test("two heads lines refuse, even when they agree", () => {
    expect(read(`${LINE}\n${LINE}`)).toEqual({ why: "has 2 heads lines; write one, exactly `Heads: dotfiles=<40-hex sha> fork=<40-hex sha>`" })
    expect(read(`${LINE}\nHeads: dotfiles=${D1} fork=${F1}\n- Heads: dotfiles=${D1} fork=${F1}`)).toEqual({
      why: "has 3 heads lines; write one, exactly `Heads: dotfiles=<40-hex sha> fork=<40-hex sha>`",
    })
  })

  test("a heads line not exactly in the form refuses, naming the form: short, uppercase or mislabelled hashes are never resolved here", () => {
    const malformed = [
      `Heads: dotfiles=${D2.slice(0, 8)} fork=${F2}`,
      `Heads: dotfiles=${D2} fork=${F2.slice(0, 10)}`,
      `Heads: dotfiles=${D2}0 fork=${F2}`,
      `Heads: dotfiles=${D2} fork=${F2.toUpperCase()}`,
      `Heads: dotfiles=${"g".repeat(40)} fork=${F2}`,
      `Heads: fork=${F2} dotfiles=${D2}`,
      `Heads: dotfiles=${D2}`,
      `Heads: dotfiles=${D2} fork=${F2} (upstream merge)`,
      `Heads: dotfiles=${D2}  fork=${F2}`,
      `Heads: dotfiles: ${D2} fork: ${F2}`,
      `heads: dotfiles=${D2} fork=${F2}`,
      `HEADS: dotfiles=${D2} fork=${F2}`,
      `  Heads: dotfiles=${D2} fork=${F2}`,
      `- Heads: dotfiles=${D2} fork=${F2}`,
      `\`Heads: dotfiles=${D2} fork=${F2}\``,
      `Heads: dotfiles=${D2} fork=${F2} `,
      "Heads:",
    ]
    for (const line of malformed) {
      const answer = read(`# batch\n\n${line}\n`)
      expect([line, "why" in answer && answer.why.startsWith("has a malformed heads line (")]).toEqual([line, true])
      expect([line, "why" in answer && answer.why.endsWith("; write it exactly `Heads: dotfiles=<40-hex sha> fork=<40-hex sha>`, both full commit names")]).toEqual([line, true])
    }
  })

  test("M1, M2: a refusal reads as NOT published, stamped, where the orchestrator reads it; a host with no checkouts says nothing", () => {
    const at = 1794506700000
    expect(fleetLineOf("batch-x", FleetOutcome.Refused({ reason: "the batch file lacks the fork head" }), at)).toEqual([
      "2026-11-12T18:05Z fleet: batch-x accepted, but NOT published: the batch file lacks the fork head. Every host stays on the last published target.",
    ])
    expect(fleetLineOf("batch-y", FleetOutcome.Recorded({ target: { dotfiles: D2, fork: F2, batch: "batch-y" } }), at)).toEqual([`2026-11-12T18:05Z fleet: batch-y accepted; published the verified target dotfiles ${D2.slice(0, 10)}, fork ${F2.slice(0, 10)}`])
    expect(fleetLineOf("batch-z", FleetOutcome.Off(), at)).toEqual([])
  })

  test("the batch file sits beside the verifier's report", () => {
    expect(batchFileOf("/t/verify-1112w/batch-2026-11-12w-findings.md", "batch-2026-11-12w")).toBe("/t/verify-1112w/batch-2026-11-12w.md")
  })

  test("recording the commits already recorded moves nothing", () => {
    const current = Option.some({ dotfiles: D1, fork: F1 })
    expect(sameAs({ dotfiles: D1, fork: F1 }, current)).toBe(true)
    expect(sameAs({ dotfiles: D2, fork: F1 }, current)).toBe(false)
    expect(sameAs({ dotfiles: D1, fork: F1 }, Option.none())).toBe(false)
  })
})
