// The contracts the image model needs from outside: the two backends, the
// paid API's key and the image files. Each operation fails only with
// ImageFailed, its code saying which; `laws.ts` states what the file and key
// implementations owe.
//
// The key is a dependency of the paid backend's implementation alone
// (`openai/images.ts`), never of the model: a subscription request cannot
// reach it, and the model never holds it.
import { Context, type Effect, type Option, type Redacted, Schema } from "effect"
import type { Listed } from "./models.ts"
import type { ImageFailed } from "./outcome.ts"
import type { Background, Format, Quality, Request } from "./request.ts"

/** An image's bytes and media type: a reference, a source to edit or a mask. */
export interface Part {
  readonly data: Uint8Array
  readonly media: string
}

/** One subscription request: the main model asked, the prompt, the size asked, the format and the references. */
export interface SubscriptionAsk {
  readonly model: string
  readonly prompt: string
  readonly size: string
  readonly format: Format
  readonly references: ReadonlyArray<Part>
}

/** The ChatGPT subscription's Codex backend, which answers one image. */
export class Subscription extends Context.Service<
  Subscription,
  {
    readonly generate: (ask: SubscriptionAsk) => Effect.Effect<Uint8Array, ImageFailed>
  }
>()("dotfiles-opencode/image/Subscription") {}

/** One paid request. `sources` empty is a generation; otherwise an edit of them, under `mask` when given. */
export interface PaidAsk {
  readonly model: string
  readonly prompt: string
  readonly size: string
  readonly format: Format
  readonly quality: Option.Option<Quality>
  readonly background: Option.Option<Background>
  readonly n: Option.Option<number>
  readonly sources: ReadonlyArray<Part>
  readonly mask: Option.Option<Part>
}

/** The paid OpenAI Images API, which answers one image or more. */
export class PaidImages extends Context.Service<
  PaidImages,
  {
    readonly generate: (ask: PaidAsk) => Effect.Effect<ReadonlyArray<Uint8Array>, ImageFailed>
  }
>()("dotfiles-opencode/image/PaidImages") {}

/** The paid API's key: AUTH_MISSING when there is none. Read on each paid request, never cached by the model. */
export class OpenAiKey extends Context.Service<
  OpenAiKey,
  {
    readonly read: Effect.Effect<Redacted.Redacted<string>, ImageFailed>
  }
>()("dotfiles-opencode/image/OpenAiKey") {}

/**
 * The image files: `read` loads an image a request names (INVALID_INPUT when
 * it is missing, of another type or too large); `write` saves an output,
 * making its folder (WRITE_FAILED when it cannot).
 */
export class ImageFiles extends Context.Service<
  ImageFiles,
  {
    readonly read: (path: string) => Effect.Effect<Part, ImageFailed>
    readonly write: (path: string, data: Uint8Array) => Effect.Effect<void, ImageFailed>
  }
>()("dotfiles-opencode/image/ImageFiles") {}

/** The models OpenCode lists in a directory, by the fields the subscription's model rule reads; none when it cannot say. */
export class Catalog extends Context.Service<
  Catalog,
  {
    readonly models: (directory: string) => Effect.Effect<ReadonlyArray<Listed>>
  }
>()("dotfiles-opencode/image/Catalog") {}

/**
 * The request files a job's runner reads: `save` keeps a request under its
 * call's id and answers the file; `read` loads one back (INVALID_INPUT when it
 * is missing or not a request); `remove` drops it, gone or not.
 */
export class Requests extends Context.Service<
  Requests,
  {
    readonly save: (id: string, request: Request) => Effect.Effect<string, ImageFailed>
    readonly read: (file: string) => Effect.Effect<Request, ImageFailed>
    readonly remove: (file: string) => Effect.Effect<void>
  }
>()("dotfiles-opencode/image/Requests") {}

/** The jobs host would not start the runner; `reason` is its words. */
export class JobRefused extends Schema.TaggedError<JobRefused>()("JobRefused", {
  reason: Schema.String,
}) {}

/** One runner job: the request file it carries out, the directory it runs in and the note its end letter carries. */
export interface JobStart {
  readonly file: string
  readonly cwd: string
  readonly note: string
}

/** Jobs outside the server (the wakes' jobs): `start` runs the image runner on a request file for a session, and answers the job's id. */
export class Jobs extends Context.Service<
  Jobs,
  {
    readonly start: (sessionID: string, job: JobStart) => Effect.Effect<string, JobRefused>
  }
>()("dotfiles-opencode/image/Jobs") {}
