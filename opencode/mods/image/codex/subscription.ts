// The Subscription contract over the ChatGPT subscription's Codex backend,
// ported from okra's Codex route: one streamed Responses request
// (`POST <origin>/responses`, `store: false`) with the `image_generation` tool
// forced, the size stated in the prompt as well as in the tool, references
// sent as data URLs; the stream is read to its end and `completeImage` picks
// the image.
//
// The credentials are read for each request and sent only to `origin`:
// redirects are refused, so a token never follows one to another host. Every
// message the server sends back passes through `detail`, which cuts out the
// token and the account before an outcome carries it.
import { Effect, Layer, Option, Redacted, Result, Schema } from "effect"
import { detail, fail, type ImageFailed } from "../outcome.ts"
import { Subscription, type SubscriptionAsk } from "../service.ts"
import { sizeHint } from "../size.ts"
import { completeImage, decodeBase64 } from "../stream.ts"
import { type Credentials, read } from "./credentials.ts"

export const ORIGIN = "https://chatgpt.com/backend-api/codex"
export const INSTRUCTION = "You are an image generation assistant."
const ORIGINATOR = "codex_cli_rs"

export interface Options {
  /** Where the Codex backend is: `ORIGIN`, or a local fake in tests. */
  readonly origin: string
  /** The home whose `.codex/auth.json` holds the login. */
  readonly home: string
  /** How long one request may take. */
  readonly timeoutMs: number
}

/** The Responses request body for `ask`. */
export const body = (ask: SubscriptionAsk) => {
  const text = `${INSTRUCTION}\n\n${ask.prompt}${sizeHint(ask.size)}`
  const images = ask.references.map((part) => ({
    type: "input_image",
    image_url: `data:${part.media};base64,${part.data.toBase64()}`,
    detail: "auto",
  }))
  return {
    model: ask.model,
    input: [{ role: "user", content: [{ type: "input_text", text }, ...images] }],
    tools: [{ type: "image_generation", size: ask.size, output_format: ask.format }],
    tool_choice: { type: "image_generation" },
    store: false,
    stream: true,
  }
}

const headers = (credentials: Credentials, session: string) => ({
  authorization: `Bearer ${Redacted.value(credentials.token)}`,
  "chatgpt-account-id": credentials.account,
  "content-type": "application/json",
  accept: "text/event-stream",
  originator: ORIGINATOR,
  version: credentials.version,
  session_id: session,
  "user-agent": `${ORIGINATOR}/${credentials.version} (opencode)`,
})

const ApiError = Schema.fromJsonString(
  Schema.Union([
    Schema.Struct({ error: Schema.Struct({ message: Schema.String }) }),
    Schema.Struct({ detail: Schema.String }),
  ]),
)
const decodeApiError = Schema.decodeUnknownOption(ApiError)

/** The server's own message in an error body, or the body itself. */
export const messageOf = (text: string) =>
  Option.match(decodeApiError(text), {
    onNone: () => text,
    onSome: (error) => {
      if ("error" in error) return error.error.message
      return error.detail
    },
  })

/** Why a non-2xx answer failed, in okra's words, with the server's message redacted. */
const statusFailure = (status: number, text: string, secrets: ReadonlyArray<string>): ImageFailed => {
  if (status === 401 || status === 403) return fail("AUTH_EXPIRED", "Codex token rejected (expired or invalid). Run `codex login`.")
  if (status === 429) return fail("GENERATION_FAILED", "Image generation failed: Rate limit exceeded")
  if (status === 402) return fail("GENERATION_FAILED", "Image generation failed: Quota exhausted. Check your account billing and usage limits.")
  return fail("GENERATION_FAILED", `Image generation failed (HTTP ${status}): ${detail(messageOf(text), secrets)}`)
}

interface Answer {
  readonly status: number
  readonly text: string
}

export const layer = (options: Options) =>
  Layer.succeed(
    Subscription,
    Subscription.of({
      generate: Effect.fn("Subscription.generate")(function* (ask: SubscriptionAsk) {
        const credentials = yield* read(options.home)
        const secrets = [Redacted.value(credentials.token), credentials.account]
        const answer: Answer = yield* Effect.tryPromise({
          try: (signal) =>
            fetch(`${options.origin}/responses`, {
              method: "POST",
              headers: headers(credentials, crypto.randomUUID()),
              body: JSON.stringify(body(ask)),
              redirect: "manual",
              signal,
            }).then((response) => response.text().then((text) => ({ status: response.status, text }))),
          catch: () => fail("GENERATION_FAILED", "Image generation failed: request transport failed"),
        }).pipe(
          Effect.timeoutOrElse({
            duration: options.timeoutMs,
            orElse: () => Effect.fail(fail("GENERATION_FAILED", `Image generation failed: no answer in ${options.timeoutMs / 1000} s`)),
          }),
        )
        if (answer.status < 200 || answer.status >= 300) return yield* Effect.fail(statusFailure(answer.status, answer.text, secrets))
        const base64 = yield* Result.match(completeImage(answer.text), {
          onFailure: (failed) => Effect.fail(fail(failed.code, detail(failed.message, secrets))),
          onSuccess: Effect.succeed,
        })
        return yield* Effect.fromResult(decodeBase64(base64, "Backend"))
      }),
    }),
  )
