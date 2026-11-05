// What every implementation of a contract in service.ts owes, as shared test
// suites. Each implementation's test beside it runs the suite over its Layer.
// The token, usage and login contracts have one implementation each, over
// fetch and OpenCode's integration; their tests beside them say what they owe.
import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import type { SourcedCredential } from "./credential-source.ts"
import { CredentialSources, Entropy } from "./service.ts"

const check = <A, E, R>(layer: Layer.Layer<R>, body: Effect.Effect<A, E, R>) =>
  Effect.runPromise(Effect.scoped(body.pipe(Effect.provide(layer))))

// ── Entropy ──

export const entropyLaws = (name: string, layer: Layer.Layer<Entropy>) =>
  describe(`${name} keeps the Entropy laws`, () => {
    test("gives exactly the bytes asked for", () =>
      check(
        layer,
        Effect.gen(function* () {
          const entropy = yield* Entropy
          for (const size of [0, 4, 16, 64]) expect(entropy.bytes(size).byteLength).toBe(size)
        }),
      ))

    test("two draws differ", () =>
      check(
        layer,
        Effect.gen(function* () {
          const entropy = yield* Entropy
          expect(Array.from(entropy.bytes(32))).not.toEqual(Array.from(entropy.bytes(32)))
        }),
      ))
  })

// ── CredentialSources ──

/** A source as a law sets it up: the plugin-facing shape, with promises. */
export interface LawSource {
  readonly owns: (credentialID: string) => boolean
  readonly resolve: (credentialID: string) => Promise<unknown>
  readonly peek?: (credentialID: string) => Promise<unknown>
  readonly rejected?: (credentialID: string, access: string) => void
}

const token = (access: string): SourcedCredential => ({ access, expires: 9_000_000 })

const failing = (message: string, retryAt?: number) =>
  Object.assign(new Error(message), retryAt === undefined ? {} : { retryAt })

/** `layer(sources)` keeps exactly `sources`, in order, for as long as it is built. */
export const credentialSourcesLaws = (name: string, layer: (sources: ReadonlyArray<LawSource>) => Layer.Layer<CredentialSources>) =>
  describe(`${name} keeps the CredentialSources laws`, () => {
    const owner = (ids: ReadonlyArray<string>, overrides: Partial<LawSource> = {}): LawSource => ({
      owns: (id) => ids.includes(id),
      resolve: (id) => Promise.resolve(token(`access-${id}`)),
      ...overrides,
    })

    test("finds the source that owns a credential, and none for one no source owns", () =>
      check(
        layer([owner(["cred-a"]), owner(["cred-b"], { resolve: () => Promise.resolve(token("from-b")) })]),
        Effect.gen(function* () {
          const sources = yield* CredentialSources
          expect(yield* sources.find("cred-missing")).toBeUndefined()
          const b = yield* sources.find("cred-b")
          expect(b === undefined ? undefined : yield* b.resolve).toEqual(token("from-b"))
        }),
      ))

    test("hands out only a usable token", () =>
      check(
        layer([owner(["cred-a"], { resolve: () => Promise.resolve({ access: "", expires: 1 }) })]),
        Effect.gen(function* () {
          const source = yield* (yield* CredentialSources).find("cred-a")
          const failure = source === undefined ? undefined : yield* Effect.flip(source.resolve)
          expect(failure?._tag).toBe("SourceFailed")
          expect(failure?.retryAt).toBeUndefined()
        }),
      ))

    test("a failure keeps its message and the time it says the credential may be tried again", () =>
      check(
        layer([owner(["cred-a"], { resolve: () => Promise.reject(failing("held", 5_000)) })]),
        Effect.gen(function* () {
          const source = yield* (yield* CredentialSources).find("cred-a")
          const failure = source === undefined ? undefined : yield* Effect.flip(source.resolve)
          expect(failure?.message).toBe("held")
          expect(failure?.retryAt).toBe(5_000)
        }),
      ))

    test("peeks without failing: absent without a peek, nothing when the peek fails", () =>
      check(
        layer([
          owner(["no-peek"]),
          owner(["peeks"], { peek: () => Promise.resolve(token("peeked")) }),
          owner(["broken"], { peek: () => Promise.reject(new Error("no")) }),
        ]),
        Effect.gen(function* () {
          const sources = yield* CredentialSources
          expect((yield* sources.find("no-peek"))?.peek).toBeUndefined()
          const peeks = (yield* sources.find("peeks"))?.peek
          expect(peeks === undefined ? undefined : yield* peeks).toEqual(token("peeked"))
          const broken = (yield* sources.find("broken"))?.peek
          expect(broken).toBeDefined()
          expect(broken === undefined ? "absent" : yield* broken).toBeUndefined()
        }),
      ))

    test("passes a rejected token on, and never fails for it", () => {
      const rejected: Array<readonly [string, string]> = []
      return check(
        layer([
          owner(["cred-a"], { rejected: (id, access) => void rejected.push([id, access]) }),
          owner(["cred-b"], {
            rejected: () => {
              throw new Error("source broke")
            },
          }),
        ]),
        Effect.gen(function* () {
          const sources = yield* CredentialSources
          yield* Effect.flatMap(sources.find("cred-a"), (source) => source?.rejected("tok") ?? Effect.void)
          yield* Effect.flatMap(sources.find("cred-b"), (source) => source?.rejected("tok") ?? Effect.void)
          expect(rejected).toEqual([["cred-a", "tok"]])
        }),
      )
    })
  })
