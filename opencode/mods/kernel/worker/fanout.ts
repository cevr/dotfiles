/**
 * How a cell runs calls at once, beside the worker loop (program.ts):
 *
 * - `all(calls)` and `map(items, fn, { concurrency? })` are `tools.all` and
 *   `tools.map`: each call settled as `{ ok, value | error }`, never a throw
 *   for one failure.
 * - `lastValue(result)` is a cell's last value as the call shows it: its
 *   promise awaited, and the promises one level inside an array or a plain
 *   object awaited into a copy, a failure as its error's text.
 *
 * A cell is untyped JavaScript, so each helper reads its arguments' shape at
 * run time; a wrong one is a TypeError the cell's `await` throws.
 *
 * @module
 */
import { Effect, Option, Predicate, Schema } from "effect"
import { MAX_PENDING_CALLS } from "../limits.ts"

/** A call as a helper takes it: a promise, a function that starts one, or a plain value. */
export type Call<A> = PromiseLike<A> | (() => PromiseLike<A> | A) | A

/** What `tools.all` takes: an array or a record of calls. */
export type Calls<A> = ReadonlyArray<Call<A>> | Readonly<Record<string, Call<A>>>

/** How one call ended: its value, or its error as text. */
export type Settled<A> = { readonly ok: true; readonly value: A } | { readonly ok: false; readonly error: string }

/** A thrown value as text (program.ts `errorText`). */
export type Describe = <E>(cause: E) => string

/** `tools.map`'s options. */
export interface MapOptions {
  readonly concurrency?: number
}

const Options = Schema.Struct({ concurrency: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))) })

const refused = (message: string) => Effect.die(new TypeError(message))

/** A function is called; anything else is the call itself. */
const started = <A>(call: Call<A>): PromiseLike<A> | A => {
  if (Predicate.isFunction(call)) return call()
  return call
}

/** A promise awaited, a failure as its text; any other value as it is. */
const outcome = <A>(value: PromiseLike<A> | A, describe: Describe): Effect.Effect<A, string> => {
  if (Predicate.isPromiseLike(value)) return Effect.tryPromise({ try: () => value, catch: describe })
  return Effect.succeed(value)
}

const settled = <A>(effect: Effect.Effect<A, string>): Effect.Effect<Settled<A>> =>
  Effect.match(effect, {
    onFailure: (error): Settled<A> => ({ ok: false, error }),
    onSuccess: (value): Settled<A> => ({ ok: true, value }),
  })

/** One call, settled: a function that throws at once settles as a failure too. */
const settle = <A>(call: Call<A>, describe: Describe): Effect.Effect<Settled<A>> =>
  settled(Effect.try({ try: () => started(call), catch: describe }).pipe(Effect.flatMap((value) => outcome(value, describe))))

/** Whether `value` is an object literal's kind: its prototype `Object.prototype`, or none. */
const isPlain = <A extends object>(value: A): boolean => {
  const prototype = Object.getPrototypeOf(value)
  return !prototype || prototype === Object.prototype
}

const allOf = <A>(calls: Calls<A>, describe: Describe) => {
  if (Array.isArray(calls)) return Effect.forEach(calls, (call: Call<A>) => settle(call, describe), { concurrency: Math.max(1, calls.length) })
  if (!Predicate.isObject(calls) || !isPlain(calls)) return refused("tools.all takes an array or a record of calls")
  const entries = Object.entries(calls)
  return Effect.forEach(entries, ([key, call]) => Effect.map(settle(call, describe), (one) => [key, one] as const), { concurrency: Math.max(1, entries.length) }).pipe(
    Effect.map(Object.fromEntries),
  )
}

/** `tools.all(calls)`: every call started at once; the same shape back with each settled. */
export const all = <A>(calls: Calls<A>, describe: Describe) =>
  Effect.runPromise(allOf(calls, describe))

const mapOf = <T, A>(items: Iterable<T>, fn: (item: T, index: number) => PromiseLike<A> | A, options: MapOptions, describe: Describe) =>
  Effect.gen(function* () {
    if (!Predicate.isIterable(items) || !Predicate.isFunction(fn)) return yield* refused("tools.map takes a list of items, then a function of one")
    const read = yield* Schema.decodeUnknownEffect(Options)(options).pipe(
      Effect.catch(() => refused("tools.map's concurrency is a whole number of 1 or more")),
    )
    return yield* Effect.forEach(Array.from(items), (item, index) => settle(() => fn(item, index), describe), {
      concurrency: Option.getOrElse(Option.fromUndefinedOr(read.concurrency), () => MAX_PENDING_CALLS),
    })
  })

/** `tools.map(items, fn, { concurrency? })`: `fn(item, index)` for each item, at most `concurrency` at once, settled in the items' order. */
export const map = <T, A>(items: Iterable<T>, fn: (item: T, index: number) => PromiseLike<A> | A, options: MapOptions, describe: Describe) =>
  Effect.runPromise(mapOf(items, fn, options, describe))

/** One member of a shown value: a promise awaited, a failure as its error's text. */
const member = <A>(value: A, describe: Describe) => {
  if (Predicate.isPromise(value)) return Effect.tryPromise({ try: () => value, catch: describe }).pipe(Effect.catch(Effect.succeed))
  return Effect.succeed(value)
}

/** An array or a plain object holding promises, as a copy with each awaited; any other value as it is. */
const shown = <A>(value: A, describe: Describe) => {
  if (Array.isArray(value) && value.some(Predicate.isPromise))
    return Effect.forEach(value, (item) => member(item, describe), { concurrency: Math.max(1, value.length) })
  if (!Predicate.isObject(value) || Array.isArray(value) || !isPlain(value)) return Effect.succeed(value)
  const entries = Object.entries(value)
  if (!entries.some(([, item]) => Predicate.isPromise(item))) return Effect.succeed(value)
  return Effect.forEach(entries, ([key, item]) => Effect.map(member(item, describe), (one) => [key, one] as const), { concurrency: Math.max(1, entries.length) }).pipe(
    Effect.map(Object.fromEntries),
  )
}

/** The realm's own promise awaited (its rejection is the cell's throw); anything else as it is. */
const settledResult = <A>(result: A) => {
  if (Predicate.isPromise(result)) return Effect.promise(() => result)
  return Effect.succeed(result)
}

/**
 * A cell's last value as the call shows it, from what its compiled code
 * returned: replMode wraps the last expression as `{ value }`, or a promise
 * of it; an absent or undefined value shows nothing.
 */
export const lastValue = <A>(result: A, describe: Describe) =>
  Effect.runPromise(
    settledResult(result).pipe(
      Effect.map((wrapper) => Option.filter(Option.some(wrapper), Predicate.isObject)),
      Effect.map(Option.flatMap((wrapper) => Option.fromUndefinedOr(Object.getOwnPropertyDescriptor(wrapper, "value")?.value))),
      Effect.flatMap((value) => Effect.transposeOption(Option.map(value, (one) => shown(one, describe)))),
    ),
  )
