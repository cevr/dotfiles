// The orchestrate step a subagent call's description names, read from the
// skill's form for it: a description that starts like the hand-back line,
// `<role> <unit> r<N>` (SKILL.md, "Every Agent call ..."). Roots also write
// the role after a one-word unit slug, `<unit>[ rN] <role>[ rN][ (note)]`
// (`closure-flake verifier r1 (Opus)`, `pkg-lower r2 implementor`), so that
// form counts too.
//
// Plain TypeScript with no imports: the guard routes by it (role.ts) and the
// subagent rows label by it (@dotfiles/opencode-subagents), so both read the
// same form.
//
// A description that only mentions a role in prose names no step: the role
// word must be the first word, or the word after a one-word unit with only an
// optional round and parenthetical behind it, and it must be the role's own
// lowercase name, as the agent is named. `Fix the verifier's timeout`,
// `Ask the planner about X`, `Fix verifier` and `Planner prompt rewrite`
// name none.

/** The orchestrate roles a unit's machine steps run as: plan, implement, verify. */
export const STEPS = ["planner", "implementor", "verifier"] as const
export type Step = (typeof STEPS)[number]

export const isStep = (word: string): word is Step => (STEPS as readonly string[]).includes(word)

/** The step a description names, and the description without the role word. */
export type Described = { readonly role: Step; readonly rest: string }

const ROUND = /^r\d+$/
/**
 * `<unit>[ rN] <role>[ rN][ (note)]`: a one-word unit slug (lowercase, as the skill's slugs are, so a
 * capitalised word such as `Fix` is prose), the role, and only a round and a note after it.
 */
const SUFFIX = /^([a-z0-9#][a-z0-9._#/-]*)((?: r\d+)?) (planner|implementor|verifier)((?: r\d+)?)((?: \([^()]*\))?)$/

/** The step `description` names in the skill's form, if any (see above). */
export function described(description: string | undefined): Described | undefined {
  const text = (description ?? "").trim().replace(/\s+/g, " ")
  const words = text.split(" ")
  const first = words[0] ?? ""
  // `<role> <unit> r<N>`: the hand-back form, a role first and a unit after it.
  if (isStep(first) && words.length > 1) return { role: first, rest: words.slice(1).join(" ") }
  const match = SUFFIX.exec(text)
  if (!match) return undefined
  const [, unit, before, role, after, note] = match
  if (!unit || ROUND.test(unit) || !role || !isStep(role)) return undefined
  return { role, rest: `${unit}${before}${after}${note}` }
}
