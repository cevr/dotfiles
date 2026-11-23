// @reads all
// @reads-reason computed read at mods/orchestrate/git/fleet.ts: const text = yield* Effect.tryPromise(() => file(path).text()).pipe(Effect.map(Option.some), Ef
// A verify of main publishes the fleet target like any batch: the batch file it writes is the one git/fleet.ts reads
// beside its verifier's findings when the verdict is accepted, and that file's heads line is the one fleet reads. A batch
// file names its head as the fleet reads it (one reader, fleet.ts `headsOf`), so the verify-due count starts where the
// fleet's target is.
import { expect, test } from "bun:test"
import { Option, Result } from "effect"
import { headsOf } from "../fleet.ts"
import { batchHeadOf, mainBatchPathOf, mainBatchText, mainFindingsPathOf, mainVerifyName, UNIT_NAME } from "../tools.ts"
import { batchFileOf } from "./fleet.ts"

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

test("a batch file's head is its Head: line, else the dotfiles commit of a heads line the fleet would publish; a heads line it refuses names none", () => {
  const [head, dotfiles, fork] = [shaOf(1), shaOf(2), shaOf(3)]
  const heads = `Heads: dotfiles=${dotfiles} fork=${fork}`
  const prose = "# batch-2026-11-15cd\nBase: 2541c442fd9644ce479324225493121a7acaf8b4 (batch cc's head)."
  expect(batchHeadOf(`${prose}\nHead: ${head}`)).toEqual(Option.some(head))
  expect(batchHeadOf(`${prose}\r\n${heads}\r\n`)).toEqual(Option.some(dotfiles))
  expect(batchHeadOf(`${heads}\n${prose}\nHead: ${head}`)).toEqual(Option.some(head))
  expect(batchHeadOf(`${prose}\nHeads: dotfiles=${dotfiles.slice(0, 12)} fork=${fork}`)).toEqual(Option.none())
  expect(batchHeadOf(`${prose}\n${heads}\n${heads}`)).toEqual(Option.none())
})
