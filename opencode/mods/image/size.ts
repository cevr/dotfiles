// Sizes: a request's `auto` or `WIDTHxHEIGHT`, the hint the subscription route
// adds to the prompt (its backend takes the size only as a request), and the
// real dimensions read from a PNG, JPEG or WebP file's header. Ported from
// okra's `image.Size`, `SizeHint` and `DimensionsOf`.
import { Option } from "effect"

export interface Dimensions {
  readonly width: number
  readonly height: number
}

const SIZE = /^(\d+)x(\d+)$/u

/** `WIDTHxHEIGHT` as dimensions; `auto` and anything else as none. */
export const parseSize = (size: string): Option.Option<Dimensions> =>
  Option.map(Option.fromNullishOr(SIZE.exec(size)), (match) => ({ width: Number(match[1]), height: Number(match[2]) }))

/** Whether `size` is a size a request may ask for. */
export const validSize = (size: string) => size === "auto" || Option.isSome(Option.filter(parseSize(size), (d) => d.width > 0 && d.height > 0))

export const orientation = (dimensions: Dimensions) => {
  if (dimensions.width > dimensions.height) return "landscape"
  if (dimensions.width < dimensions.height) return "portrait"
  return "square"
}

/** The words the subscription route appends to the prompt for a fixed size; none for `auto`. */
export const sizeHint = (size: string): string =>
  Option.match(parseSize(size), {
    onNone: () => "",
    onSome: (dimensions) => `\n\nOutput size: exactly ${size} pixels (${orientation(dimensions)}).`,
  })

const ascii = (bytes: Uint8Array, at: number, length: number) => String.fromCharCode(...bytes.subarray(at, at + length))

const ordered = (bytes: ReadonlyArray<number>, little: boolean) => {
  if (little) return bytes.toReversed()
  return bytes
}

/** `n` bytes at `at` as one unsigned number, big-endian unless `little`. */
const number = (bytes: Uint8Array, at: number, n: number, little: boolean) =>
  ordered(Array.from(bytes.subarray(at, at + n)), little).reduce((out, byte) => out * 256 + byte, 0)

const dimensions = (width: number, height: number): Option.Option<Dimensions> => Option.some({ width, height })

const png = (bytes: Uint8Array): Option.Option<Dimensions> => {
  if (bytes.length < 24 || ascii(bytes, 1, 3) !== "PNG" || ascii(bytes, 12, 4) !== "IHDR") return Option.none()
  return dimensions(number(bytes, 16, 4, false), number(bytes, 20, 4, false))
}

/** A start-of-frame marker: C0 to CF less DHT (C4), JPG (C8) and DAC (CC), which hold no size. */
const startOfFrame = (marker: number) => marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc

const jpegFrom = (bytes: Uint8Array, at: number): Option.Option<Dimensions> => {
  if (at + 9 > bytes.length || bytes[at] !== 0xff) return Option.none()
  if (startOfFrame(bytes[at + 1] ?? 0)) return dimensions(number(bytes, at + 7, 2, false), number(bytes, at + 5, 2, false))
  return jpegFrom(bytes, at + 2 + number(bytes, at + 2, 2, false))
}

const jpeg = (bytes: Uint8Array): Option.Option<Dimensions> => {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return Option.none()
  return jpegFrom(bytes, 2)
}

const FOURTEEN_BITS = 16384

const webp = (bytes: Uint8Array): Option.Option<Dimensions> => {
  if (bytes.length < 30 || ascii(bytes, 0, 4) !== "RIFF" || ascii(bytes, 8, 4) !== "WEBP") return Option.none()
  const chunk = ascii(bytes, 12, 4)
  if (chunk === "VP8X") return dimensions(1 + number(bytes, 24, 3, true), 1 + number(bytes, 27, 3, true))
  if (chunk === "VP8L") {
    const packed = number(bytes, 21, 4, true)
    return dimensions(1 + (packed % FOURTEEN_BITS), 1 + (Math.floor(packed / FOURTEEN_BITS) % FOURTEEN_BITS))
  }
  if (chunk === "VP8 ") return dimensions(number(bytes, 26, 2, true) % FOURTEEN_BITS, number(bytes, 28, 2, true) % FOURTEEN_BITS)
  return Option.none()
}

/** The dimensions a PNG, JPEG or WebP file's header states; none for anything else. */
export const dimensionsOf = (bytes: Uint8Array): Option.Option<Dimensions> =>
  Option.orElse(png(bytes), () => Option.orElse(jpeg(bytes), () => webp(bytes)))

/** The note an outcome carries when the subscription backend returned another size than the one asked. */
export const sizeNote = (size: string, actual: Option.Option<Dimensions>): Option.Option<string> =>
  Option.flatMap(Option.all([parseSize(size), actual]), ([asked, got]) => {
    if (asked.width === got.width && asked.height === got.height) return Option.none()
    return Option.some(
      `Note: the subscription backend returned ${got.width}x${got.height} for ${size}; it chooses the final size. The paid route gives an exact size.`,
    )
  })
