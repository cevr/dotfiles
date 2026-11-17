// Stand-ins for the call's side: a catalog that lists what the case gives, and
// jobs that record each start and answer what the case scripted.
import { Effect, Layer, Ref } from "effect"
import type { Listed } from "../models.ts"
import { Catalog, type JobRefused, Jobs, type JobStart } from "../service.ts"

export const catalog = (models: ReadonlyArray<Listed>) => Layer.succeed(Catalog, Catalog.of({ models: () => Effect.succeed(models) }))

/** Every start the jobs took, with its session. */
export type Started = Ref.Ref<ReadonlyArray<JobStart & { readonly sessionID: string }>>

export const started = Ref.make<ReadonlyArray<JobStart & { readonly sessionID: string }>>([])

export const jobs = (log: Started, answer: (job: JobStart) => Effect.Effect<string, JobRefused>) =>
  Layer.succeed(
    Jobs,
    Jobs.of({ start: (sessionID, job) => Ref.update(log, (all) => [...all, { ...job, sessionID }]).pipe(Effect.andThen(answer(job))) }),
  )
