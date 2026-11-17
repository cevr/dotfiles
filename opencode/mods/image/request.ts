// The tool's input and the request a run carries out. `Input` is what the
// agent sends; `resolve` turns it into a `Request` (absolute paths, defaults,
// the subscription's model candidates), the file a job's runner reads; `check`
// holds a request to okra's option rules before anything is sent.
//
// The paid OpenAI Images API is reached only through `paid`: a request without
// it is a subscription request whatever else it holds (`route.ts`).
import { Array as Arr, Option, Result, Schema } from "effect"
import { type ImageFailed, invalid } from "./outcome.ts"
import { validSize } from "./size.ts"

export const Format = Schema.Literals(["png", "webp", "jpeg"])
export type Format = typeof Format.Type

export const Quality = Schema.Literals(["auto", "low", "medium", "high", "xhigh", "max"])
export type Quality = typeof Quality.Type

export const Background = Schema.Literals(["auto", "transparent", "opaque"])
export type Background = typeof Background.Type

/** The paid models: GPT Image 2.5 Flare (fast) and Sunburst (precise edits). */
export const PaidModel = Schema.Literals(["flare", "sunburst"])
export type PaidModel = typeof PaidModel.Type

/** The API's id of a paid model. */
export const paidModelId = (model: PaidModel) => `gpt-image-2.5-${model}`

/** The most references or sources one request takes. */
export const MAX_IMAGES = 16
/** The most images one paid request asks for. */
export const MAX_COUNT = 10
/** The largest image file a request reads. */
export const MAX_IMAGE_BYTES = 20 * 1024 * 1024
/** The subscription's main model when OpenCode lists none. */
export const FALLBACK_MODEL = "gpt-6-sol"

/** The paid options as the agent sends them. */
export const PaidInput = Schema.Struct({
  model: PaidModel,
  quality: Schema.optionalKey(Quality),
  background: Schema.optionalKey(Background),
  n: Schema.optionalKey(Schema.Int),
  mask: Schema.optionalKey(Schema.String),
})
export interface PaidInput extends Schema.Schema.Type<typeof PaidInput> {}

/** The tool's input. */
export const Input = Schema.Struct({
  prompt: Schema.String,
  images: Schema.optionalKey(Schema.Array(Schema.String)),
  path: Schema.optionalKey(Schema.String),
  size: Schema.optionalKey(Schema.String),
  format: Schema.optionalKey(Format),
  paid: Schema.optionalKey(PaidInput),
})
export interface Input extends Schema.Schema.Type<typeof Input> {}

/** The paid options of a request, the mask's path absolute. */
export const Paid = Schema.Struct({
  model: PaidModel,
  quality: Schema.OptionFromOptionalKey(Quality),
  background: Schema.OptionFromOptionalKey(Background),
  n: Schema.OptionFromOptionalKey(Schema.Int),
  mask: Schema.OptionFromOptionalKey(Schema.String),
})
export interface Paid extends Schema.Schema.Type<typeof Paid> {}

/** What a run carries out: every path absolute, every default filled in. */
export const Request = Schema.Struct({
  prompt: Schema.String,
  images: Schema.Array(Schema.String),
  path: Schema.String,
  size: Schema.String,
  format: Format,
  /** The subscription's main models, newest first; the next is tried when the backend refuses one. */
  models: Schema.Array(Schema.String),
  paid: Schema.OptionFromOptionalKey(Paid),
})
export interface Request extends Schema.Schema.Type<typeof Request> {}

/** The request file's JSON. */
export const RequestJson = Schema.fromJsonString(Request)

const MEDIA = new Map([
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".webp", "image/webp"],
  [".gif", "image/gif"],
])

/** The media type a file's extension names, if it is an image a request takes. */
export const media = (path: string): Option.Option<string> => {
  const dot = path.lastIndexOf(".")
  if (dot < 0 || dot < path.lastIndexOf("/")) return Option.none()
  return Option.fromNullishOr(MEDIA.get(path.slice(dot).toLowerCase()))
}

/** `prompt` as a file name: lowercase words joined by `-`, at most 60 characters, `image` when none. */
export const slug = (prompt: string) => {
  const words = prompt.toLowerCase().replace(/[^a-z0-9]+/gu, "-").replace(/^-+|-+$/gu, "").slice(0, 60)
  if (words.length > 0) return words
  return "image"
}

/** The `index`th of several outputs (from 1): `-<index>` before the extension, or at the end. */
export const numbered = (path: string, index: number) => {
  const dot = path.lastIndexOf(".")
  if (dot > path.lastIndexOf("/") && dot > path.lastIndexOf("\\")) return `${path.slice(0, dot)}-${index}${path.slice(dot)}`
  return `${path}-${index}`
}

/** `path` against `directory`, unless it is absolute already. */
export const absolute = (directory: string, path: string) => {
  if (path.startsWith("/")) return path
  return `${directory.replace(/\/+$/u, "")}/${path.replace(/^\.\//u, "")}`
}

/** Where a call's request is resolved: the session's directory, the folder default outputs go in, the call's id and the subscription's models. */
export interface CallContext {
  readonly directory: string
  readonly outputs: string
  readonly id: string
  readonly models: ReadonlyArray<string>
}

const resolvePaid = (paid: PaidInput, directory: string): Paid => ({
  model: paid.model,
  quality: Option.fromNullishOr(paid.quality),
  background: Option.fromNullishOr(paid.background),
  n: Option.fromNullishOr(paid.n),
  mask: Option.map(Option.fromNullishOr(paid.mask), (mask) => absolute(directory, mask)),
})

const modelsOf = (models: ReadonlyArray<string>): ReadonlyArray<string> => {
  if (models.length > 0) return models
  return [FALLBACK_MODEL]
}

/** The request an input asks for, in `context`. */
export const resolve = (input: Input, context: CallContext): Request => {
  const format = Option.getOrElse(Option.fromNullishOr(input.format), (): Format => "png")
  return {
    prompt: input.prompt,
    images: Arr.map(Option.getOrElse(Option.fromNullishOr(input.images), () => []), (image) => absolute(context.directory, image)),
    path: Option.match(Option.fromNullishOr(input.path), {
      onNone: () => `${absolute(context.directory, context.outputs)}/${slug(input.prompt)}-${context.id}.${format}`,
      onSome: (path) => absolute(context.directory, path),
    }),
    size: Option.getOrElse(Option.fromNullishOr(input.size), () => "auto"),
    format,
    models: modelsOf(context.models),
    paid: Option.map(Option.fromNullishOr(input.paid), (paid) => resolvePaid(paid, context.directory)),
  }
}

/** The first problem of `problems` that holds, as an INVALID_INPUT failure. */
const firstProblem = (problems: ReadonlyArray<readonly [boolean, string]>) =>
  Option.map(
    Arr.findFirst(problems, ([holds]) => holds),
    ([, message]) => invalid(message),
  )

const paidProblems = (request: Request, paid: Paid): ReadonlyArray<readonly [boolean, string]> => [
  [Option.exists(paid.n, (n) => n < 1 || n > MAX_COUNT), `paid.n must be 1 to ${MAX_COUNT}.`],
  [Option.isSome(paid.mask) && request.images.length === 0, "paid.mask needs a source image: pass the image to edit in images."],
  [Option.exists(paid.mask, (mask) => !mask.toLowerCase().endsWith(".png")), "paid.mask must be a PNG whose transparent areas mark where to edit."],
]

/** `request` if it keeps the option rules, else the first rule it breaks. */
export const check = (request: Request): Result.Result<Request, ImageFailed> => {
  const unsupported = Arr.findFirst(request.images, (image) => Option.isNone(media(image)))
  const problems: ReadonlyArray<readonly [boolean, string]> = [
    [request.prompt.trim().length === 0, "Missing prompt: say what to create or change."],
    [request.images.length > MAX_IMAGES, `At most ${MAX_IMAGES} images, got ${request.images.length}.`],
    [Option.isSome(unsupported), `Unsupported image type: ${Option.getOrElse(unsupported, () => "")} (use png/jpg/jpeg/webp/gif).`],
    [!validSize(request.size), `Invalid size: ${request.size} (use auto or WIDTHxHEIGHT, e.g. 1536x1024).`],
    [request.models.length === 0 && Option.isNone(request.paid), "No subscription model to ask."],
    ...Option.match(request.paid, { onNone: () => [], onSome: (paid) => paidProblems(request, paid) }),
  ]
  return Option.match(firstProblem(problems), {
    onNone: () => Result.succeed(request),
    onSome: (failed) => Result.fail(failed),
  })
}
