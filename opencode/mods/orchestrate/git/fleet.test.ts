import { describe, expect, test } from "bun:test"
import { Option } from "effect"
import { FleetOutcome, fleetLineOf } from "../fleet.ts"
import { batchFileOf, headsOf, missingOf, sameAs } from "./fleet.ts"

const D1 = "1".repeat(40)
const D2 = "2".repeat(40)
const F1 = "a".repeat(40)
const F2 = "b".repeat(40)

const heads = (dotfiles: Option.Option<string>, fork: Option.Option<string>) => ({ dotfiles, fork })

describe("the verified target an accepted batch records", () => {
  test("B3: the heads come from the batch file's header, in each form the orchestrator writes it", () => {
    const cases: ReadonlyArray<readonly [string, ReturnType<typeof heads>]> = [
      ["Dotfiles: base 4add04ba, head 452ac9c9; Rift /r/dotfiles/verify-1112w detached at it.", heads(Option.some("452ac9c9"), Option.none())],
      [
        "Dotfiles: base 0a749179, head 956fb113; your Rift /r/verify-1112n is detached at it. Fork prime-look: base 8ad069aebe (batch m), head 312da8de96 (daily's upstream merge).",
        heads(Option.some("956fb113"), Option.some("312da8de96")),
      ],
      ["Dotfiles: base fb1a4b09, head cae5b1cf (origin/main); your Rift /r/verify-1111g is detached at it. Fork unchanged (13a380890b).", heads(Option.some("cae5b1cf"), Option.some("13a380890b"))],
      ["Dotfiles: base 21b6372d, head 1cd183bb (origin/main). Fork unchanged (prime-look 13a380890b).", heads(Option.some("1cd183bb"), Option.some("13a380890b"))],
      ["Dotfiles: 0eb81d14 (no dotfiles change; your Rift /r/verify-1111l). Fork prime-look: base 484d7f1042 (accepted in batch k), head 5c088c6dc3.", heads(Option.some("0eb81d14"), Option.some("5c088c6dc3"))],
      ["Dotfiles: base f0581cb3, head 947768ed; your Rift is detached at it. Fork prime-look a5777f303a (unchanged).", heads(Option.some("947768ed"), Option.some("a5777f303a"))],
      ["Dotfiles: base ea3e2db7, head f0581cb3 (lands 3472fd43, f0581cb3). Fork prime-look: a5777f303a (upstream merge of 2 commits).", heads(Option.some("f0581cb3"), Option.some("a5777f303a"))],
      ["# batch q\n\nFork (anomalyco fork, branch prime-look): base a15bd0c6f4, head f785c92b7e; checkout at it.", heads(Option.none(), Option.some("f785c92b7e"))],
      ["- Dotfiles source containing landed head: `/r/integrate`, head `8874a7d267abb8a46c1684c8c99476d11a2e6e2f`.", heads(Option.some("8874a7d267abb8a46c1684c8c99476d11a2e6e2f"), Option.none())],
      ["Dotfiles: base 65bd0ae9, head origin/main (push-window merge).", heads(Option.none(), Option.none())],
      ["Verify the units below and decide.", heads(Option.none(), Option.none())],
    ]
    for (const [text, expected] of cases) expect([text, headsOf(text)]).toEqual([text, expected])
  })

  test("the first header that names a head wins over later prose", () => {
    expect(headsOf("Dotfiles: base 1111111a, head 2222222b.\n\nThe dotfiles head 3333333c was rejected. Fork prime-look: base 4444444d, head 5555555e.")).toEqual(
      heads(Option.some("2222222b"), Option.some("5555555e")),
    )
  })

  test("an arrow marks the head, never the base", () => {
    expect(headsOf("Dotfiles: base 1111111a, head 2222222b. Fork: 5df8da5195 → 0efbe2f0ab (upstream merge).")).toEqual(heads(Option.some("2222222b"), Option.some("0efbe2f0ab")))
    expect(headsOf("Dotfiles: 1111111a -> 2222222b. Fork: 5df8da5195→0efbe2f0ab")).toEqual(heads(Option.some("2222222b"), Option.some("0efbe2f0ab")))
  })

  test("a part naming two commits with no head marked is unreadable, so the publish refuses instead of guessing", () => {
    const named = headsOf("Dotfiles: base 1111111a, head 2222222b. Fork: 5df8da5195 and 0efbe2f0ab.")
    expect(named).toEqual(heads(Option.some("2222222b"), Option.none()))
    expect(missingOf(named)).toEqual(["the fork head (`Fork prime-look: base X, head Y` or `Fork unchanged (Y)`)"])
    expect(headsOf("Fork: base 5df8da5195, 0efbe2f0ab")).toEqual(heads(Option.none(), Option.none()))
    expect(headsOf("Fork: 1111111a → 2222222b, head 3333333c")).toEqual(heads(Option.none(), Option.none()))
    expect(headsOf("Fork: 5df8da5195 and 0efbe2f0ab. Fork prime-look: base 1111111a, head 2222222b")).toEqual(heads(Option.none(), Option.none()))
  })

  test("M1: a batch file must name both heads; it says which it lacks, and no kept commit stands in", () => {
    expect(missingOf(heads(Option.some(D2), Option.some(F2)))).toEqual([])
    expect(missingOf(heads(Option.some(D2), Option.none()))).toEqual(["the fork head (`Fork prime-look: base X, head Y` or `Fork unchanged (Y)`)"])
    expect(missingOf(heads(Option.none(), Option.some(F2)))).toEqual(["the dotfiles head (`Dotfiles: base X, head Y`)"])
    expect(missingOf(heads(Option.none(), Option.none()))).toHaveLength(2)
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
