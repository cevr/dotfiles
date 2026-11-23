import * as BunRuntime from "@effect/platform-bun/BunRuntime"
import * as BunServices from "@effect/platform-bun/BunServices"
import { argv, Glob } from "bun"
import { Console, Data, Effect, FileSystem } from "effect"
import { ROOT, sourceText } from "./reach.ts"
import { checkReadInputs } from "./test-reads.ts"

const filesAt = (directory: string) =>
  [...new Glob("*.test.{ts,tsx}").scanSync({ cwd: `${ROOT}/${directory}` })].map((name) => `${directory}/${name}`)

const scripts = [...new Glob("scripts/**/*.test.{ts,tsx}").scanSync({ cwd: ROOT })].filter((file) => !file.includes("node_modules/"))
const files = [...scripts, ...filesAt("tests"), ...filesAt("../workbox/test")]
class UntrackedTestReads extends Data.TaggedError("UntrackedTestReads")<{ readonly message: string }> {}

BunRuntime.runMain(Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const problems = new Array<string>()
  for (const file of files) {
    const source = yield* fs.readFileString(`${ROOT}/${file}`)
    const { patterns, issues } = checkReadInputs(file, source, sourceText)
    if (argv.includes("--inventory")) yield* Console.log(`${file}\t${patterns.join(" ")}`)
    for (const { line, message } of issues) problems.push(`${file}:${line}: ${message}`)
  }
  if (problems.length > 0) {
    yield* Console.error(problems.join("\n"))
    return yield* new UntrackedTestReads({ message: "test read inputs are incomplete" })
  }
}).pipe(Effect.provide(BunServices.layer)), { disableErrorReporting: true })
