// A cell's output kept within bounds: its head and its tail, cut between code
// points, around a notice of what was left out. The worker bounds what a cell
// shows; the host bounds what the model reads (`viewOf`). This file imports
// nothing, so the worker loads it without Effect.

const splitsPairAt = (text: string, index: number): boolean => {
  const before = text.charCodeAt(index - 1)
  const after = text.charCodeAt(index)
  return before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff
}

/** The head of `text`, at most `max` UTF-16 units, cut between code points. */
export const cutHead = (text: string, max: number): string => {
  if (text.length <= max) return text
  const end = Math.max(0, max)
  return text.slice(0, end - Number(splitsPairAt(text, end)))
}

/** The tail of `text`, at most `max` UTF-16 units, cut between code points. */
export const cutTail = (text: string, max: number): string => {
  if (text.length <= max) return text
  const start = text.length - Math.max(0, max)
  return text.slice(start + Number(splitsPairAt(text, start)))
}

/** The notice that stands for the characters a cut dropped. */
export const omittedNotice = (count: number) => `\n... [${count} characters omitted] ...\n`

/**
 * Keeps the first `headLimit` characters and the last `limit - headLimit`, so the
 * end of a long output (usually the error) survives with its beginning.
 * `separator` goes between appends once anything is written.
 */
export const makeBoundedOutput = (options: { readonly limit: number; readonly headLimit: number; readonly separator?: string }) => {
  const separator = options.separator ?? ""
  const tailLimit = Math.max(0, options.limit - options.headLimit)
  let head = ""
  let tail = ""
  let omitted = 0
  return {
    append: (text: string): void => {
      const next = (head.length > 0 || tail.length > 0 ? separator : "") + text
      // The head takes text only while nothing has passed it.
      const added = tail.length === 0 && omitted === 0 ? cutHead(next, options.headLimit - head.length) : ""
      head += added
      if (added.length === next.length) return
      tail += next.slice(added.length)
      if (tail.length > tailLimit) {
        const kept = cutTail(tail, tailLimit)
        omitted += tail.length - kept.length
        tail = kept
      }
    },
    read: (): string => (omitted === 0 ? head + tail : `${head}${omittedNotice(omitted)}${tail}`),
    truncated: () => omitted > 0,
    reset: (): void => {
      head = ""
      tail = ""
      omitted = 0
    },
  }
}

/** `text` in at most about `chars` characters: its head and tail around an omission notice. */
export const viewOf = (text: string, chars: number): string => {
  if (text.length <= chars) return text
  const head = cutHead(text, Math.ceil(chars / 2))
  const tail = cutTail(text, Math.floor(chars / 2))
  return `${head}${omittedNotice(text.length - head.length - tail.length)}${tail}`
}
