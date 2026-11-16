// Mermaid diagrams drawn by Pele (obsidianmd/pele: Mermaid to SVG, no
// browser needed to lay it out), put on a page of their own in this host's
// temporary folder for the headless browser to shoot: light lines on the
// pane's dark ground, as wide as the view asks. A page is named by its
// source and width, so drawing one again writes nothing new.
import { createHash } from "node:crypto"
import { mkdir, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Layer, Option, Predicate, Result } from "effect"
import { render } from "pele"
import { DiagramFailed, Diagrams } from "../service.ts"

/** The pane's colours, as Pele's CSS variables. */
const THEME = [
  "--pele-bg:#16161a",
  "--pele-fg:#e8e8ec",
  "--pele-muted:#a0a0aa",
  "--pele-line:#c9c9d1",
  "--pele-surface:#26262d",
  "--pele-surface-alt:#30303a",
  "--pele-border:#70707c",
  "--pele-accent:#86a1f7",
  "--pele-font:-apple-system,BlinkMacSystemFont,Helvetica,Arial,sans-serif",
].join(";")

/** The blank around a diagram, in pixels. */
const MARGIN = 16

/** The page holding `svg`, drawn `width` pixels wide. */
export const pageHtml = (svg: string, width: number): string =>
  `<!doctype html><meta charset="utf-8"><style>html,body{margin:0;background:#16161a}body{padding:${MARGIN}px;${THEME}}svg{display:block;width:${width}px;max-width:none!important;height:auto!important}</style><body>${svg}</body>`

const failed = (cause: unknown) => new DiagramFailed({ message: `Mermaid: ${Option.getOrElse(Option.map(Option.liftPredicate(cause, Predicate.isError), (error) => error.message), () => String(cause))}` })

/** Diagrams drawn by Pele, their pages under `folder` (this host's temporary folder by default). */
export const layer = (folder: string = join(tmpdir(), "rex-show-diagrams")) =>
  Layer.succeed(
    Diagrams,
    Diagrams.of({
      page: Effect.fn("ProcessDiagrams.page")(function* (source: string, width: number) {
        const drawn = yield* Result.match(Result.try({ try: () => render(source), catch: failed }), { onFailure: Effect.fail, onSuccess: Effect.succeed })
        const inner = Math.max(100, width - 2 * MARGIN)
        const height = Math.ceil((drawn.height * inner) / Math.max(1, drawn.width)) + 2 * MARGIN
        const file = join(folder, `${createHash("sha1").update(`${inner}:${source}`).digest("hex").slice(0, 16)}.html`)
        yield* Effect.tryPromise({ try: () => mkdir(folder, { recursive: true }).then(() => writeFile(file, pageHtml(drawn.svg, inner))), catch: failed })
        return { url: `file://${file}`, width: inner + 2 * MARGIN, height }
      }),
    }),
  )
