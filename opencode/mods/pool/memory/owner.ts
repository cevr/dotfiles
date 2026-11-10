// The owner held in memory: the questions the pool asked, by key, and the
// answer the test gives each, as the questions plugin keeps them. The model's
// tests answer through `answer` and beat `changes` as the plugin's `changed`
// event would.
import { Effect, Layer, Queue, Stream } from "effect"
import { Owner, type OwnerQuestion } from "../service.ts"

export interface MemoryOwner {
  /** The questions asked and not withdrawn, by key, with the answer once given. */
  readonly questions: Map<string, { readonly question: OwnerQuestion; answer?: string }>
  /** Every question ever asked, in order, and every key withdrawn. */
  readonly asked: Array<OwnerQuestion>
  readonly withdrawn: Array<string>
  /** Whether asking fails, as an absent questions plugin would. */
  refusing: boolean
  readonly beats: Queue.Queue<void>
}

export const empty = (): MemoryOwner => ({
  questions: new Map(),
  asked: [],
  withdrawn: [],
  refusing: false,
  beats: Effect.runSync(Queue.unbounded<void>()),
})

/** The owner answers the question under `key`, and the questions change. */
export const answer = (owner: MemoryOwner, key: string, text: string | undefined) =>
  Effect.gen(function* () {
    const held = owner.questions.get(key)
    if (held !== undefined) {
      if (text === undefined) owner.questions.delete(key)
      else held.answer = text
    }
    yield* Queue.offer(owner.beats, undefined)
  })

export const layer = (owner: MemoryOwner) =>
  Layer.succeed(Owner, {
    ask: (question) =>
      Effect.sync(() => {
        if (owner.refusing) return false
        if (!owner.questions.has(question.key)) {
          owner.questions.set(question.key, { question })
          owner.asked.push(question)
        }
        return true
      }),
    answers: Effect.sync(() =>
      [...owner.questions].map(([key, held]) => ({ key, ...(held.answer === undefined ? {} : { answer: held.answer }) })),
    ),
    withdraw: (key) =>
      Effect.sync(() => {
        owner.questions.delete(key)
        owner.withdrawn.push(key)
      }),
    changes: Stream.fromQueue(owner.beats),
  })
