// PdfText in memory: a "PDF" is the bytes of `%PDF-` followed by its text,
// which comes back as is; anything else is unreadable.
import { Effect, Layer } from "effect"
import { PdfText, PdfUnreadable } from "../service.ts"

/** A stand-in PDF whose text is `text`. */
export const pdf = (text: string): Uint8Array => new TextEncoder().encode(`%PDF-${text}`)

export const layer = Layer.succeed(
  PdfText,
  PdfText.of({
    extract: (bytes) => {
      const text = new TextDecoder().decode(bytes)
      return text.startsWith("%PDF-") ? Effect.succeed(text.slice(5)) : Effect.fail(new PdfUnreadable({ message: "Syntax Error: Couldn't find trailer dictionary" }))
    },
  }),
)
