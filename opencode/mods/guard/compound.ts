// Structural shell syntax for the execution planner. Control words are not
// executable wrappers: they own lists and those lists inherit the compound's input.
import { shellSegments, type Word } from "./shell-line.ts"

export type ShellList = ReadonlyArray<ReadonlyArray<ShellNode>>
export type ShellNode =
  | { readonly kind: "command"; readonly words: ReadonlyArray<Word> }
  | { readonly kind: "group"; readonly body: ShellList; readonly local: boolean }
  | { readonly kind: "function"; readonly name: string; readonly body: ShellNode }
  | { readonly kind: "redirect"; readonly body: ShellNode; readonly input: ReadonlyArray<Word> }
  | { readonly kind: "loop"; readonly id: number; readonly header: ReadonlyArray<Word>; readonly condition: ShellList; readonly body: ShellList }
  | { readonly kind: "choice"; readonly arms: ReadonlyArray<ShellArm> }

export interface ShellArm {
  readonly condition: ShellList
  readonly body: ShellList
}

type Punctuation = "(" | ")" | "|" | ";" | ";;" | "eof"
type Token = { readonly kind: "word"; readonly word: Word } | { readonly kind: Punctuation }
const punctuation = (kind: Punctuation): Token => ({ kind })
const tokensFor = (line: string): ReadonlyArray<Token> => {
  const tokens: Array<Token> = []
  for (const segment of shellSegments(line, true)) {
    for (const word of segment.words) tokens.push({ kind: "word", word })
    if (segment.pipe) tokens.push(punctuation("|"))
    else if (segment.caseEnd) tokens.push(punctuation(";;"))
    else if (segment.boundary === "enter") tokens.push(punctuation("("))
    else if (segment.boundary === "leave") tokens.push(punctuation(")"))
    else if (!segment.joined) tokens.push(punctuation(";"))
  }
  return tokens
}

const textOf = (token: Token): string => {
  if (token.kind !== "word") return token.kind
  if (!token.word.bareStart) return ""
  return token.word.text
}

export const compoundList = (line: string): ShellList => {
  const tokens = tokensFor(line)
  let at = 0
  const peek = (ahead = 0): Token => tokens[at + ahead] || punctuation("eof")
  const is = (text: string): boolean => {
    const token = peek()
    if (text === "eof") return token.kind === "eof"
    return textOf(token) === text
  }
  const take = (): Token => tokens[at++] || punctuation("eof")
  const skip = (text: string): boolean => {
    if (!is(text)) return false
    at += 1
    return true
  }
  const breaks = (): void => {
    while (skip(";")) continue
  }
  const words = (): ReadonlyArray<Word> => {
    const result: Array<Word> = []
    for (let token = peek(); token.kind === "word"; token = peek()) {
      result.push(token.word)
      take()
    }
    return result
  }
  const list = (...stops: ReadonlyArray<string>): ShellList => {
    const result: Array<ReadonlyArray<ShellNode>> = []
    breaks()
    while (!is("eof") && !stops.includes(textOf(peek()))) {
      const stages = [node()]
      while (skip("|")) {
        breaks()
        stages.push(node())
      }
      result.push(stages)
      breaks()
    }
    return result
  }
  const group = (end: string, local: boolean): ShellNode => {
    const body = list(end)
    skip(end)
    return redirect({ kind: "group", body, local })
  }
  const loop = (id: number, keyword: string): ShellNode => {
    const header = loopHeader(keyword)
    const condition = list("do")
    skip("do")
    const body = list("done")
    skip("done")
    return redirect({ kind: "loop", id, header, condition, body })
  }
  const loopHeader = (keyword: string): ReadonlyArray<Word> => {
    if (keyword === "for") return words()
    return []
  }
  const conditional = (): ShellNode => {
    const arms: Array<ShellArm> = []
    do {
      const condition = list("then", "elif", "else", "fi")
      skip("then")
      arms.push({ condition, body: list("elif", "else", "fi") })
    } while (skip("elif"))
    if (skip("else")) arms.push({ condition: [], body: list("fi") })
    skip("fi")
    return redirect({ kind: "choice", arms })
  }
  const pattern = (): ShellNode => {
    const arms: Array<ShellArm> = []
    while (!is("eof") && !skip("in")) take()
    breaks()
    while (!is("eof") && !is("esac")) {
      skip("(")
      while (!is("eof") && !is("esac") && !skip(")")) take()
      arms.push({ condition: [], body: list(";;", "esac") })
      skip(";;")
      breaks()
    }
    skip("esac")
    return redirect({ kind: "choice", arms })
  }
  const redirect = (body: ShellNode): ShellNode => {
    if (!/^</.test(textOf(peek()))) return body
    return { kind: "redirect", body, input: words() }
  }
  const functionNode = (name: string): ShellNode => {
    if (skip("(")) skip(")")
    breaks()
    return { kind: "function", name, body: node() }
  }
  const node = (): ShellNode => {
    const id = at
    const head = textOf(peek())
    if (skip("(")) return group(")", true)
    if (skip("{")) return group("}", false)
    if (skip("if")) return conditional()
    if (skip("case")) return pattern()
    if (skip("for") || skip("while") || skip("until")) return loop(id, head)
    if (skip("function")) return functionNode(textOf(take()))
    if (/^[A-Za-z_]\w*$/.test(head) && peek(1).kind === "(" && peek(2).kind === ")") {
      take()
      return functionNode(head)
    }
    const command = words()
    if (command.length === 0) take()
    return { kind: "command", words: command }
  }
  return list()
}
