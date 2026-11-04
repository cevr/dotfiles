// The Codex account's pace held in memory: a function answers for each model
// and role, as the admission script would.
import { Effect, Layer } from "effect"
import type { Pace } from "../pace.ts"
import { CodexAdmission } from "../service.ts"

/** The script's answer for a model and role; none fails open. */
export const layer = (answer: (model: string, role: string) => Pace | undefined) =>
  Layer.succeed(CodexAdmission, { admit: (model: string, role: string) => Effect.sync(() => answer(model, role)) })
