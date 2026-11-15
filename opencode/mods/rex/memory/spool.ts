// The spool in memory, for the model's tests: each session's spool in a map,
// and a kept file's copy named after it.
import { Effect, Layer, Option, Ref } from "effect"
import { Spool } from "../service.ts"
import { empty, type Spooled } from "../spool.ts"

/** The spool over `state`, by session. */
export const layer = (state: Ref.Ref<ReadonlyMap<string, Spooled>>) =>
  Layer.succeed(
    Spool,
    Spool.of({
      read: (session) => Ref.get(state).pipe(Effect.map((spools) => Option.getOrElse(Option.fromUndefinedOr(spools.get(session)), () => empty))),
      write: (session, spooled) => Ref.update(state, (spools) => new Map([...spools, [session, spooled]])),
      keep: (session, file) => Effect.succeed(`kept/${session}/${file}`),
    }),
  )
