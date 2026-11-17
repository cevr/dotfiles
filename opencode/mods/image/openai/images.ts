// The PaidImages contract over the OpenAI Images API, ported from okra's
// OpenAI route: `POST <origin>/images/generations` (JSON) for a generation,
// `POST <origin>/images/edits` (multipart: `image`, or `image[]` for several,
// and `mask`) when there are sources. Every request here is billed to the key.
//
// The key is this implementation's own dependency (OpenAiKey), read on each
// request and sent only to `origin`: redirects are refused. Server messages
// pass through `detail`, which cuts the key out before an outcome carries it.
import { Array as Arr, Effect, Layer, Option, Redacted, Schema } from "effect"
import { detail, fail, type ImageFailed } from "../outcome.ts"
import { OpenAiKey, type PaidAsk, PaidImages, type Part } from "../service.ts"
import { decodeBase64 } from "../stream.ts"

export const ORIGIN = "https://api.openai.com/v1"

export interface Options {
  /** Where the Images API is: `ORIGIN`, or a local fake in tests. */
  readonly origin: string
  /** How long one request may take. */
  readonly timeoutMs: number
}

const KEY_HINT = "Set OPENAI_API_KEY or store a key with `bun cmd/image/key.ts set --stdin`."

const Images = Schema.fromJsonString(
  Schema.Struct({
    created: Schema.Int,
    data: Schema.optionalKey(Schema.Array(Schema.Struct({ b64_json: Schema.optionalKey(Schema.String) }))),
  }),
)
const decodeImages = Schema.decodeUnknownOption(Images)

const ApiError = Schema.fromJsonString(Schema.Struct({ error: Schema.Struct({ message: Schema.String }) }))
const decodeApiError = Schema.decodeUnknownOption(ApiError)

const messageOf = (text: string) => Option.match(decodeApiError(text), { onNone: () => text, onSome: (error) => error.error.message })

/** The options a request sets, by the API's names. */
const scalars = (ask: PaidAsk): ReadonlyArray<readonly [string, string]> => [
  ["prompt", ask.prompt],
  ["model", ask.model],
  ["size", ask.size],
  ["output_format", ask.format],
  ...Option.toArray(Option.map(ask.quality, (quality) => ["quality", quality] as const)),
  ...Option.toArray(Option.map(ask.background, (background) => ["background", background] as const)),
  ...Option.toArray(Option.map(ask.n, (n) => ["n", String(n)] as const)),
]

/** The JSON body of a generation; `n` as a number. */
export const generationBody = (ask: PaidAsk) =>
  JSON.stringify(
    Object.fromEntries(
      Arr.map(scalars(ask), ([name, value]) => {
        if (name === "n") return [name, Number(value)]
        return [name, value]
      }),
    ),
  )

const extension = (part: Part) => {
  if (part.media === "image/jpeg") return "jpg"
  if (part.media === "image/webp") return "webp"
  return "png"
}

const file = (part: Part, name: string) => new File([part.data.slice()], `${name}.${extension(part)}`, { type: part.media })

const imageField = (count: number) => {
  if (count > 1) return "image[]"
  return "image"
}

/** The multipart body of an edit. */
export const editBody = (ask: PaidAsk) => {
  const form = new FormData()
  Arr.forEach(scalars(ask), ([name, value]) => form.append(name, value))
  Arr.forEach(ask.sources, (part, index) => form.append(imageField(ask.sources.length), file(part, `image-${index}`)))
  Option.map(ask.mask, (mask) => form.append("mask", file(mask, "mask")))
  return form
}

/** One request's shape: its path under the origin, its verb in messages, its headers and body. */
interface Call {
  readonly path: string
  readonly verb: string
  readonly headers: Readonly<Record<string, string>>
  readonly body: string | FormData
}

const callOf = (ask: PaidAsk, secret: string): Call => {
  const authorization = `Bearer ${secret}`
  if (ask.sources.length > 0) return { path: "edits", verb: "edit", headers: { authorization }, body: editBody(ask) }
  return { path: "generations", verb: "generation", headers: { authorization, "content-type": "application/json" }, body: generationBody(ask) }
}

interface Answer {
  readonly status: number
  readonly text: string
}

const statusFailure = (ask: PaidAsk, verb: string, answer: Answer, secrets: ReadonlyArray<string>): ImageFailed => {
  const why = detail(messageOf(answer.text), secrets)
  if (answer.status === 401 || answer.status === 403) return fail("AUTH_EXPIRED", `OpenAI API key was rejected (${why}). ${KEY_HINT}`)
  return fail("GENERATION_FAILED", `Image ${verb} failed (${ask.model}, HTTP ${answer.status}): ${why}`)
}

const imagesOf = (ask: PaidAsk, text: string) =>
  Option.match(decodeImages(text), {
    onNone: () => Effect.fail(fail("GENERATION_FAILED", `OpenAI returned an unexpected response (${ask.model}): response does not match the expected schema`)),
    onSome: (response) => {
      const encoded = Arr.getSomes(Arr.map(response.data ?? [], (item) => Option.fromNullishOr(item.b64_json)))
      if (encoded.length === 0) return Effect.fail(fail("NO_IMAGE", "OpenAI returned no image data. Try rephrasing the prompt."))
      return Effect.forEach(encoded, (base64) => Effect.fromResult(decodeBase64(base64, "OpenAI")))
    },
  })

export const layer = (options: Options) =>
  Layer.effect(
    PaidImages,
    Effect.gen(function* () {
      const key = yield* OpenAiKey
      return PaidImages.of({
        generate: Effect.fn("PaidImages.generate")(function* (ask: PaidAsk) {
          const secret = Redacted.value(yield* key.read)
          const call = callOf(ask, secret)
          const verb = call.verb
          const answer: Answer = yield* Effect.tryPromise({
            try: (signal) =>
              fetch(`${options.origin}/images/${call.path}`, { method: "POST", headers: call.headers, body: call.body, redirect: "manual", signal }).then(
                (response) => response.text().then((text) => ({ status: response.status, text })),
              ),
            catch: () => fail("GENERATION_FAILED", `Image ${verb} failed (${ask.model}): request transport failed`),
          }).pipe(
            Effect.timeoutOrElse({
              duration: options.timeoutMs,
              orElse: () => Effect.fail(fail("GENERATION_FAILED", `Image ${verb} failed (${ask.model}): no answer in ${options.timeoutMs / 1000} s`)),
            }),
          )
          if (answer.status < 200 || answer.status >= 300) return yield* Effect.fail(statusFailure(ask, verb, answer, [secret]))
          return yield* imagesOf(ask, answer.text)
        }),
      })
    }),
  )
