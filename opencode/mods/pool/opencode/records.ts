// One process's chunk stores (chunks.ts): each pool's priced steps and the limit tally's requests. OpenCode runs a
// copy of the plugin per location in one process, on one storage: every copy gets the same store of each kind, so
// the records are read and decoded once for all of them, and their appends take turns under one writer.
import { Effect, Option } from "effect"
import type { PoolId } from "../account-pool.ts"
import type { Step } from "../accounts.ts"
import * as Chunks from "./chunks.ts"
import { type Steps, stepKind, type Storage } from "./ledger.ts"
import { type Recorded, useKind } from "./limits.ts"

/** A process's stores, made by their first use through the first copy's storage (every copy's is the same). */
export const make = () => {
  const steps = new Map<PoolId, Chunks.Store<Step>>()
  let uses = Option.none<Chunks.Store<Recorded>>()
  return (storage: Storage) => {
    const stepsOf: Steps = (pool) =>
      Option.getOrElse(Option.fromNullishOr(steps.get(pool)), () => {
        const made = Chunks.open(storage, stepKind(pool))
        steps.set(pool, made)
        return made
      })
    const usesOf = () =>
      Option.getOrElse(uses, () => {
        const made = Chunks.open(storage, useKind)
        uses = Option.some(made)
        return made
      })
    return {
      steps: stepsOf,
      uses: usesOf(),
      /** Folds the old one-key-per-entry shape of `pools`' steps and of the requests into chunks; once per process. */
      fold: (pools: ReadonlyArray<PoolId>) => Effect.forEach([...pools.map(stepsOf), usesOf()], (store) => store.fold, { discard: true }),
    }
  }
}
