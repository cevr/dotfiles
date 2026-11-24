import { Array as Arr, Option } from "effect"
import type { HarnessAdapter, NeedsInput, StartOptions } from "./adapter.ts"

const RULE_LINE = /^─{20,}$/
const ESC_TO_CANCEL = /\besc to cancel\b/i
const SHORTCUTS_FOOTER = /\?\s+for shortcuts\b/i
const GENERATING = /Generating\.{3}|Thinking\.{3}/i
const PROMPT_LINE = /^>\s*(.*)$/

const NEEDS_INPUT_PATTERNS: ReadonlyArray<{ readonly pattern: RegExp; readonly summary: string }> = [
  { pattern: /Do you trust the contents of this project\?/i, summary: "Workspace trust confirmation required" },
  { pattern: /Select login method/i, summary: "Sign-in method selection required" },
  { pattern: /Authentication required/i, summary: "Authentication required" },
  { pattern: /Command permission required/i, summary: "Command permission confirmation required" },
  { pattern: /↑\/↓\s*Navigate\s*·\s*enter\s*Confirm/i, summary: "Interactive confirmation required" },
  { pattern: /\b(Allow once|Allow always|Approve)\b.*\n.*\bDeny\b/is, summary: "Permission confirmation required" },
  { pattern: /\[y\/N\]|\(y\/n\)|Press y to/i, summary: "Confirmation prompt waiting for answer" },
]

const TAIL_LINES = 12

const nonEmptyLines = (screen: string): ReadonlyArray<string> =>
  screen.split("\n").map((line) => line.trimEnd())

const lastLines = (screen: string, count: number): string =>
  nonEmptyLines(screen)
    .filter((line) => line.trim().length > 0)
    .slice(-count)
    .join("\n")

const ruleIndices = (lines: ReadonlyArray<string>): ReadonlyArray<number> => {
  const out: Array<number> = []
  for (let index = 0; index < lines.length; index++) {
    const line = Arr.get(lines, index)
    if (Option.isSome(line) && RULE_LINE.test(line.value.trim())) {
      out.push(index)
    }
  }
  return out
}

const lastTwoRules = (lines: ReadonlyArray<string>): Option.Option<readonly [number, number]> => {
  const rules = ruleIndices(lines)
  if (rules.length < 2) return Option.none()
  const top = Arr.get(rules, rules.length - 2)
  const bottom = Arr.get(rules, rules.length - 1)
  return Option.all([top, bottom])
}

const hasInputBox = (lines: ReadonlyArray<string>): boolean =>
  Option.match(lastTwoRules(lines), {
    onNone: () => false,
    onSome: ([top, bottom]) => {
      if (bottom - top < 2) return false
      return lines.slice(top + 1, bottom).some((line) => PROMPT_LINE.test(line.trim()))
    },
  })

const detectNeedsInput = (screen: string): Option.Option<NeedsInput> => {
  const matched = Arr.findFirst(NEEDS_INPUT_PATTERNS, ({ pattern }) => pattern.test(screen))
  return Option.map(matched, ({ summary }) => ({ summary, tail: lastLines(screen, TAIL_LINES) }))
}

const isReadyForInput = (screen: string): boolean => {
  if (screen.trim().length === 0) return false
  if (ESC_TO_CANCEL.test(screen)) return false
  if (Option.isSome(detectNeedsInput(screen))) return false
  return hasInputBox(nonEmptyLines(screen))
}

const isTurnEnded = (screen: string): boolean => {
  if (!isReadyForInput(screen)) return false
  if (GENERATING.test(screen)) return false
  if (SHORTCUTS_FOOTER.test(screen)) return true
  const lines = nonEmptyLines(screen)
  return Option.match(lastTwoRules(lines), {
    onNone: () => false,
    onSome: ([top, bottom]) =>
      lines
        .slice(top + 1, bottom)
        .map((line) => line.trim())
        .every((line) => line === ">" || line.length === 0),
  })
}

const readAnswer = (screen: string): string => {
  const lines = nonEmptyLines(screen)
  return Option.match(lastTwoRules(lines), {
    onNone: () => lastLines(screen, TAIL_LINES),
    onSome: ([boxTop]) => {
      const beforeBox = lines.slice(0, boxTop)
      const lastPromptIndex = Arr.findLastIndex(beforeBox, (line) => PROMPT_LINE.test(line.trim()))
      const body = Option.match(lastPromptIndex, {
        onNone: () => beforeBox,
        onSome: (index) => beforeBox.slice(index + 1),
      })
      const cleaned: Array<string> = []
      for (const raw of body) {
        const trimmed = raw.trim()
        if (trimmed.length > 0 && !RULE_LINE.test(trimmed)) {
          cleaned.push(trimmed)
        }
      }
      return cleaned.join("\n")
    },
  })
}

const commandFor = (options: StartOptions): ReadonlyArray<string> => {
  const bin = Option.getOrElse(Option.fromUndefinedOr(options.binary), () => "agy")
  if (options.dangerousSkipPermissions === true) return [bin, "--dangerously-skip-permissions"]
  return [bin]
}

/** Antigravity CLI (`agy`) interactive pane adapter. */
export const agyAdapter: HarnessAdapter = {
  harness: "agy",
  command: commandFor,
  readyForInput: isReadyForInput,
  formatSubmit: (text) => [`\x1b[200~${text}\x1b[201~`, "\r"],
  turnEnded: isTurnEnded,
  needsInput: detectNeedsInput,
  interruptSequence: "\x1b",
  readLastAnswer: readAnswer,
}
