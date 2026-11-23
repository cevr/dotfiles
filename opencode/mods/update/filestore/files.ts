import { publishReviewInput, type ReviewInputAccess } from "@dotfiles/opencode-work/process/landing"
import { file, write } from "bun"
import { Effect, Option } from "effect"
import { dirname, join } from "node:path"
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

/** The writer lock for a review input; stage and handoff use the same lock for the installed record. */
export const publicationLock = (path: string): string => join(dirname(path), ".review-input.lock")

/** Publish update facts consumed by review. An already published version is never written again. */
export const publishText = (step: string, path: string, access: ReviewInputAccess, text: string): Effect.Effect<void, UpdateFailed> =>
  publishReviewInput(step, path, publicationLock(path), access, text).pipe(Effect.mapError((cause) => new UpdateFailed({ step, message: cause.message })))

/** Deletes `path`; a file already gone is fine. */
export const remove = (path: string): Effect.Effect<void> =>
  Effect.tryPromise(() => file(path).delete()).pipe(Effect.orElseSucceed(() => "gone"), Effect.asVoid)
