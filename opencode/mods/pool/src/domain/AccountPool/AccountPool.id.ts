import { Schema } from "effect"

/** One pool: the integration whose logins it holds (`anthropic`). Several providers may share one. */
export const PoolId = Schema.String.pipe(Schema.brand("PoolId"))
export type PoolId = typeof PoolId.Type
