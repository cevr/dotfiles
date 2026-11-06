/**
 * Web tools that work, as an OpenCode server plugin. The composition root: it
 * decodes the options, builds the model (`@dotfiles/opencode-web/model`) on
 * HTTP, pdftotext and OpenCode's websearch domain, and hooks it into the two
 * built-in tools through their transforms. Neither tool is replaced.
 *
 * websearch: the built-in tool asks a consent form when no provider is chosen,
 * and in a subagent nobody answers it ("Web search cancelled" after a minute).
 * This registers a provider, `web`, that asks the host's own providers in
 * `order` by id (a query by id never asks the form) and answers with the first
 * that has results, and makes `web` the default unless the config chose one
 * (`websearch` in opencode.json). A default set here outranks a choice saved
 * from an earlier form, so the form never shows. When every provider fails,
 * the tool's failure names each one's error.
 *
 * webfetch: the built-in's execute runs first, untouched. When it fails on a
 * PDF, the PDF is fetched again and answered as its text (pdftotext); on a
 * body over its 5 MB limit, the first `cutKB` is fetched again and answered
 * under a note that says it is cut; on a 404 or 410, it fails with what to do
 * instead of guessing again (`okra repo fetch <owner/repo>` for a GitHub
 * file). Any other failure is the built-in's.
 *
 * Options (all optional; an absent one takes its default, a malformed one stops the plugin):
 * - `order`: the provider ids to ask, in order; default exa, parallel, tavily, firecrawl, tinyfish.
 * - `cutKB`: the most of a body or a PDF's text an answer carries, in KB; default 512.
 * - `pdfMB`: the largest PDF read, in MB; default 50.
 */
import { Plugin, Tool, WebSearch } from "@opencode/plugin/effect"
import { Context, Effect, Layer, Option, Schema } from "effect"
import * as HttpPages from "@dotfiles/opencode-web/http/pages"
import * as Model from "@dotfiles/opencode-web/model"
import * as OpenCodeProviders from "@dotfiles/opencode-web/opencode/providers"
import * as ProcessPdfText from "@dotfiles/opencode-web/process/pdf-text"
import { DEFAULT_ORDER, defaultSelection, SELF } from "@dotfiles/opencode-web/search"
import type { Pages, PdfText, SearchProviders } from "@dotfiles/opencode-web/service"

/**
 * An option that takes `fallback` when absent. A present value must decode.
 * `undefined` counts as absent: a host passing options in-process leaves an
 * unset one undefined, and a JSON config cannot write it.
 */
const withDefault =
  <A>(fallback: A) =>
  <S extends Schema.Codec<A, any, never, never>>(schema: S) =>
    schema.pipe(Schema.withDecodingDefaultType(Effect.succeed(fallback)))

const Positive = Schema.Finite.check(Schema.isGreaterThan(0))

export const Options = Schema.Struct({
  order: Schema.Array(Schema.String).pipe(withDefault<ReadonlyArray<string>>(DEFAULT_ORDER)),
  cutKB: Positive.pipe(withDefault(512)),
  pdfMB: Positive.pipe(withDefault(50)),
})
export type Options = typeof Options.Type

/** The tools this hooks into. */
export const WEBFETCH = "webfetch"
export const WEBSEARCH = "websearch"

/** The built-in webfetch's default timeout, in seconds. */
const DEFAULT_TIMEOUT_SECONDS = 30

/** What this reads of a webfetch call's input; the built-in decoded it already. */
const FetchInput = Schema.Struct({
  url: Schema.String,
  format: Schema.optional(Schema.Literals(["text", "markdown", "html"])),
  timeout: Schema.optional(Schema.Number),
})
const decodeFetchInput = Schema.decodeUnknownOption(FetchInput)

/** The outside systems the model runs on. */
export type Externals = Pages | PdfText | SearchProviders

/** The outside systems as HTTP, pdftotext and OpenCode provide them. */
export const live = (ctx: Plugin.Context): Layer.Layer<Externals> =>
  Layer.mergeAll(
    HttpPages.layer,
    ProcessPdfText.layer(),
    OpenCodeProviders.layer({
      providers: () => ctx.websearch.providers(),
      query: ({ query, providerID }) => ctx.websearch.query({ query, providerID: WebSearch.ID.make(providerID) }),
    }),
  )

const messageOf = (error: unknown): string | undefined =>
  typeof error === "object" && error !== null && "message" in error && typeof error.message === "string" ? error.message : undefined

/** The message under a webfetch failure: the error the built-in wrapped, else its own. */
const failureText = (failure: Tool.Error): string => messageOf(failure.error) || failure.message

/** Our provider's SearchExhausted, when the websearch tool's failure carries it. */
const exhaustedOf = (failure: Tool.Error): string | undefined => {
  const request = failure.error
  if (typeof request !== "object" || request === null || !("_tag" in request) || request._tag !== "WebSearch.Request") return undefined
  if (!("providerID" in request) || request.providerID !== SELF || !("cause" in request)) return undefined
  const cause = request.cause
  if (typeof cause !== "object" || cause === null || !("_tag" in cause) || cause._tag !== "SearchExhausted") return undefined
  return messageOf(cause)
}

/** The plugin on `externals`: the live systems in OpenCode, memory layers in the seam test. */
export const make = (externals: (ctx: Plugin.Context, options: Options) => Layer.Layer<Externals>) =>
  Plugin.define({
    id: "dotfiles-opencode.web",
    effect: Effect.fn("Web.plugin")(function* (ctx) {
      // A malformed option is a mistake in the config: the plugin does not start, and says which.
      const options = yield* Schema.decodeUnknownEffect(Options)(ctx.options).pipe(
        Effect.mapError((error) => new Error(`dotfiles-opencode.web: invalid options: ${error.message}`)),
        Effect.orDie,
      )
      const config: Model.Config = {
        cutBytes: Math.round(options.cutKB * 1024),
        pdfMaxBytes: Math.round(options.pdfMB * 1024 * 1024),
        order: options.order,
      }
      const services = yield* Layer.build(Model.layer(config).pipe(Layer.provide(externals(ctx, options))))
      const web = Context.get(services, Model.Web)

      yield* ctx.websearch.transform((editor) => {
        editor.add({ id: SELF, name: "Web (first provider that answers)", execute: (input) => web.search(input.query) })
        const selection = defaultSelection(editor.default.get())
        if (selection !== undefined) editor.default.set(selection)
      })

      yield* ctx.tool.transform((editor) => {
        editor.update(WEBFETCH, (tool) => {
          const execute = tool.execute
          tool.execute = (input, context) =>
            execute(input, context).pipe(
              Effect.catchTag("Tool.Error", (failure) => {
                const call = decodeFetchInput(input)
                if (Option.isNone(call)) return Effect.fail(failure)
                const { url, format = "markdown", timeout = DEFAULT_TIMEOUT_SECONDS } = call.value
                return web.recover({ url, format, timeoutMs: timeout * 1000 }, failureText(failure)).pipe(
                  Effect.mapError((unfetchable) => new Tool.Error({ message: unfetchable.message })),
                  Effect.flatMap(
                    Option.match({
                      onNone: () => Effect.fail(failure),
                      onSome: (fetched) =>
                        Effect.succeed({
                          output: { url, contentType: fetched.contentType, format, output: fetched.output },
                          content: fetched.output,
                          metadata: { contentType: fetched.contentType, recovered: fetched.recovered },
                        }),
                    }),
                  ),
                )
              }),
            )
        })
        editor.update(WEBSEARCH, (tool) => {
          const execute = tool.execute
          tool.execute = (input, context) =>
            execute(input, context).pipe(
              Effect.catchTag("Tool.Error", (failure) => {
                const reason = exhaustedOf(failure)
                return Effect.fail(reason === undefined ? failure : new Tool.Error({ message: `${failure.message}: ${reason}` }))
              }),
            )
        })
      })
    }),
  })

export default make(live)
