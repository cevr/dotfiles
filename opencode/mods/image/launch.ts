// A tool call's side: `prepare` turns the agent's input into a checked
// request (the subscription's models from OpenCode's catalog, paths against
// the session's directory, the default output in the session's image folder)
// and names its route; the composition root asks the permission for that
// route; `launch` keeps the request for the runner and starts the job whose
// end letter wakes the session. The image itself is made by the runner
// (`Images` in model.ts), outside the server.
import { Context, Effect, Layer } from "effect"
import { solModels } from "./models.ts"
import type { ImageFailed } from "./outcome.ts"
import { check, type Input, type Request, resolve } from "./request.ts"
import { label, type Route, route } from "./route.ts"
import { Catalog, Jobs, type JobRefused, Requests } from "./service.ts"
import { note } from "./tool.ts"

/** Where one call runs: its session and directory, the folder default outputs go in, and the call's id. */
export interface Place {
  readonly sessionID: string
  readonly directory: string
  readonly outputs: string
  readonly id: string
}

/** A checked request and its route, in words too. */
export interface Prepared {
  readonly request: Request
  readonly route: Route
  readonly label: string
}

/** A started call: the job's id, where the image goes and the route's words. */
export interface Started {
  readonly id: string
  readonly path: string
  readonly route: string
}

export class Launcher extends Context.Service<
  Launcher,
  {
    readonly prepare: (input: Input, place: Place) => Effect.Effect<Prepared, ImageFailed>
    readonly launch: (prepared: Prepared, place: Place) => Effect.Effect<Started, ImageFailed | JobRefused>
  }
>()("dotfiles-opencode/image/Launcher") {}

export const layer = Layer.effect(
  Launcher,
  Effect.gen(function* () {
    const catalog = yield* Catalog
    const requests = yield* Requests
    const jobs = yield* Jobs

    const prepare = Effect.fn("Launcher.prepare")(function* (input: Input, place: Place) {
      const models = solModels(yield* catalog.models(place.directory))
      const request = yield* Effect.fromResult(check(resolve(input, { directory: place.directory, outputs: place.outputs, id: place.id, models })))
      const chosen = route(request)
      return { request, route: chosen, label: label(chosen) } satisfies Prepared
    })

    const launch = Effect.fn("Launcher.launch")(function* (prepared: Prepared, place: Place) {
      const file = yield* requests.save(place.id, prepared.request)
      const id = yield* jobs.start(place.sessionID, { file, cwd: place.directory, note: note(prepared.label, prepared.request.prompt) }).pipe(
        Effect.tapError(() => requests.remove(file)),
      )
      return { id, path: prepared.request.path, route: prepared.label } satisfies Started
    })

    return Launcher.of({ prepare, launch })
  }),
)
