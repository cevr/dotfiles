// The Codex account's pace held in memory: a function answers for each model
// and role, as the admission script would.
import { Effect, Layer } from "effect"
import { Answered, FailedOpen, type Pace } from "../pace.ts"
import { CodexAdmission } from "../service.ts"

/** The script's answer for a model and role; none fails open, as the script with no admission line does. */
export const layer = (answer: (model: string, role: string) => Pace | undefined) =>
  Layer.succeed(CodexAdmission, {
    admit: (model: string, role: string) =>
      Effect.sync(() => {
        const pace = answer(model, role)
        return pace === undefined ? FailedOpen.make({ why: "no admission line (exit 2)" }) : Answered.make({ pace })
      }),
  })
