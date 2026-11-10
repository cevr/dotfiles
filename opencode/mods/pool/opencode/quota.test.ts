// OpenCode's quota over a stand-in for the auth plugin's quota RPC that answers
// from the laws' world as untyped JSON: `{ reading }`, or `{ reading: null }`
// for a login it holds no reading of. A claim's answer is checked as a
// reading is: what does not read, or a failed call, is `failed`.
import { expect, test } from "bun:test"
import { Effect, Stream } from "effect"
import { PoolId } from "../account-pool.ts"
import { quotaLaws } from "../laws.ts"
import { Quota } from "../service.ts"
import * as OpenCodeQuota from "./quota.ts"

quotaLaws("OpenCode's Quota", (world) =>
  OpenCodeQuota.layer((pool) => {
    const answer = ({ credentialID }: { readonly credentialID: string }) =>
      Effect.succeed({ reading: world.readings.get(pool)?.get(credentialID) ?? null })
    const queue = world.published.get(pool)
    return {
      reading: answer,
      usage: answer,
      claim: () => Effect.succeed({ outcome: "failed" }),
      published: queue === undefined ? Stream.empty : Stream.fromQueue(queue),
    }
  }),
)

const claimed = (claim: OpenCodeQuota.QuotaRpc["claim"]) =>
  Effect.runPromise(
    Quota.use((quota) => quota.claim(PoolId.make("anthropic"), { credentialID: "cred-4", creditID: "grant_4", requestID: "pool-1" })).pipe(
      Effect.provide(OpenCodeQuota.layer(() => ({ reading: () => Effect.succeed({}), usage: () => Effect.succeed({}), claim, published: Stream.empty }))),
    ),
  )

test("a claim's answer is passed on as read; one that does not read, or a failed call, is failed", async () => {
  const asked: Array<unknown> = []
  expect(
    await claimed((input) => {
      asked.push(input)
      return Effect.succeed({ outcome: "reset" })
    }),
  ).toEqual({ outcome: "reset" })
  expect(asked).toEqual([{ credentialID: "cred-4", creditID: "grant_4", requestID: "pool-1" }])
  expect(await claimed(() => Effect.succeed({ outcome: "maybe" }))).toEqual({ outcome: "failed", message: "the claim's answer does not read" })
  expect(await claimed(() => Effect.fail(new Error("rpc.unavailable")))).toEqual({ outcome: "failed", message: "rpc.unavailable" })
})
