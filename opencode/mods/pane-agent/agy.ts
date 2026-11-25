import { Array as Arr, Option } from "effect"
import type { HarnessAdapter, NeedsInput, ResumeOptions, StartOptions, UsageLimit } from "./adapter.ts"

const RULE_LINE = /^─{20,}$/
const ESC_TO_CANCEL = /\besc to cancel\b/i
const SHORTCUTS_FOOTER = /\?\s+for shortcuts\b/i
const GENERATING = /Generating\.{3}|Thinking\.{3}/i
const PROMPT_LINE = /^>\s*(.*)$/
const QUOTA_REACHED = /Individual quota reached/i
const RESETS_IN = /Resets in\s+((?:\d+h)?(?:\d+m)?(?:\d+(?:\.\d+)?s)?)/i
const ESC_CODE = "\x1b"

const NEEDS_INPUT_PATTERNS: ReadonlyArray<{ readonly pattern: RegExp; readonly summary: string }> = [
  { pattern: /Do you trust the contents of this project\?/i, summary: "Workspace trust confirmation required" },
  { pattern: /Select login method/i, summary: "Sign-in method selection required" },
  { pattern: /Authentication required/i, summary: "Authentication required" },
  { pattern: /Command permission required/i, summary: "Command permission confirmation required" },
  { pattern: /↑\/↓\s*Navigate\s*·\s*enter\s*Confirm/i, summary: "Interactive confirmation required" },
  { pattern: /\b(Allow once|Allow always|Approve)\b.*\n.*\bDeny\b/is, summary: "Permission confirmation required" },
  { pattern: /\[y\/N\]|\(y\/n\)|Press y to/i, summary: "Confirmation prompt waiting for answer" },
]

const TAIL_LINES = 14

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

/**
 * Inspect only the active bottom region so scrollback text mentioning `(y/n)` or `Approve`/`Deny`
 * above an active input box does not falsely trigger `needs_input`.
 */
const activePromptRegion = (screen: string): string => {
  const lines = nonEmptyLines(screen)
  const rules = lastTwoRules(lines)
  if (Option.isSome(rules) && hasInputBox(lines)) {
    const [, bottom] = rules.value
    const footer = lines.slice(bottom + 1).join("\n")
    if (SHORTCUTS_FOOTER.test(footer) || ESC_TO_CANCEL.test(footer)) {
      return footer
    }
  }
  return lastLines(screen, TAIL_LINES)
}

const parseGoDurationMs = (raw: string): number => {
  const hours = Option.fromNullishOr(/(\d+)h/i.exec(raw)).pipe(
    Option.flatMap((m) => Option.fromUndefinedOr(m[1])),
    Option.map(Number),
    Option.getOrElse(() => 0),
  )
  const mins = Option.fromNullishOr(/(\d+)m/i.exec(raw)).pipe(
    Option.flatMap((m) => Option.fromUndefinedOr(m[1])),
    Option.map(Number),
    Option.getOrElse(() => 0),
  )
  const secs = Option.fromNullishOr(/(\d+(?:\.\d+)?)s/i.exec(raw)).pipe(
    Option.flatMap((m) => Option.fromUndefinedOr(m[1])),
    Option.map(Number),
    Option.getOrElse(() => 0),
  )
  return Math.round((hours * 3600 + mins * 60 + secs) * 1000)
}

const activeOutputRegion = (screen: string): ReadonlyArray<string> => {
  const lines = nonEmptyLines(screen)
  return Option.match(lastTwoRules(lines), {
    onNone: () => lines.filter((line) => line.trim().length > 0).slice(-TAIL_LINES),
    onSome: ([boxTop]) => {
      const beforeBox = lines.slice(0, boxTop)
      const lastPromptIndex = Arr.findLastIndex(beforeBox, (line) => PROMPT_LINE.test(line.trim()))
      const body = Option.match(lastPromptIndex, {
        onNone: () => beforeBox,
        onSome: (index) => beforeBox.slice(index + 1),
      })
      return body.filter((line) => line.trim().length > 0)
    },
  })
}

const detectUsageLimit = (screen: string, now: number): Option.Option<UsageLimit> => {
  if (ESC_TO_CANCEL.test(screen)) return Option.none()
  const region = activeOutputRegion(screen)
  const matched = Arr.findFirst(region, (line) => QUOTA_REACHED.test(line))
  if (Option.isNone(matched)) return Option.none()
  const joined = region.join(" ")
  const resetInMs = Option.fromNullishOr(RESETS_IN.exec(joined)).pipe(
    Option.flatMap((m) => Option.fromUndefinedOr(m[1])),
    Option.filter((raw) => raw.length > 0),
    Option.map(parseGoDurationMs),
    Option.getOrElse(() => 0),
  )
  return Option.some({
    resetAt: now + resetInMs,
    resetInMs,
    summary: matched.value.trim(),
  })
}

const detectNeedsInput = (screen: string): Option.Option<NeedsInput> => {
  const region = activePromptRegion(screen)
  const matched = Arr.findFirst(NEEDS_INPUT_PATTERNS, ({ pattern }) => pattern.test(region))
  return Option.map(matched, ({ summary }) => ({ summary, tail: lastLines(screen, TAIL_LINES) }))
}

const isReadyForInput = (screen: string): boolean => {
  if (screen.trim().length === 0) return false
  if (ESC_TO_CANCEL.test(screen)) return false
  if (Option.isSome(detectNeedsInput(screen))) return false
  if (Option.isSome(detectUsageLimit(screen, 0))) return false
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

const readPrompt = (screen: string): Option.Option<string> => {
  const lines = nonEmptyLines(screen)
  return Option.flatMap(lastTwoRules(lines), ([boxTop]) => {
    const beforeBox = lines.slice(0, boxTop)
    const lastPromptIndex = Arr.findLastIndex(beforeBox, (line) => PROMPT_LINE.test(line.trim()))
    return Option.flatMap(lastPromptIndex, (index) =>
      Option.flatMap(Arr.get(beforeBox, index), (line) =>
        Option.fromNullishOr(PROMPT_LINE.exec(line.trim())).pipe(
          Option.flatMap((m) => Option.fromUndefinedOr(m[1])),
          Option.map((text) => text.trim()),
          Option.filter((text) => text.length > 0),
        ),
      ),
    )
  })
}

const addDirFlags = (addDirs?: ReadonlyArray<string>): ReadonlyArray<string> => {
  const dirs = Option.fromUndefinedOr(addDirs)
  if (Option.isNone(dirs)) return []
  const seen = new Set<string>()
  const out: Array<string> = []
  for (const raw of dirs.value) {
    const trimmed = raw.trim()
    if (trimmed.length === 0 || seen.has(trimmed)) continue
    seen.add(trimmed)
    out.push("--add-dir", trimmed)
  }
  return out
}

const sanitizePaste = (text: string): string => text.split(ESC_CODE).join("")

const commandFor = (options: StartOptions): ReadonlyArray<string> => {
  const bin = Option.getOrElse(Option.fromUndefinedOr(options.binary), () => "agy")
  const args: Array<string> = [bin]
  if (options.skipPermissions !== false) {
    args.push("--dangerously-skip-permissions")
  }
  args.push(...addDirFlags(options.addDirs))
  return args
}

const resumeCommandFor = (options: ResumeOptions): ReadonlyArray<string> => {
  const bin = Option.getOrElse(Option.fromUndefinedOr(options.binary), () => "agy")
  const args: Array<string> = [bin, "--continue"]
  if (options.skipPermissions !== false) {
    args.push("--dangerously-skip-permissions")
  }
  args.push(...addDirFlags(options.addDirs))
  args.push("-i", options.initialPrompt)
  return args
}

/** Antigravity CLI (`agy`) interactive pane adapter. */
export const agyAdapter: HarnessAdapter = {
  harness: "agy",
  command: commandFor,
  resumeCommand: resumeCommandFor,
  readyForInput: isReadyForInput,
  formatSubmit: (text) => [`\x1b[200~${sanitizePaste(text)}\x1b[201~`, "\r"],
  formatSteer: (text) => [`\x1b[200~${sanitizePaste(text)}\x1b[201~`, "\x1bm"],
  turnEnded: isTurnEnded,
  needsInput: detectNeedsInput,
  usageLimit: detectUsageLimit,
  interruptSequence: "\x1b",
  readLastAnswer: readAnswer,
  readLastPrompt: readPrompt,
}
