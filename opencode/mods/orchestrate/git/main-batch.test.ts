// A verify of main publishes the fleet target like any batch: the batch file it writes is the one git/fleet.ts reads
// beside its verifier's findings when the verdict is accepted, and that file's heads line is the one fleet reads. A batch
// file names its head as the fleet reads it, so the verify-due count starts where the fleet's target is.
import { expect, test } from "bun:test"
import { Array as Arr, Option, Result } from "effect"
import { batchHeadOf, mainBatchPathOf, mainBatchText, mainFindingsPathOf, mainVerifyName, UNIT_NAME } from "../tools.ts"
import { batchFileOf, headsOf } from "./fleet.ts"

const shaOf = (n: number) => n.toString(16).padStart(40, "0")

test("a verify of main's batch file is the one the fleet reads when its verifier's findings are accepted", () => {
  const head = "abc1234".padEnd(40, "0")
  const name = mainVerifyName(head)
  const file = mainBatchPathOf("/run", name)
  // The names round 2 settled: batch `batch-main-<short>`, file `verify-main-<short>/batch-main-<short>.md`.
  expect([name, file]).toEqual(["batch-main-abc1234", "/run/verify-main-abc1234/batch-main-abc1234.md"])
  // The verifier is `verifier <name> r1`; its findings sit beside the batch file, and batchFileOf reads `<dir>/<batch>.md`.
  expect(batchFileOf(mainFindingsPathOf(file), name)).toBe(file)
  expect(UNIT_NAME.test(name)).toBe(true)
  const text = mainBatchText({ name, base: shaOf(7), head, last: Option.none(), merges: [], units: [], heads: Option.some({ dotfiles: head, fork: shaOf(77) }) })
  expect(headsOf(text)).toEqual(Result.succeed({ dotfiles: head, fork: shaOf(77) }))
})

/** The generator the opencode tests use: a seeded stream, so a failure names its seed. */
const rng = (seed: number) => {
  let state = seed
  return () => {
    state = (state + 0x6d2b79f5) | 0
    let t = Math.imul(state ^ (state >>> 15), 1 | state)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const PROSE = ["# batch-2026-11-15cd", "Base: 2541c442fd9644ce479324225493121a7acaf8b4 (batch cc's head).", "Land: on receipts.", "- run-state r2 (c6a77001: …).", "Owner policy: block only on a failure."]

test("a batch file's head is its Head: line, else the heads line's dotfiles commit exactly as the fleet reads it", () => {
  for (let seed = 1; seed <= 200; seed += 1) {
    const random = rng(seed)
    const dotfiles = shaOf(Math.floor(random() * 1e9))
    const fork = shaOf(Math.floor(random() * 1e9))
    const head = shaOf(Math.floor(random() * 1e9) + 1e9)
    // Each form the protocol allows (Head: alone, the heads line alone, both), and a heads line the fleet refuses.
    const good = `Heads: dotfiles=${dotfiles} fork=${fork}`
    const short = `Heads: dotfiles=${dotfiles.slice(0, 12)} fork=${fork}`
    const forms = [
      { form: "Head", lines: [`Head: ${head}`] },
      { form: "Heads", lines: [good] },
      { form: "both", lines: [`Head: ${head}`, good] },
      { form: "short Heads", lines: [short] },
    ]
    const { form, lines } = Option.getOrElse(Arr.get(forms, Math.floor(random() * forms.length)), () => forms[0] ?? { form: "Head", lines: [] })
    const breaks = Option.getOrElse(Arr.get(["\n", "\r\n"], Number(random() < 0.2)), () => "\n")
    const text = [...PROSE.filter(() => random() < 0.6), ...lines].toSorted(() => random() - 0.5).join(breaks)
    const fleet = Result.match(headsOf(text), { onSuccess: (commits) => Option.some(commits.dotfiles), onFailure: () => Option.none<string>() })
    // A Head: line wins; with none, the head is the dotfiles commit exactly when the fleet reads the heads line.
    const expected = Option.orElse(Option.liftPredicate(head, () => lines.includes(`Head: ${head}`)), () => fleet)
    expect({ seed, form, head: batchHeadOf(text) }).toEqual({ seed, form, head: expected })
  }
})
