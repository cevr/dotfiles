// OS jobs held in memory: each title's job and schedule. `refusing` makes the
// scheduler refuse, as one that is not there. The model's tests, the plugin's
// seam test, and a server with its backstop off use it.
import { Effect, Layer } from "effect"
import { type Job, type Schedule, TITLE_PREFIX } from "../backstop.ts"
import { Backstop, BackstopRefused } from "../service.ts"

export interface MemoryJobs {
  readonly jobs: Map<string, { readonly job: Job; readonly schedule: Schedule }>
  refusing: string | undefined
}

export const empty = (): MemoryJobs => ({ jobs: new Map(), refusing: undefined })

const refusal = (memory: MemoryJobs) => (memory.refusing === undefined ? undefined : new BackstopRefused({ message: memory.refusing }))

export const layer = (memory: MemoryJobs) =>
  Layer.succeed(Backstop, {
    register: (job, schedule) =>
      Effect.suspend(() => {
        const refused = refusal(memory)
        if (refused !== undefined) return Effect.fail(refused)
        memory.jobs.set(job.title, { job, schedule })
        return Effect.void
      }),
    remove: (title) =>
      Effect.suspend(() => {
        const refused = refusal(memory)
        if (refused !== undefined) return Effect.fail(refused)
        memory.jobs.delete(title)
        return Effect.void
      }),
    titles: Effect.suspend(() => {
      const refused = refusal(memory)
      return refused === undefined ? Effect.succeed([...memory.jobs.keys()].filter((title) => title.startsWith(TITLE_PREFIX))) : Effect.fail(refused)
    }),
  })
