// Checks answered from a script: each command's results in turn (the last
// repeats), and every run recorded. The model's tests use it.
import { Effect, Layer } from "effect"
import { Checks } from "../service.ts"
import type { Check } from "../wake.ts"

export interface MemoryChecks {
  readonly answers: Map<string, Array<Check>>
  readonly runs: Array<{ readonly command: string; readonly cwd: string }>
}

export const empty = (): MemoryChecks => ({ answers: new Map(), runs: [] })

export const check = (exitCode: number, stdout = "", stderr = ""): Check => ({ exitCode, stdout, stderr, timedOut: false })

export const layer = (memory: MemoryChecks) =>
  Layer.succeed(Checks, {
    run: (command, cwd) =>
      Effect.sync(() => {
        memory.runs.push({ command, cwd })
        const answers = memory.answers.get(command) ?? []
        const answer = answers.length > 1 ? answers.shift() : answers[0]
        return answer ?? check(127, "", `no answer scripted for ${command}`)
      }),
  })
