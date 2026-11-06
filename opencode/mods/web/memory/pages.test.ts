// The in-memory Pages under the Pages laws.
import { Effect } from "effect"
import { BIG_BYTES, pagesLaws, SMALL } from "../laws.ts"
import { layer } from "./pages.ts"

pagesLaws("Pages in memory", () =>
  Effect.succeed({
    layer: layer({
      "mem:/small": { body: SMALL, contentType: "text/plain" },
      "mem:/big": { body: "x".repeat(BIG_BYTES), contentType: "text/plain" },
      "mem:/missing": { status: 404 },
    }),
    url: (path) => `mem:${path}`,
  }),
)
