// A model's short name for a subagent row: its family and, apart, its
// version, never its provider or its effort.
//
//   anthropic/claude-opus-5-5        → opus 5.5
//   anthropic/claude-fable-5-2       → fable 5.2
//   claude-3-5-sonnet-20241022       → sonnet 3.5
//   openai/gpt-6.1-sol               → sol 6.1
//   gpt-5.1-codex-max                → codex 5.1
//   gpt-5-mini                       → gpt 5
//   deepseek/deepseek-v3.2           → deepseek 3.2
//   gemini-2.5-pro                   → gemini 2.5

/** A model's short name, and its version when the id says one. */
export type ModelName = { readonly name: string; readonly version?: string }

/** Tokens that only say how hard or how fresh, never which model. */
const NOISE = new Set(["latest", "preview", "exp", "experimental", "low", "medium", "high", "xhigh", "max", "minimal", "none", "thinking"])
/** GPT size and tier words: not a name of their own. */
const SIZES = new Set(["mini", "nano", "pro", "turbo", "chat", "instant", "model", "sim", "search", "audio", "realtime"])

const date = (token: string) => /^\d{8}$/.test(token) || /^\d{4}$/.test(token)
const numeric = (token: string) => /^\d+$/.test(token)
const versioned = (token: string) => /^v?\d[\w.]*$/.test(token)

/** The first version the tokens give: a run of whole numbers (`5`,`5` → `5.5`), else the first token that starts with a digit. */
function version(tokens: ReadonlyArray<string>): string | undefined {
  const start = tokens.findIndex(versioned)
  if (start < 0) return undefined
  const first = tokens[start]?.replace(/^v/, "") ?? ""
  if (!numeric(first)) return first
  const run = [first]
  for (const token of tokens.slice(start + 1)) {
    if (!numeric(token)) break
    run.push(token)
  }
  return run.join(".")
}

/**
 * The short name of the model `id` (with or without its provider, `:effort` or `#effort`
 * or a date), or undefined for an empty id.
 */
export function modelName(id: string | undefined): ModelName | undefined {
  const bare = (id ?? "").split("/").at(-1)?.split(/[:@#]/)[0]?.trim().toLowerCase() ?? ""
  const tokens = bare.split(/[-_\s]+/).filter((token) => token && !NOISE.has(token) && !date(token))
  if (tokens.length === 0) return undefined
  const named = (name: string, from: ReadonlyArray<string>): ModelName => {
    const found = version(from)
    return found === undefined ? { name } : { name, version: found }
  }
  // Claude's family is the word beside it (opus, sonnet, haiku, fable, …), wherever the version sits.
  if (tokens.includes("claude")) return named(tokens.find((token) => token !== "claude" && /^[a-z]+$/.test(token)) ?? "claude", tokens)
  const head = tokens[0] ?? ""
  if (head === "gpt" || head === "codex") {
    const rest = tokens.slice(1)
    const found = version(rest)
    if (tokens.includes("codex")) return named("codex", rest)
    // A codename after the version (gpt-6.1-sol) names the model better than gpt does.
    const codename = found === undefined ? undefined : rest.find((token) => /^[a-z]+$/.test(token) && !SIZES.has(token))
    return named(codename ?? "gpt", rest)
  }
  // Another family names itself first (deepseek, gemini, qwen3, o3) and may say a version after.
  if (versioned(head)) return { name: head }
  return named(head, tokens.slice(1))
}

/** The short name as a row draws it: with its version, or with `short` the name alone. */
export const modelLabel = (model: ModelName | undefined, short = false): string =>
  model === undefined ? "" : short || model.version === undefined ? model.name : `${model.name} ${model.version}`
