// The limit tally's store: each request's tokens in the plugin's storage, in
// chunks (`chunk/use/…`, chunks.ts) keyed by assistant message, so a request
// every plugin instance saw counts once, held in memory too (an older pool kept
// one key per message, `limits/use/<messageID>`: read too, and folded); and
// the tally's state with the tally itself in a JSON file, which the next
// process, the CLI view (opencode/scripts/pool-limits.ts) and the orchestrate
// skill's models.ts read. Instances on one host write the same file: each
// merges what the file holds before it writes (limits.ts `merge`).
import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs"
import * as TuiDirs from "@dotfiles/decider/tui-dirs"
import { dirname, join } from "node:path"
import { Clock, Effect, Layer, Option, Ref, Schema } from "effect"
import type { PoolId } from "../account-pool.ts"
import {
  counter,
  emptyState,
  limitsLine,
  merge,
  observe,
  reportOf,
  takePeer,
  tally,
  USE_KEPT_MS,
  workCosts,
  type WorkGroup,
  type LimitRow,
  type LimitsState,
  type Use,
} from "../limits.ts"
import type { QuotaReading } from "../quota.ts"
import { renameValue } from "../legacy-ids.ts"
import { Limits } from "../service.ts"
import * as Chunks from "./chunks.ts"
import type { Storage } from "./ledger.ts"

/** Where an older pool kept the requests, one key per assistant message under it. */
export const PREFIX = "limits/use/"

/** Where the tally is kept unless the options say otherwise: `$XDG_STATE_HOME/opencode-pool/limits.json`. */
export const defaultPath = () => join(TuiDirs.dirs().state, "opencode-pool", "limits.json")

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value)

/** A stored use, checked field by field; none when it does not read. */
export const asUse = (value: unknown): Use | undefined => {
  if (!isRecord(value) || !isRecord(value.tokens)) return undefined
  const { at, pool, credentialID, model, tokens } = value
  if (!finite(at) || typeof pool !== "string" || typeof credentialID !== "string" || typeof model !== "string") return undefined
  if (!finite(tokens.input) || !finite(tokens.output) || !finite(tokens.cacheRead) || !finite(tokens.cacheWrite)) return undefined
  return { at, pool, credentialID, model, tokens: { input: tokens.input, output: tokens.output, cacheRead: tokens.cacheRead, cacheWrite: tokens.cacheWrite } }
}

/** A request as the store keeps it: its assistant message, and its use. */
export interface Recorded {
  readonly messageID: string
  readonly use: Use
}

/** A request in a chunk: message, time, pool, login, model, then input, output, cache read and cache write tokens. */
const UseRow = Schema.Tuple([
  Schema.String,
  Schema.Number,
  Schema.String,
  Schema.String,
  Schema.String,
  Schema.Number,
  Schema.Number,
  Schema.Number,
  Schema.Number,
])

/** A request as an older pool kept it under its message's key. */
const OldUse = Schema.Struct({
  at: Schema.Finite,
  pool: Schema.String,
  credentialID: Schema.String,
  model: Schema.String,
  tokens: Schema.Struct({ input: Schema.Finite, output: Schema.Finite, cacheRead: Schema.Finite, cacheWrite: Schema.Finite }),
})

/** The requests as chunks keep them; a request's identity is its message, as its old key's was. */
export const useKind: Chunks.Kind<Recorded, typeof UseRow.Type, typeof OldUse.Type> = {
  prefix: "chunk/use/",
  legacy: PREFIX,
  keepMs: USE_KEPT_MS,
  identity: (recorded) => recorded.messageID,
  at: (recorded) => recorded.use.at,
  row: UseRow,
  toRow: ({ messageID, use }) => [
    messageID,
    use.at,
    use.pool,
    use.credentialID,
    use.model,
    use.tokens.input,
    use.tokens.output,
    use.tokens.cacheRead,
    use.tokens.cacheWrite,
  ],
  fromRow: ([messageID, at, pool, credentialID, model, input, output, cacheRead, cacheWrite]) => ({
    messageID,
    use: { at, pool, credentialID, model, tokens: { input, output, cacheRead, cacheWrite } },
  }),
  old: OldUse,
  // Only the fields a use has: an old value's others are left behind.
  fromOld: (messageID, { at, pool, credentialID, model, tokens }) => ({
    messageID,
    use: { at, pool, credentialID, model, tokens: { input: tokens.input, output: tokens.output, cacheRead: tokens.cacheRead, cacheWrite: tokens.cacheWrite } },
  }),
}

/** The state a tally file holds; none when it holds none that reads. Rows are taken as written: only this store writes them. */
export const stateOf = (file: unknown): LimitsState | undefined => {
  const state = isRecord(file) ? file.state : undefined
  if (!isRecord(state) || !finite(state.since) || !isRecord(state.rows)) return undefined
  const peerSince = isRecord(state.peerSince)
    ? Object.fromEntries(Object.entries(state.peerSince).filter((entry): entry is [string, number] => finite(entry[1])))
    : {}
  const rows = Object.fromEntries(
    Object.entries(state.rows).filter(
      (entry): entry is [string, LimitRow] =>
        isRecord(entry[1]) && finite(entry[1].start) && finite(entry[1].at) && finite(entry[1].rise) && isRecord(entry[1].own),
    ),
  )
  return { since: state.since, peerSince, rows }
}

const readFile = (path: string): unknown => {
  try {
    // A file an older pool wrote names store logins by their legacy id; the next write renames it.
    return renameValue(JSON.parse(readFileSync(path, "utf8")))
  } catch {
    return undefined
  }
}

/** The file's state as `readFile` and `stateOf` read it, read again only when the file is another (each write renames a new one in). */
const fileReader = (path: string) => {
  let held = Option.none<{ readonly stamp: string; readonly state: Option.Option<LimitsState> }>()
  return Effect.gen(function* () {
    const stamp = yield* Effect.option(
      Effect.try({ try: () => statSync(path, { bigint: true }), catch: (cause) => cause }).pipe(
        Effect.map((stat) => `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}`),
      ),
    )
    const same = Option.filter(held, (kept) => Option.contains(stamp, kept.stamp))
    if (Option.isSome(same)) return same.value.state
    const state = Option.fromUndefinedOr(stateOf(readFile(path)))
    held = Option.map(stamp, (read) => ({ stamp: read, state }))
    return state
  })
}

/**
 * The tally's store over the plugin's storage and the file at `path`; the requests in `recorded`, the one store
 * every copy of the plugin in a process shares (records.ts), else its own.
 */
export const layer = (storage: Storage, path: string = defaultPath(), recorded: Chunks.Store<Recorded> = Chunks.open(storage, useKind)) =>
  Layer.effect(
    Limits,
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis
      // The requests kept, each counted on its rows once, as it comes (limits.ts `counter`).
      const uses = counter()
      // The requests a previous process recorded; a storage that cannot be read starts empty.
      for (const { messageID, use } of yield* recorded.entries) if (now - use.at < USE_KEPT_MS) uses.add(messageID, use)
      yield* recorded.expire(now - USE_KEPT_MS)
      // The shared store's revision this one has read every request of.
      let seen = yield* recorded.revision
      const stored = fileReader(path)
      const state = yield* Ref.make(Option.getOrElse(yield* stored, () => emptyState(now)))

      const write = (next: LimitsState, at: number) =>
        Effect.flatMap(stored, (kept) => Effect.sync(() => {
          const merged = Option.match(kept, { onNone: () => next, onSome: (file) => merge(file, next) })
          const answer = tally(merged, at)
          mkdirSync(dirname(path), { recursive: true })
          const temporary = `${path}.${process.pid}.tmp`
          writeFileSync(temporary, JSON.stringify({ version: 1, line: limitsLine(answer) ?? null, tally: answer, state: merged }))
          renameSync(temporary, path)
          return merged
        })).pipe(
          Effect.flatMap((merged) => Ref.set(state, merged)),
          Effect.ignoreCause,
        )

      return {
        workCosts: (pool: PoolId, groups: ReadonlyArray<WorkGroup>) => Effect.gen(function* () {
          const at = yield* Clock.currentTimeMillis
          // Another copy of the plugin in this process may have recorded requests since.
          const revision = yield* recorded.revision
          if (revision !== seen) {
            for (const { messageID, use } of yield* recorded.entries) if (at - use.at < USE_KEPT_MS) uses.add(messageID, use)
            seen = revision
          }
          const file = yield* stored
          const current = yield* Ref.get(state)
          const shared = Option.match(file, { onNone: () => current, onSome: (kept) => merge(kept, current) })
          return workCosts(tally(uses.recount(shared, at), at), uses.uses, pool, groups)
        }),
        use: (messageID: string, use: Use) =>
          Effect.suspend(() => {
            if (!uses.add(messageID, use)) return Effect.void
            return Effect.gen(function* () {
              const before = yield* recorded.revision
              yield* recorded.append({ messageID, use })
              const after = yield* recorded.revision
              // Its own request moved the revision only: nothing else is new to read.
              if (before === seen && after === before + 1) seen = after
            })
          }),
        observe: (pool: PoolId, credentialID: string, reading: QuotaReading) =>
          Ref.update(state, (held) => observe(held, pool, credentialID, reading)),
        report: Effect.gen(function* () {
          const at = yield* Clock.currentTimeMillis
          return reportOf(uses.recount(yield* Ref.get(state), at), at)
        }),
        takePeer: (peer, report) => Ref.update(state, (held) => takePeer(held, peer, report)),
        flush: Effect.gen(function* () {
          const at = yield* Clock.currentTimeMillis
          uses.expire(at - USE_KEPT_MS)
          yield* recorded.expire(at - USE_KEPT_MS)
          yield* write(uses.recount(yield* Ref.get(state), at), at)
        }),
        tally: Effect.gen(function* () {
          const at = yield* Clock.currentTimeMillis
          return tally(uses.recount(yield* Ref.get(state), at), at)
        }),
      }
    }),
  )
