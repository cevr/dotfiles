// OpenCode's quota over a stand-in for the auth plugin's quota RPC that answers
// from the laws' world as untyped JSON: `{ reading }`, or `{ reading: null }`
// for a login it holds no reading of.
import { Effect, Stream } from "effect"
import { quotaLaws } from "../laws.ts"
import * as OpenCodeQuota from "./quota.ts"

quotaLaws("OpenCode's Quota", (world) =>
  OpenCodeQuota.layer((pool) => {
    const answer = ({ credentialID }: { readonly credentialID: string }) =>
      Effect.succeed({ reading: world.readings.get(pool)?.get(credentialID) ?? null })
    const queue = world.published.get(pool)
    return { reading: answer, usage: answer, published: queue === undefined ? Stream.empty : Stream.fromQueue(queue) }
  }),
)
