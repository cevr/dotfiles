// A verify of main publishes the fleet target like any batch: the batch file it writes is the one git/fleet.ts reads
// beside its verifier's findings when the verdict is accepted, and that file's heads line is the one fleet reads.
import { expect, test } from "bun:test"
import { Option, Result } from "effect"
import { mainBatchPathOf, mainBatchText, mainFindingsPathOf, mainVerifyName, UNIT_NAME } from "../tools.ts"
import { batchFileOf, headsOf } from "./fleet.ts"

const shaOf = (n: number) => n.toString(16).padStart(40, "0")

test("a verify of main's batch file is the one the fleet reads when its verifier's findings are accepted", () => {
  const name = mainVerifyName(shaOf(1000))
  const file = mainBatchPathOf("/run", name)
  // The verifier is `verifier <name> r1`; its findings sit beside the batch file, and batchFileOf reads `<dir>/<batch>.md`.
  expect(batchFileOf(mainFindingsPathOf(file), name)).toBe(file)
  expect(UNIT_NAME.test(name)).toBe(true)
  const text = mainBatchText({ name, base: shaOf(7), head: shaOf(1000), last: Option.none(), merges: [], units: [], heads: Option.some({ dotfiles: shaOf(1000), fork: shaOf(77) }) })
  expect(headsOf(text)).toEqual(Result.succeed({ dotfiles: shaOf(1000), fork: shaOf(77) }))
})
