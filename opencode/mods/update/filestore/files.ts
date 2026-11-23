import { publishReviewInput, readReviewInput, removeReviewInput, type ReviewInputAccess, siblingReviewInputLock } from "@dotfiles/opencode-work/process/landing"
import { file, write } from "bun"
import { Effect, Option } from "effect"
import { UpdateFailed } from "../service.ts"

/** A file's text; none when it does not exist or cannot be read. */
export const readText = (path: string): Effect.Effect<Option.Option<string>> =>
  Effect.tryPromise(() => file(path).text()).pipe(
    Effect.map(Option.some),
    Effect.orElseSucceed(() => Option.none<string>()),
  )

/** Writes `text` to `path`, making its directory. */
export const writeText = (step: string, path: string, text: string): Effect.Effect<void, UpdateFailed> =>
  Effect.tryPromise({ try: () => write(path, text, { createPath: true }), catch: (cause) => new UpdateFailed({ step, message: String(cause) }) }).pipe(Effect.asVoid)

/** Publish update facts consumed by review. An already published version is never written again. */
export const publishText = (step: string, path: string, access: ReviewInputAccess, text: string): Effect.Effect<void, UpdateFailed> =>
  publishReviewInput(step, path, siblingReviewInputLock(path), access, text).pipe(Effect.mapError((cause) => new UpdateFailed({ step, message: cause.message })))

export const readPublished = (step: string, path: string): Effect.Effect<Option.Option<string>, UpdateFailed> =>
  readReviewInput(step, path).pipe(Effect.mapError((cause) => new UpdateFailed({ step, message: cause.message })))

export const removePublished = (step: string, path: string, owns: (text: string) => boolean): Effect.Effect<void, UpdateFailed> =>
  removeReviewInput(step, path, siblingReviewInputLock(path), owns).pipe(Effect.mapError((cause) => new UpdateFailed({ step, message: cause.message })))
