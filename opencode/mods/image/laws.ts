// What every implementation of ImageFiles and OpenAiKey owes, as shared test
// suites. Each implementation's test beside it runs them over a fresh store
// per case, made in the case's scope.
import { describe, expect, test } from "bun:test"
import { Effect, type Layer, Option, Redacted, type Scope } from "effect"
import { MAX_IMAGE_BYTES } from "./request.ts"
import { ImageFiles, OpenAiKey } from "./service.ts"

/** A fresh, empty file store and the folder its paths go under. */
export interface FreshFiles {
  readonly layer: Layer.Layer<ImageFiles>
  readonly root: string
}

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3])

const failure = <A, E extends { readonly code: string }, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.match(effect, { onFailure: (failed) => failed.code, onSuccess: () => "succeeded" })

export const imageFilesLaws = (name: string, fresh: Effect.Effect<FreshFiles, never, Scope.Scope>) => {
  const law = <A, E>(body: (root: string) => Effect.Effect<A, E, ImageFiles>) =>
    Effect.runPromise(Effect.scoped(Effect.flatMap(fresh, (store) => Effect.provide(body(store.root), store.layer))))

  describe(`${name} keeps the ImageFiles laws`, () => {
    test("a written image reads back whole, with the media type its extension names, its folders made", () =>
      law((root) =>
        Effect.gen(function* () {
          const files = yield* ImageFiles
          yield* files.write(`${root}/a/b/one.png`, PNG)
          const part = yield* files.read(`${root}/a/b/one.png`)
          expect([...part.data]).toEqual([...PNG])
          expect(part.media).toBe("image/png")
          yield* files.write(`${root}/two.JPEG`, PNG)
          expect((yield* files.read(`${root}/two.JPEG`)).media).toBe("image/jpeg")
        }),
      ))

    test("a missing image, a file of another type and one over the size limit are INVALID_INPUT", () =>
      law((root) =>
        Effect.gen(function* () {
          const files = yield* ImageFiles
          expect(yield* failure(files.read(`${root}/gone.png`))).toBe("INVALID_INPUT")
          yield* files.write(`${root}/notes.txt`, PNG)
          expect(yield* failure(files.read(`${root}/notes.txt`))).toBe("INVALID_INPUT")
          yield* files.write(`${root}/huge.png`, new Uint8Array(MAX_IMAGE_BYTES + 1))
          expect(yield* failure(files.read(`${root}/huge.png`))).toBe("INVALID_INPUT")
        }),
      ))
  })
}

/** `fresh(key)`: a key store holding `key`, or none. */
export const openAiKeyLaws = (name: string, fresh: (key: Option.Option<string>) => Effect.Effect<Layer.Layer<OpenAiKey>, never, Scope.Scope>) => {
  const law = <A, E>(key: Option.Option<string>, body: Effect.Effect<A, E, OpenAiKey>) =>
    Effect.runPromise(Effect.scoped(Effect.flatMap(fresh(key), (layer) => Effect.provide(body, layer))))

  describe(`${name} keeps the OpenAiKey laws`, () => {
    test("a stored key is answered on every read", () =>
      law(
        Option.some("sk-law-key-0123456789"),
        Effect.gen(function* () {
          const key = yield* OpenAiKey
          expect(Redacted.value(yield* key.read)).toBe("sk-law-key-0123456789")
          expect(Redacted.value(yield* key.read)).toBe("sk-law-key-0123456789")
        }),
      ))

    test("no key is AUTH_MISSING", () =>
      law(
        Option.none(),
        Effect.gen(function* () {
          const key = yield* OpenAiKey
          expect(yield* failure(key.read)).toBe("AUTH_MISSING")
        }),
      ))
  })
}
