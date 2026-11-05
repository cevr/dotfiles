// Bounds on untrusted text: well-formed UTF-16 and its UTF-8 size.

const encoder = new TextEncoder()

/** Whether `value` has no lone surrogate (so it encodes to UTF-8 unchanged). */
export function isWellFormedUtf16(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index)
    if (unit >= 0xd800 && unit <= 0xdbff) {
      if (index + 1 >= value.length) return false
      const next = value.charCodeAt(index + 1)
      if (next < 0xdc00 || next > 0xdfff) return false
      index += 1
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return false
    }
  }
  return true
}

/** The UTF-8 size of `value`, in bytes. */
export function utf8Length(value: string): number {
  return encoder.encode(value).byteLength
}

/** Whether `value` is non-empty, well-formed and at most `maxBytes` of UTF-8. */
export function isBoundedUtf8(value: string, maxBytes: number): boolean {
  if (value.length === 0 || value.length > maxBytes || !isWellFormedUtf16(value)) {
    return false
  }
  return utf8Length(value) <= maxBytes
}
