// The limit tally's store: each request's tokens in the plugin's storage, one
// key per assistant message (`limits/use/<messageID>`, so every plugin
// instance that saw the request writes the same key), held in memory too; and
// the tally's state with the tally itself in a JSON file, which the next
// process, the CLI view (opencode/scripts/pool-limits.ts) and the orchestrate
// skill's models.ts read. Instances on one host write the same file: each
// merges what the file holds before it writes (limits.ts `merge`).
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import * as TuiDirs from "@dotfiles/decider/tui-dirs"
import { dirname, join } from "node:path"
import { Clock, Effect, Layer, Ref } from "effect"
import type { PoolId } from "../account-pool.ts"
import {
  emptyState,
  limitsLine,
  merge,
  observe,
  recount,
  reportOf,
  takePeer,
  tally,
  USE_KEPT_MS,
  type LimitRow,
  type LimitsState,
  type Use,
} from "../limits.ts"
import type { QuotaReading } from "../quota.ts"
import { renameValue } from "../legacy-ids.ts"
import { Limits } from "../service.ts"
import type { Storage } from "./ledger.ts"
import { PAGE } from "./ledger.ts"

const PREFIX = "limits/use/"

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

/** The tally's store over the plugin's storage and the file at `path`. */
export const layer = (storage: Storage, path: string = defaultPath()) =>
  Layer.effect(
    Limits,
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis
      const uses = new Map<string, Use>()
      // The requests a previous process recorded; a storage that cannot be read starts empty.
      yield* Effect.gen(function* () {
        let after: string | undefined
        do {
          const page = yield* storage.scan({ prefix: PREFIX, ...(after === undefined ? {} : { after }), limit: PAGE })
          for (const entry of page.entries) {
            const use = asUse(entry.value)
            if (use !== undefined && now - use.at < USE_KEPT_MS) uses.set(entry.key.slice(PREFIX.length), use)
            else yield* storage.remove(entry.key).pipe(Effect.ignoreCause)
          }
          after = page.next
        } while (after !== undefined)
      }).pipe(Effect.ignoreCause)
      const state = yield* Ref.make(stateOf(readFile(path)) ?? emptyState(now))

      const write = (next: LimitsState, at: number) =>
        Effect.sync(() => {
          const kept = stateOf(readFile(path))
          const merged = kept === undefined ? next : merge(kept, next)
          const answer = tally(merged, at)
          mkdirSync(dirname(path), { recursive: true })
          const temporary = `${path}.${process.pid}.tmp`
          writeFileSync(temporary, JSON.stringify({ version: 1, line: limitsLine(answer) ?? null, tally: answer, state: merged }))
          renameSync(temporary, path)
          return merged
        }).pipe(
          Effect.flatMap((merged) => Ref.set(state, merged)),
          Effect.ignoreCause,
        )

      return {
        use: (messageID: string, use: Use) =>
          uses.has(messageID)
            ? Effect.void
            : Effect.sync(() => void uses.set(messageID, use)).pipe(
                Effect.andThen(storage.set(`${PREFIX}${messageID}`, { ...use, tokens: { ...use.tokens } })),
                Effect.ignoreCause,
              ),
        observe: (pool: PoolId, credentialID: string, reading: QuotaReading) =>
          Ref.update(state, (held) => observe(held, pool, credentialID, reading)),
        report: Effect.gen(function* () {
          const at = yield* Clock.currentTimeMillis
          return reportOf(recount(yield* Ref.get(state), [...uses.values()], at), at)
        }),
        takePeer: (peer, report) => Ref.update(state, (held) => takePeer(held, peer, report)),
        flush: Effect.gen(function* () {
          const at = yield* Clock.currentTimeMillis
          for (const [messageID, use] of uses)
            if (at - use.at >= USE_KEPT_MS) {
              uses.delete(messageID)
              yield* storage.remove(`${PREFIX}${messageID}`).pipe(Effect.ignoreCause)
            }
          yield* write(recount(yield* Ref.get(state), [...uses.values()], at), at)
        }),
        tally: Effect.gen(function* () {
          const at = yield* Clock.currentTimeMillis
          return tally(recount(yield* Ref.get(state), [...uses.values()], at), at)
        }),
      }
    }),
  )
