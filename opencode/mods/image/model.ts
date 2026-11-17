// The image handlers. `generate` checks a request, reads the images it names,
// sends it down the one route `route` picks, and saves what comes back: one
// file at the request's path, or `-1`, `-2`, … beside it when the paid API
// answers several. The subscription route asks each main model in turn while
// the backend answers that a model is not supported with Codex (okra's
// fall-through), and notes a size it changed.
//
// The paid backend is a dependency here, but only `route`'s Paid branch calls
// it; the key it needs is its own implementation's dependency.
import { Array as Arr, Context, Effect, Layer, Option } from "effect"
import { fail, type ImageFailed, type Outcome, type Saved } from "./outcome.ts"
import { check, numbered, type Paid, paidModelId, type Request } from "./request.ts"
import { label, Route, route } from "./route.ts"
import { ImageFiles, PaidImages, type Part, Subscription, type SubscriptionAsk } from "./service.ts"
import { dimensionsOf, sizeNote } from "./size.ts"

export class Images extends Context.Service<
  Images,
  {
    /** Carry out `request`: the files saved and the route taken, or the failure. */
    readonly generate: (request: Request) => Effect.Effect<Outcome, ImageFailed>
  }
>()("dotfiles-opencode/image/Images") {}

/** The Codex backend's words for a main model it will not run for this account. */
export const MODEL_REFUSED = "model is not supported when using Codex"

const refused = (failed: ImageFailed) => failed.message.includes(MODEL_REFUSED)

/** Where the `index`th of `count` outputs goes. */
const outputPath = (path: string, index: number, count: number) => {
  if (count === 1) return path
  return numbered(path, index + 1)
}

const savedOf = (path: string, data: Uint8Array): Saved => {
  const dimensions = dimensionsOf(data)
  return { path, width: Option.map(dimensions, (d) => d.width), height: Option.map(dimensions, (d) => d.height) }
}

export const layer = Layer.effect(
  Images,
  Effect.gen(function* () {
    const subscription = yield* Subscription
    const paidImages = yield* PaidImages
    const files = yield* ImageFiles

    const readAll = (paths: ReadonlyArray<string>) => Effect.forEach(paths, files.read)

    const save = Effect.fn("Images.save")(function* (path: string, images: ReadonlyArray<Uint8Array>) {
      return yield* Effect.forEach(images, (data, index) => {
        const target = outputPath(path, index, images.length)
        return files.write(target, data).pipe(Effect.as(savedOf(target, data)))
      })
    })

    /** Ask `models` in order, moving on only when the backend refuses a model. */
    const askModels = (
      models: ReadonlyArray<string>,
      ask: Omit<SubscriptionAsk, "model">,
      last: ImageFailed,
    ): Effect.Effect<Uint8Array, ImageFailed> =>
      Arr.match(models, {
        onEmpty: () => Effect.fail(last),
        onNonEmpty: ([model, ...rest]) =>
          subscription.generate({ ...ask, model }).pipe(Effect.catchIf(refused, (failed) => askModels(rest, ask, failed))),
      })

    const viaSubscription = Effect.fn("Images.viaSubscription")(function* (request: Request, models: ReadonlyArray<string>) {
      const references = yield* readAll(request.images)
      const ask = { prompt: request.prompt, size: request.size, format: request.format, references }
      const data = yield* askModels(models, ask, fail("NO_IMAGE", "Backend returned no image. Try rephrasing the prompt."))
      const saved = yield* save(request.path, [data])
      return { saved, note: sizeNote(request.size, dimensionsOf(data)) }
    })

    const viaPaid = Effect.fn("Images.viaPaid")(function* (request: Request, paid: Paid) {
      const sources = yield* readAll(request.images)
      const mask: Option.Option<Part> = yield* Effect.transposeOption(Option.map(paid.mask, files.read))
      const images = yield* paidImages.generate({
        model: paidModelId(paid.model),
        prompt: request.prompt,
        size: request.size,
        format: request.format,
        quality: paid.quality,
        background: paid.background,
        n: paid.n,
        sources,
        mask,
      })
      const saved = yield* save(request.path, images)
      return { saved, note: Option.none<string>() }
    })

    const generate = Effect.fn("Images.generate")(function* (unchecked: Request) {
      const request = yield* Effect.fromResult(check(unchecked))
      const chosen = route(request)
      const result = yield* Route.$match(chosen, {
        Subscription: ({ models }) => viaSubscription(request, models),
        Paid: ({ paid }) => viaPaid(request, paid),
      })
      return { route: label(chosen), saved: result.saved, note: result.note } satisfies Outcome
    })

    return Images.of({ generate })
  }),
)
