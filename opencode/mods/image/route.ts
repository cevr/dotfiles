// The cost rule: which backend a request goes to. The ChatGPT subscription is
// the default and costs nothing past the plan; the paid OpenAI Images API is
// reached only when the request carries `paid`, and nothing else turns it on.
// `label` names the route in every outcome, so a paid call is never silent.
import { Data, Option } from "effect"
import { type Paid, paidModelId, type Request } from "./request.ts"

export type Route = Data.TaggedEnum<{
  /** The subscription's Codex backend, asked with each main model in turn. */
  Subscription: { readonly models: ReadonlyArray<string> }
  /** The paid Images API: a generation, or an edit of the request's images. */
  Paid: { readonly paid: Paid; readonly edit: boolean }
}>
export const Route = Data.taggedEnum<Route>()

/** The route `request` takes: paid only when it carries `paid`. */
export const route = (request: Request): Route =>
  Option.match(request.paid, {
    onNone: () => Route.Subscription({ models: request.models }),
    onSome: (paid) => Route.Paid({ paid, edit: request.images.length > 0 }),
  })

const editWord = (edit: boolean) => {
  if (edit) return " edit"
  return ""
}

const paidLabel = (paid: Paid, edit: boolean) => {
  const verb = editWord(edit)
  const quality = Option.getOrElse(paid.quality, () => "auto")
  const n = Option.getOrElse(paid.n, () => 1)
  return `paid${verb}: ${paidModelId(paid.model)}, quality ${quality}, n ${n}`
}

/** The route in words, as receipts and letters name it. */
export const label = (route: Route): string =>
  Route.$match(route, {
    Subscription: () => "subscription",
    Paid: ({ paid, edit }) => paidLabel(paid, edit),
  })
