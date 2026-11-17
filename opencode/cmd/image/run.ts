/**
 * The image job's runner: what an `image` call starts as a wake job,
 * `bun run.ts <request file> [--codex-origin URL] [--codex-home DIR]
 * [--openai-origin URL]`, outside the OpenCode server. It reads the request,
 * removes its file, makes the image down the one route the request picks
 * (`Images` in mods/image model.ts) and prints the outcome, which the job's
 * end letter carries: the saved paths with their sizes and the route, or the
 * failure's code, message and fix (exit 1).
 *
 * The Codex login is read from `<home>/.codex/auth.json` on the request; the
 * paid API's key from OPENAI_API_KEY, else the plugin's key file. Neither is
 * ever printed.
 */
import * as TuiDirs from "@dotfiles/decider/tui-dirs"
import path from "node:path"
import { Context, Effect, Layer, Option } from "effect"
import * as CodexSubscription from "@dotfiles/opencode-image/codex/subscription"
import * as FileImages from "@dotfiles/opencode-image/filesystem/files"
import * as FileKey from "@dotfiles/opencode-image/filesystem/key"
import * as FileRequests from "@dotfiles/opencode-image/filesystem/requests"
import { Images, layer as imagesLayer } from "@dotfiles/opencode-image/model"
import * as OpenAiImages from "@dotfiles/opencode-image/openai/images"
import { failureWords, words } from "@dotfiles/opencode-image/outcome"
import { label, route } from "@dotfiles/opencode-image/route"
import { Requests } from "@dotfiles/opencode-image/service"

/** How long one backend request may take: the subscription takes about a minute, the paid API's ten images longer. */
const TIMEOUT_MS = 20 * 60 * 1000

export interface Args {
  readonly file: string
  readonly codexOrigin: string
  readonly codexHome: string
  readonly openaiOrigin: string
}

const valueOf = (args: ReadonlyArray<string>, name: string) => {
  const at = args.indexOf(`--${name}`)
  if (at < 0) return Option.none<string>()
  return Option.fromNullishOr(args[at + 1])
}

/** The runner's arguments, the backends defaulting to the real ones; none without a request file. */
export const argsOf = (args: ReadonlyArray<string>, home: string): Option.Option<Args> =>
  Option.map(Option.filter(Option.fromNullishOr(args[0]), (file) => !file.startsWith("--")), (file) => ({
    file,
    codexOrigin: Option.getOrElse(valueOf(args, "codex-origin"), () => CodexSubscription.ORIGIN),
    codexHome: Option.getOrElse(valueOf(args, "codex-home"), () => home),
    openaiOrigin: Option.getOrElse(valueOf(args, "openai-origin"), () => OpenAiImages.ORIGIN),
  }))

/** The run: the outcome in words, and whether it saved. `openaiKey` is OPENAI_API_KEY's value; `data` the data home the key file is under. */
export const run = (args: Args, openaiKey: Option.Option<string>, data: string) =>
  Effect.gen(function* () {
    const key = FileKey.layer({ env: openaiKey, file: FileKey.keyFile(data) })
    const backends = Layer.mergeAll(
      CodexSubscription.layer({ origin: args.codexOrigin, home: args.codexHome, timeoutMs: TIMEOUT_MS }),
      OpenAiImages.layer({ origin: args.openaiOrigin, timeoutMs: TIMEOUT_MS }).pipe(Layer.provide(key)),
      FileImages.layer,
    )
    const services = yield* Layer.build(Layer.merge(imagesLayer.pipe(Layer.provide(backends)), FileRequests.layer(path.dirname(args.file))))
    const requests = Context.get(services, Requests)
    const images = Context.get(services, Images)
    const request = yield* requests.read(args.file).pipe(Effect.ensuring(requests.remove(args.file)))
    const routeWords = label(route(request))
    return yield* images.generate(request).pipe(
      Effect.map((outcome) => ({ saved: true, text: words(outcome) })),
      Effect.catch((failure) => Effect.succeed({ saved: false, text: failureWords(routeWords, failure) })),
    )
  }).pipe(
    Effect.scoped,
    Effect.catch((failure) => Effect.succeed({ saved: false, text: failureWords("none", failure) })),
  )

if (import.meta.main) {
  const dirs = TuiDirs.dirs()
  const args = argsOf(process.argv.slice(2), dirs.home)
  if (Option.isNone(args)) {
    console.error("usage: bun run.ts <request file> [--codex-origin URL] [--codex-home DIR] [--openai-origin URL]")
    process.exit(2)
  }
  const outcome = await Effect.runPromise(run(args.value, Option.fromNullishOr(process.env.OPENAI_API_KEY), dirs.data))
  console.log(outcome.text)
  process.exit(Number(!outcome.saved))
}
