// The provider's logins were read: they are the pool's accounts, in order.
import { Effect, Schema } from "effect"
import type { AccountPoolState } from "./AccountPool.aggregate.ts"

export const ListLogins = Schema.TaggedStruct("ListLogins", {
  /** The integration's subscription logins in its order, then each outside store's. */
  credentials: Schema.Array(Schema.String),
})
export interface ListLogins extends Schema.Schema.Type<typeof ListLogins> {}

export const LoginsListed = Schema.TaggedStruct("LoginsListed", {
  credentials: Schema.Array(Schema.String),
})
export interface LoginsListed extends Schema.Schema.Type<typeof LoginsListed> {}

export declare namespace ListLogins {
  export type Rejections = never
}

const same = (left: ReadonlyArray<string>, right: ReadonlyArray<string>) =>
  left.length === right.length && left.every((credentialID, index) => credentialID === right[index])

/** The list as read; nothing when the pool already holds exactly these accounts. */
export const decide = (state: AccountPoolState, command: ListLogins): Effect.Effect<ReadonlyArray<LoginsListed>> =>
  Effect.succeed(same(state.credentials, command.credentials) ? [] : [LoginsListed.make({ credentials: command.credentials })])
