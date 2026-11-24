// A shell command line read as its simple commands, each a list of words with
// their quotes removed: enough of the shell to see what runs. Not a shell:
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
export interface ShellSegment {
  readonly words: ReadonlyArray<Word>
  readonly pipe: boolean
  readonly boundary?: "enter" | "leave"
}

export const shellSegments = (line: string, bindingSyntax = false): ReadonlyArray<ShellSegment> => {
  const commands: Array<ShellSegment> = []
  let words: Array<Word> = []
  let draft = newDraft()
  const heredocs: Array<string> = []
  const endWord = () => {
    if (draft.started) words.push({ text: draft.text, bareStart: draft.bareStart, singleQuoted: draft.singleQuoted })
    draft = newDraft()
  }
  const endCommand = (pipe = false) => {
    endWord()
    if (words.length > 0 || pipe) commands.push({ words, pipe })
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
      const next = nextCharacter(at)
      add(line.slice(at, next), false)
      at = next
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
    if (char === "#" && !draft.started) return indexOrEnd(line, "\n", at)
    const end = nextCharacter(at)
    if (end > at + 1) {
      add(line.slice(at, end), true)
      return end
    }
    if (hasInputRedirection(at)) return inputRedirection(at)
    if (char === "\n" && heredocs.length > 0) return skipBodies(at)
    if (SEPARATORS.has(char)) return separator(at, char)
    if (char === " " || char === "\t") {
      endWord()
      return at + 1
    }
    add(char, true)
    return at + 1
  }
  const separator = (at: number, char: string): number => {
    const or = char === "|" && line.charAt(at + 1) === "|"
    endCommand(char === "|" && !or)
    if (char === "(") commands.push({ words: [], pipe: false, boundary: "enter" })
    if (char === ")") commands.push({ words: [], pipe: false, boundary: "leave" })
    return at + 1 + Number(or)
  }
  const hasInputRedirection = (at: number): boolean =>
    line.startsWith("<<", at) && (bindingSyntax || !line.startsWith("<<<", at))
  const nextCharacter = (at: number): number => {
    if (!bindingSyntax) return at + 1
    if (line.startsWith("$(", at)) return substitutionEnd(line, at + 2)
    if (line.charAt(at) === "`") return backquoteEnd(line, at + 1)
    return at + 1
  }
  const inputRedirection = (at: number): number => {
    if (!line.startsWith("<<<", at)) return readHeredoc(at)
    endWord()
    add("<<<", true)
    endWord()
    return at + 3
  }
  let at = 0
  while (at < line.length) at = step(at)
  endCommand()
  return commands
}

/** Keep an unwalked substitution in its operand rather than treating its body as sibling commands. */
export const substitutionEnd = (line: string, start: number): number => {
  let nesting = 1
  let quote = ""
  for (let at = start; at < line.length; at += 1) {
    const char = line.charAt(at)
    if (char === "\\") at += 1
    else if (quote !== "") {
      if (char === quote) quote = ""
    } else if (char === "'" || char === '"') quote = char
    else if (char === "(") nesting += 1
    else if (char === ")" && --nesting === 0) return at + 1
  }
  return line.length
}

export const backquoteEnd = (line: string, start: number): number => {
  for (let at = start; at < line.length; at += 1) {
    if (line.charAt(at) === "\\") at += 1
    else if (line.charAt(at) === "`") return at + 1
  }
  return line.length
}

export const simpleCommands = (line: string): ReadonlyArray<ReadonlyArray<Word>> => shellSegments(line).flatMap(({ words }) => {
  if (words.length === 0) return []
  return [words]
})

/** Words that run the command after them: skipped to find what runs. */
const PREFIX_WORDS: ReadonlySet<string> = new Set(["sudo", "doas", "env", "command", "builtin", "exec", "nohup", "time", "nice", "!", "{"])

/** A prefix's options that take the next word as their value. */
const PREFIX_VALUE_OPTIONS: ReadonlySet<string> = new Set(["-u", "-g", "-n", "-C", "-h", "-p"])

const isAssignment = (text: string) => /^[A-Za-z_][A-Za-z0-9_]*=/.test(text)

/** Reserved words that introduce a command within a shell compound command. */
export const COMMAND_STARTS: ReadonlySet<string> = new Set(["do", "then", "elif", "else", "if", "while", "until"])

/** `command -v` and `command -V` describe an executable without invoking it. */
const describesCommand = (words: ReadonlyArray<Word>): boolean => {
  for (const { text } of words) {
    if (!/^-[^-]/.test(text)) return false
    if (/[vV]/.test(text)) return true
  }
  return false
}

/** The words of the command that runs: prefixes, their options and assignments skipped. */
export const runningWords = (words: ReadonlyArray<Word>): ReadonlyArray<Word> => {
  let index = 0
  for (const word of words) {
    if (!word.bareStart || !COMMAND_STARTS.has(word.text)) break
    index += 1
  }
  let inPrefix = false
  while (index < words.length) {
    const text = words[index]?.text ?? ""
    if (text === "command" && describesCommand(words.slice(index + 1))) break
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

/** Shells whose `-c` script is a command line of its own. */
export const SHELLS: ReadonlySet<string> = new Set(["sh", "bash", "zsh", "dash", "ksh"])

interface ShellSwitches {
  readonly command: boolean
  readonly stdin: boolean
  readonly noexec: boolean
  readonly interactive: boolean
}

export interface ShellInput {
  readonly command: boolean
  readonly stdin: boolean
  readonly noexec: boolean
  readonly operands: ReadonlyArray<Word>
}

/** A short flag cluster, with a trailing `o`/`O` taking a shell option name. */
const shellSwitches = (text: string, after: ReadonlyArray<Word>, state: ShellSwitches) => {
  const enabled = text.startsWith("-")
  const tail = text.slice(1)
  const letters = tail.split(/[oO]/, 1)[0] ?? ""
  const operator = tail.charAt(letters.length)
  const inline = tail.slice(letters.length + 1)
  const name = inline || (after[0]?.text ?? "")
  const named = operator !== "" && /^[^+-]/.test(name)
  const consumed = Number(named && inline === "")
  return {
    state: {
      command: updatedSwitch(letters.includes("c"), enabled, state.command),
      stdin: updatedSwitch(letters.includes("s"), enabled, state.stdin),
      noexec: updatedSwitch(letters.includes("n") || (operator === "o" && name === "noexec"), enabled, state.noexec),
      interactive: updatedSwitch(letters.includes("i"), enabled, state.interactive),
    },
    consumed,
  }
}

const updatedSwitch = (mentioned: boolean, enabled: boolean, before: boolean): boolean => (mentioned && enabled) || (!mentioned && before)

/** The shell's options stop at the script or `--`; the script's own arguments do not change its invocation. */
export const shellInput = (args: ReadonlyArray<Word>): ShellInput => {
  let state = { command: false, stdin: false, noexec: false, interactive: false }
  let index = 0
  for (const [position, word] of args.entries()) {
    if (position < index) continue
    const text = word.text
    index += 1
    if (text === "--" || text === "-") break
    if (/^[-+][^-]/.test(text)) {
      const parsed = shellSwitches(text, args.slice(index), state)
      state = parsed.state
      index += parsed.consumed
      continue
    }
    if (text.startsWith("--")) {
      if (text === "--rcfile" || text === "--init-file") index += 1
      continue
    }
    index -= 1
    break
  }
  return { command: state.command, stdin: state.stdin, noexec: state.noexec && !state.interactive, operands: args.slice(index) }
}

/** The script a shell executes with `-c`, but not code it only syntax-checks with `-n`. */
export const shellScript = (args: ReadonlyArray<Word>): string | undefined => {
  const input = shellInput(args)
  if (input.command && !input.noexec) return input.operands[0]?.text
  return undefined
}

/** The letters of a command's short flags, run together (`-rf -x` is `rfx`). */
export const shortFlags = (texts: ReadonlyArray<string>): string => texts.filter((text) => /^-[^-]/.test(text)).join("")

/** A path word as the shell reads it: a bare `~`, `$HOME` and `$PWD` expanded, unless quoted against it. */
export const expandWord = (word: Word, home: string, cwd: string): string => {
  if (word.bareStart && /^~(?=\/|$)/.test(word.text)) return home + word.text.slice(1)
  if (word.singleQuoted) return word.text
  return word.text.replace(/^\$\{?HOME\}?(?=\/|$)/, home).replace(/^\$\{?PWD\}?(?=\/|$)/, cwd)
}
