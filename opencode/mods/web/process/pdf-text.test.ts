// PdfText through the real pdftotext, under the PdfText laws, and a machine
// without it. Skips the laws, saying so, where pdftotext is not installed.
import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { pdfTextLaws } from "../laws.ts"
import { PdfText } from "../service.ts"
import { layer } from "./pdf-text.ts"
import { samplePdf } from "./sample-pdf.ts"

if (Bun.which("pdftotext") === null) console.warn("mods/web/process/pdf-text.test.ts: pdftotext is not installed, so its laws skip.")
else pdfTextLaws("PdfText through pdftotext", { layer: layer(), pdf: samplePdf })

describe("PdfText through pdftotext", () => {
  test("with no pdftotext on the machine it fails naming what to install", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const error = yield* Effect.flip((yield* PdfText).extract(samplePdf("anything")))
        expect(error.message).toBe("pdftotext is not installed on this machine (brew install poppler, or apt install poppler-utils)")
      }).pipe(Effect.provide(layer({ program: "/nonexistent/loop-probe-x/pdftotext" }))),
    ))
})
