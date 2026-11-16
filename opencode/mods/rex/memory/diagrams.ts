// Mermaid diagrams in memory, for the viewer's tests: a diagram's page is
// `diagram:` and its source, so the test sets that page's shot in the
// memory browser; a source starting with `bad` does not parse.
import { Effect, Layer, Option } from "effect"
import { DiagramFailed, Diagrams } from "../service.ts"

/** The address of the page `source` is drawn on. */
export const pageOf = (source: string) => `diagram:${source}`

export const layer = Layer.succeed(
  Diagrams,
  Diagrams.of({
    page: (source, width) =>
      Option.match(Option.liftPredicate(source, (text) => text.startsWith("bad")), {
        onNone: () => Effect.succeed({ url: pageOf(source), width, height: Math.round(width / 2) }),
        onSome: () => Effect.fail(new DiagramFailed({ message: "Mermaid: no diagram type in the first line" })),
      }),
  }),
)
