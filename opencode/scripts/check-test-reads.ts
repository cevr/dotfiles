import * as BunRuntime from "@effect/platform-bun/BunRuntime"
import * as BunServices from "@effect/platform-bun/BunServices"
import { argv } from "bun"
import { Console, Data, Effect } from "effect"
import { checkedTests, inspectReads, load, testReadInputs } from "./reach.ts"

class UntrackedTestReads extends Data.TaggedError("UntrackedTestReads")<{ readonly message: string }> {}

BunRuntime.runMain(Effect.gen(function* () {
  const workspace = yield* Effect.promise(load)
  const files = checkedTests(workspace)
  if (argv.includes("--files")) return yield* Console.log(files.join("\n"))
  const problems = new Array<string>()
  for (const file of files) {
    const { patterns, issues, classification, indirect, bounded } = inspectReads(workspace, file)
    const { subprocessReason, spellingIssues } = testReadInputs(workspace, file)
    if (argv.includes("--inventory")) {
      yield* Console.log(`${file}\t${patterns.join(" ")}\t${classification}\t${indirect.map(({ line, reason }) => `${line}: ${reason}`).join("; ")}\t${bounded.join(" ")}\t${subprocessReason ?? ""}`)
    }
    for (const { line, message } of issues) problems.push(`${file}:${line}: ${message}`)
    for (const issue of spellingIssues) problems.push(`${file}: ${issue}`)
  }
  if (problems.length > 0) {
    yield* Console.error(problems.join("\n"))
    return yield* new UntrackedTestReads({ message: "test read inputs are incomplete" })
  }
}).pipe(Effect.provide(BunServices.layer)), { disableErrorReporting: true })
