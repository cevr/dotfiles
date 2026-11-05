// The images a cell attaches with `attach(...paths)`, so the model sees them.
// The worker records only each path (frame.ts, `attached`), resolved against
// the session's working directory; after the cell the handler reads each file
// through `Files` (service.ts), checks it is an image by its first bytes, and
// the call's reply carries the images after its text. A path that cannot be
// attached is a line in that text, never a failed call.
import { Schema } from "effect"
import type { Answer } from "./answer.ts"

/** The largest file `attach` takes, in bytes, as Prime Agent's attach_image does. The host resizes what it takes. */
export const MAX_IMAGE_BYTES = 20_000_000

/** The image types a model reads, as Prime Agent's attach_image sniffs them. */
export const ImageMime = Schema.Literals(["image/png", "image/jpeg", "image/gif", "image/webp"])
export type ImageMime = typeof ImageMime.Type

const startsWith = (bytes: Uint8Array, prefix: ReadonlyArray<number>, at = 0) =>
  bytes.byteLength >= at + prefix.length && prefix.every((byte, index) => bytes[at + index] === byte)

const ascii = (text: string) => [...text].map((char) => char.charCodeAt(0))

const SIGNATURES: ReadonlyArray<readonly [ImageMime, ReadonlyArray<number>]> = [
  ["image/png", [0x89, ...ascii("PNG\r\n\x1a\n")]],
  ["image/jpeg", [0xff, 0xd8, 0xff]],
  ["image/gif", ascii("GIF87a")],
  ["image/gif", ascii("GIF89a")],
]

/** The image type a file's first bytes name, if they name one: PNG, JPEG, GIF or WebP (RIFF….WEBP). */
export const sniff = (head: Uint8Array): ImageMime | undefined => {
  for (const [mime, prefix] of SIGNATURES) if (startsWith(head, prefix)) return mime
  return startsWith(head, ascii("RIFF")) && startsWith(head, ascii("WEBP"), 8) ? "image/webp" : undefined
}

/** One attached image: the path the cell named (absolute), its type, and its bytes. */
export interface Image {
  readonly path: string
  readonly mime: ImageMime
  readonly bytes: Uint8Array
}

// ── Why a path was not attached ──

/** There is no regular file at the path, or it cannot be read; `reason` says which. */
export class FileUnreadable extends Schema.TaggedError<FileUnreadable>()("FileUnreadable", {
  path: Schema.String,
  reason: Schema.String,
}) {}

/** The file is over the limit, in bytes. */
export class FileTooLarge extends Schema.TaggedError<FileTooLarge>()("FileTooLarge", {
  path: Schema.String,
  bytes: Schema.Number,
  limit: Schema.Number,
}) {}

/** The file's first bytes are not a PNG, JPEG, GIF or WebP signature. */
export class NotAnImage extends Schema.TaggedError<NotAnImage>()("NotAnImage", { path: Schema.String }) {}

export type Refusal = FileUnreadable | FileTooLarge | NotAnImage

/** The file's bytes as an image, when their first bytes say they are one. */
export const imageOf = (path: string, bytes: Uint8Array): Image | NotAnImage => {
  const mime = sniff(bytes.subarray(0, 16))
  return mime === undefined ? new NotAnImage({ path }) : { path, mime, bytes }
}

const megabytes = (bytes: number) => `${(bytes / 1_000_000).toFixed(1).replace(/\.0$/, "")} MB`

/** The line the model reads for a path that was not attached. */
export const refusalLine = (refusal: Refusal): string => {
  switch (refusal._tag) {
    case "FileUnreadable":
      return `[not attached: ${refusal.path}: ${refusal.reason}]`
    case "FileTooLarge":
      return `[not attached: ${refusal.path}: ${megabytes(refusal.bytes)}, over the ${megabytes(refusal.limit)} limit]`
    case "NotAnImage":
      return `[not attached: ${refusal.path}: not a PNG, JPEG, GIF or WebP image]`
  }
}

/** One call's reply: the answer's text with a line for each path not attached, then the images. */
export interface Reply {
  readonly ok: boolean
  readonly text: string
  readonly images: ReadonlyArray<Image>
}

/** The answer with what became of each attached path, in the order the cell attached them. */
export const replyOf = (answer: Answer, attached: ReadonlyArray<Image | Refusal>): Reply => {
  const images = attached.filter((item): item is Image => !("_tag" in item))
  const refused = attached.flatMap((item) => ("_tag" in item ? [refusalLine(item)] : []))
  return { ok: answer.ok, text: [answer.text, ...refused].join("\n"), images }
}
