// A shell command line read as its simple commands, each a list of words with
// their quotes removed: enough of the shell to see what runs, ported from
// gent's guard floor (packages/extensions/src/guard.ts). Not a shell:
// `$(...)`, backquotes and a script file are not read; `sh -c` and `eval`
// are read by the verdict (verdict.ts), which hands their text back here.

/** One word of a command, its quotes removed. */
export interface Word {
  readonly text: string
  /** Its first character was outside quotes: a leading `~` names the home. */
  readonly bareStart: boolean
  /** Some of it was in single quotes: no `$` expands in it. */
  readonly singleQuoted: boolean
}

/** A word the reader is building, character by character. */
interface Draft {
  text: string
  started: boolean
  bareStart: boolean
  singleQuoted: boolean
}

const newDraft = (): Draft => ({ text: "", started: false, bareStart: false, singleQuoted: false })

/** The characters that end a simple command outside quotes. */
const SEPARATORS: ReadonlySet<string> = new Set([";", "&", "|", "\n", "(", ")"])

/** The word after `<<` that names a heredoc's end (`EOF`, `-EOF`, `'EOF'`), and how much of the line it takes. */
const heredocEnd = (rest: string): { readonly word: string; readonly length: number } | undefined => {
  const match = /^-?\s*(?:'([^']*)'|"([^"]*)"|([^\s;&|<>()]+))/.exec(rest)
  if (match === null) return undefined
  return { word: match[1] ?? match[2] ?? match[3] ?? "", length: match[0].length }
}

/** Where `char` next appears from `from`: the line's length when it does not. */
const indexOrEnd = (line: string, char: string, from: number) => {
  const next = line.indexOf(char, from)
  return next === -1 ? line.length : next
}

/**
 * A command line as its simple commands, each its words. It splits on `;`,
 * `&`, `|`, `(`, `)` and newlines outside quotes, and leaves a heredoc's body
 * out: the body is data, not a command.
 */
export const simpleCommands = (line: string): ReadonlyArray<ReadonlyArray<Word>> => {
  const commands: Array<Array<Word>> = []
  let words: Array<Word> = []
  let draft = newDraft()
  const heredocs: Array<string> = []
  const endWord = () => {
    if (draft.started) words.push({ text: draft.text, bareStart: draft.bareStart, singleQuoted: draft.singleQuoted })
    draft = newDraft()
  }
  const endCommand = () => {
    endWord()
    if (words.length > 0) commands.push(words)
    words = []
  }
  const add = (char: string, bare: boolean) => {
    if (!draft.started) draft.bareStart = bare
    draft.started = true
    draft.text += char
  }
  /** A single-quoted run: every character as it is, to the closing quote. */
  const readSingle = (from: number) => {
    draft.started = true
    draft.singleQuoted = true
    const stop = indexOrEnd(line, "'", from)
    for (const char of line.slice(from, stop)) add(char, false)
    return stop + 1
  }
  /** A double-quoted run: a backslash keeps the next character. */
  const readDouble = (from: number) => {
    draft.started = true
    let at = from
    while (at < line.length && line.charAt(at) !== '"') {
      if (line.charAt(at) === "\\" && at + 1 < line.length) at += 1
      add(line.charAt(at), false)
      at += 1
    }
    return at + 1
  }
  /** `<<WORD`: the body after the next newline is data, to the line `WORD`. */
  const readHeredoc = (from: number) => {
    endWord()
    const end = heredocEnd(line.slice(from + 2))
    if (end === undefined) return from + 2
    heredocs.push(end.word)
    return from + 2 + end.length
  }
  /** Past each pending body, to the line after its end word. */
  const skipBodies = (from: number) => {
    endCommand()
    let at = from + 1
    for (const word of heredocs) {
      while (at <= line.length) {
        const stop = indexOrEnd(line, "\n", at)
        const body = line.slice(at, stop)
        at = stop + 1
        if (body.replace(/^\t+/, "") === word) break
      }
    }
    heredocs.length = 0
    return at
  }
  const step = (at: number): number => {
    const char = line.charAt(at)
    if (char === "'") return readSingle(at + 1)
    if (char === '"') return readDouble(at + 1)
    if (char === "\\" && at + 1 < line.length) {
      add(line.charAt(at + 1), false)
      return at + 2
    }
    if (line.startsWith("<<", at) && !line.startsWith("<<<", at)) return readHeredoc(at)
    if (char === "\n" && heredocs.length > 0) return skipBodies(at)
    if (SEPARATORS.has(char)) {
      endCommand()
      return at + 1
    }
    if (char === " " || char === "\t") {
      endWord()
      return at + 1
    }
    add(char, true)
    return at + 1
  }
  let at = 0
  while (at < line.length) at = step(at)
  endCommand()
  return commands
}

/** Words that run the command after them: skipped to find what runs. */
const PREFIX_WORDS: ReadonlySet<string> = new Set(["sudo", "doas", "env", "command", "builtin", "exec", "nohup", "time", "nice", "!", "{"])

/** A prefix's options that take the next word as their value. */
const PREFIX_VALUE_OPTIONS: ReadonlySet<string> = new Set(["-u", "-g", "-n", "-C", "-h", "-p"])

const isAssignment = (text: string) => /^[A-Za-z_][A-Za-z0-9_]*=/.test(text)

/** The words of the command that runs: prefixes, their options and assignments skipped. */
export const runningWords = (words: ReadonlyArray<Word>): ReadonlyArray<Word> => {
  let index = 0
  let inPrefix = false
  while (index < words.length) {
    const text = words[index]?.text ?? ""
    if (isAssignment(text) || PREFIX_WORDS.has(text)) {
      inPrefix = inPrefix || PREFIX_WORDS.has(text)
      index += 1
      continue
    }
    if (inPrefix && text.startsWith("-")) {
      index += 1
      if (PREFIX_VALUE_OPTIONS.has(text)) index += 1
      continue
    }
    break
  }
  return words.slice(index).filter((word) => word.text !== "}")
}

/** The letters of a command's short flags, run together (`-rf -x` is `rfx`). */
export const shortFlags = (texts: ReadonlyArray<string>): string => texts.filter((text) => /^-[^-]/.test(text)).join("")

/** A path word as the shell reads it: a bare `~`, `$HOME` and `$PWD` expanded, unless quoted against it. */
export const expandWord = (word: Word, home: string, cwd: string): string => {
  if (word.bareStart && /^~(?=\/|$)/.test(word.text)) return home + word.text.slice(1)
  if (word.singleQuoted) return word.text
  return word.text.replace(/^\$\{?HOME\}?(?=\/|$)/, home).replace(/^\$\{?PWD\}?(?=\/|$)/, cwd)
}
