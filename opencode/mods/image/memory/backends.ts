// Recording stand-ins for the backends and the key: each call is appended to
// one log (`subscription <model>`, `paid <model>`, `key`) before it answers
// what the case scripted, so a test can hold which of them a request reached.
import { Effect, Layer, Option, Redacted, Ref } from "effect"
import { fail, type ImageFailed } from "../outcome.ts"
import { OpenAiKey, type PaidAsk, PaidImages, Subscription, type SubscriptionAsk } from "../service.ts"

/** Every call the stand-ins took, in order. */
export type Log = Ref.Ref<ReadonlyArray<string>>

export const log = Ref.make<ReadonlyArray<string>>([])

const record = (calls: Log, line: string) => Ref.update(calls, (lines) => [...lines, line])

export const subscription = (calls: Log, answer: (ask: SubscriptionAsk) => Effect.Effect<Uint8Array, ImageFailed>) =>
  Layer.succeed(
    Subscription,
    Subscription.of({ generate: (ask) => record(calls, `subscription ${ask.model}`).pipe(Effect.andThen(answer(ask))) }),
  )

export const paid = (calls: Log, answer: (ask: PaidAsk) => Effect.Effect<ReadonlyArray<Uint8Array>, ImageFailed>) =>
  Layer.succeed(PaidImages, PaidImages.of({ generate: (ask) => record(calls, `paid ${ask.model}`).pipe(Effect.andThen(answer(ask))) }))

/** A key that records each read; none answers AUTH_MISSING. */
export const key = (calls: Log, value: Option.Option<string>) =>
  Layer.succeed(
    OpenAiKey,
    OpenAiKey.of({
      read: record(calls, "key").pipe(
        Effect.andThen(Effect.fromOption(Option.map(value, Redacted.make), () => fail("AUTH_MISSING", "No OpenAI API key."))),
      ),
    }),
  )
