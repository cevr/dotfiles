import { Context, type Effect, Schema } from "effect"
import type { PoolId } from "./AccountPool.id.ts"
import type { SourceStatus } from "../PoolStatus.ts"

/** The provider's logins could not be read: its integration (with no outside store beside it), or an outside store. */
export class LoginsUnavailable extends Schema.TaggedError<LoginsUnavailable>()("LoginsUnavailable", {
  pool: Schema.String,
  message: Schema.String,
}) {}

/**
 * The provider's subscription logins: its integration's OAuth logins in
 * order, then each outside store's (gent's). The list is read again at most
 * every so often unless `force` asks for it now.
 */
export class Logins extends Context.Service<
  Logins,
  {
    readonly list: (pool: PoolId, force: boolean) => Effect.Effect<ReadonlyArray<string>, LoginsUnavailable>
    /**
     * Mark a login of the integration as needing a sign-in (`needed`), or
     * clear the mark. Only a change reaches the host, and only for a login
     * the integration lists.
     */
    readonly markSignIn: (pool: PoolId, credentialID: string, needed: boolean) => Effect.Effect<void>
    /** The outside stores whose logins join the pool, as they list them now. */
    readonly sources: (pool: PoolId) => Effect.Effect<ReadonlyArray<SourceStatus>, LoginsUnavailable>
  }
>()("dotfiles-opencode/pool/Logins") {}
