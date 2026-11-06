// The Codex admission over a stand-in for the orchestrate skill's budget
// script, written to a scratch directory: it answers the laws' table as the
// real script answers (`admit: …` with exit 0, `hold: …[; opens about
// <date> <hh:mm>Z]` with 1), and exits 2 for anything else. A script that is
// not there fails open.
import { expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Layer } from "effect"
import { codexAdmissionLaws, type CodexWorld } from "../laws.ts"
import { CodexAdmission } from "../service.ts"
import * as CodexScript from "./admission.ts"

const scratch = Effect.acquireRelease(
  Effect.sync(() => mkdtempSync(join(tmpdir(), "orchestrate-codex-"))),
  (dir) => Effect.sync(() => rmSync(dir, { recursive: true, force: true })),
)

/** The script's last line for one answer, as budget.ts writes it. */
const lineOf = (answer: NonNullable<CodexWorld[number]["answer"]>) => {
  if (answer.ok) return `admit: ${answer.reason}`
  if (answer.retryAt === undefined) return `hold: ${answer.reason}`
  const iso = new Date(answer.retryAt).toISOString()
  return `hold: ${answer.reason}; opens about ${iso.slice(0, 10)} ${iso.slice(11, 16)}Z`
}

/** A script answering `world`: it checks its flags, then prints a line and exits with the answer's code. */
const script = (world: CodexWorld) => {
  const table = world.flatMap(({ model, role, answer }) =>
    answer === undefined ? [] : [{ model, role, line: lineOf(answer), code: answer.ok ? 0 : 1 }],
  )
  return [
    `const table = ${JSON.stringify(table)}`,
    `const args = process.argv.slice(2)`,
    `const flag = (name) => args[args.indexOf(name) + 1]`,
    `const hit = table.find((entry) => entry.model === flag("--model") && entry.role === flag("--role"))`,
    `if (!args.includes("--codex") || !args.includes("--admit") || hit === undefined) process.exit(2)`,
    `console.log("checking")`,
    `console.log(hit.line)`,
    `process.exit(hit.code)`,
    "",
  ].join("\n")
}

codexAdmissionLaws("the budget script's CodexAdmission", (world) =>
  Layer.unwrap(
    Effect.map(scratch, (dir) => {
      const file = join(dir, "budget.ts")
      writeFileSync(file, script(world))
      return CodexScript.layer(file)
    }),
  ),
)

const admit = CodexAdmission.use((codex) => codex.admit("gpt-5", "planner"))

test("no script fails open, saying the exit code", () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        expect(yield* admit.pipe(Effect.provide(CodexScript.layer(join(yield* scratch, "missing.ts"))))).toEqual({
          _tag: "FailedOpen",
          why: "no admission line (exit 1)",
        })
      }),
    ),
  ))

test("a script stopped by a signal, as its timeout stops it, fails open saying so", () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const file = join(yield* scratch, "budget.ts")
        writeFileSync(file, `console.log("checking")\nprocess.kill(process.pid, "SIGTERM")\nawait new Promise(() => {})\n`)
        expect(yield* admit.pipe(Effect.provide(CodexScript.layer(file)))).toEqual({
          _tag: "FailedOpen",
          why: "the script was stopped by SIGTERM (it has 20 s)",
        })
      }),
    ),
  ))
