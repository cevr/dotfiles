// A tool name a model got nearly right: the one real tool it differs from by
// case alone, or by one edit (a letter added, dropped, changed, or two
// neighbours swapped). A provider may carry tool names under an alias (the
// Claude login's `mcp_T<base64url>`, `@dotfiles/opencode-anthropic-auth/tool-alias`),
// so a miss of an alias counts too, and the answer names the alias.
//
// The call is answered, never run under the real name: by the time this hook
// sees it, other plugins' `execute.before` hooks (the guard, orchestrate's
// roles) have read the wrong name and let it pass, so running it would skip them.
import { Base64Url } from "effect/encoding"

/** The alias a provider sends `name` under: `mcp_T` and the name's UTF-8 bytes in base64url. */
export const aliasOf = (name: string): string => `mcp_T${Base64Url.encode(new TextEncoder().encode(name))}`

/** Whether `a` and `b` are at most one edit apart: an insertion, a deletion, a substitution or a swap of neighbours. */
export const oneEdit = (a: string, b: string): boolean => {
  if (a === b) return true
  if (Math.abs(a.length - b.length) > 1) return false
  let start = 0
  while (start < a.length && start < b.length && a[start] === b[start]) start++
  if (a.length === b.length) {
    // One substitution, or neighbours swapped.
    if (a.slice(start + 1) === b.slice(start + 1)) return true
    return a[start] === b[start + 1] && a[start + 1] === b[start] && a.slice(start + 2) === b.slice(start + 2)
  }
  const [longer, shorter] = a.length > b.length ? [a, b] : [b, a]
  return longer.slice(start + 1) === shorter.slice(start)
}

/** The real tool a called name nearly matches, and the name the model should call it by. */
export interface Match {
  /** The tool's name in OpenCode. */
  readonly tool: string
  /** What the model should call: the tool's name, or its alias when the model called an alias. */
  readonly call: string
}

/**
 * The one tool `called` nearly names, or undefined when it names none or
 * several. Case alone wins over one edit; an alias is matched against the
 * tools' aliases, exactly as written, since base64 is case-sensitive.
 */
export const nearest = (called: string, tools: ReadonlyArray<string>): Match | undefined => {
  if (tools.includes(called)) return undefined
  const one = (matches: ReadonlyArray<Match>): Match | undefined => (matches.length === 1 ? matches[0] : undefined)
  if (called.startsWith("mcp_T")) {
    const aliased = tools.map((tool) => ({ tool, call: aliasOf(tool) }))
    const byCase = aliased.filter((match) => match.call.toLowerCase() === called.toLowerCase())
    if (byCase.length > 0) return one(byCase)
    return one(aliased.filter((match) => oneEdit(match.call, called)))
  }
  const lower = called.toLowerCase()
  const byCase = tools.filter((tool) => tool.toLowerCase() === lower)
  if (byCase.length > 0) return byCase.length === 1 ? { tool: byCase[0]!, call: byCase[0]! } : undefined
  // A name of two letters or fewer is one edit from too much to guess.
  if (called.length <= 2) return undefined
  const near = tools.filter((tool) => oneEdit(tool.toLowerCase(), lower))
  return near.length === 1 ? { tool: near[0]!, call: near[0]! } : undefined
}

/** What the model reads when it called `called` and meant `match`. */
export const misnamed = (called: string, match: Match): string =>
  match.call === match.tool
    ? `There is no "${called}" tool; did you mean "${match.tool}"? Call "${match.tool}" with the same input.`
    : `There is no "${called}" tool; did you mean "${match.call}" (${match.tool})? Call "${match.call}" with the same input.`
