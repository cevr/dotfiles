// The variables an older installed tree build bound its plugin configuration by: `OPENCODE_CONFIG`
// (the tree's `opencode.json`), `OPENCODE_CLI_CONFIG_CONTENT` (the text of its `cli.json`, which the
// TUI reads in place of its own) and `OPENCODE_ADJACENT_CONFIG` (the tree's config folder, the mark
// that the other two are a binding's). Builds before fork 07bb11e0 set them in their own environment,
// so every shell they ran, and every test started from an agent's shell, inherited them; a run from
// source (`OPENCODE_DEV`) then kept that binding: a scenario loaded the installed tree's server plugins
// and its TUI plugin list in place of its own `tuiConfig`, and waited on that tree's file watchers, so
// its editor never took focus in the driver's 30 s (the deep run of 2026-11-20).
//
// Since fork 07bb11e0 the binding is a value held in the CLI (packages/cli/src/adjacent-config.ts),
// derived from the executable's path and never put in the environment, and a build or a run from
// source of that fork drops a marked binding it inherited. This defence stays for what the fork does
// not reach: a shell an older installed build started (a host not yet updated) still carries the
// binding, and the test's child may be a fork checkout before 07bb11e0, or a program other than
// OpenCode that reads `OPENCODE_CONFIG`. A child drops the binding it inherited (`outsideBuild`) and
// keeps a value its caller set.

/** The mark of a bound build's environment. */
const MARK = "OPENCODE_ADJACENT_CONFIG"

/** The keys a bound build sets, all or none. */
const BINDING: ReadonlySet<string> = new Set(["OPENCODE_CONFIG", "OPENCODE_CLI_CONFIG_CONTENT", MARK])

/** Whether `name` is a variable a bound build sets. */
export const isBindingVariable = (name: string): boolean => BINDING.has(name)

/**
 * `env` without the build binding it inherited from `parent`: with `parent` bound (it has
 * `OPENCODE_ADJACENT_CONFIG`), a binding key whose value is the parent's came from the installed
 * build; one the caller set to something else is the child's. An unbound parent's own
 * `OPENCODE_CONFIG` is the user's and stays.
 */
export const outsideBuild = <Value>(env: Readonly<Record<string, Value>>, parent: Readonly<Partial<Record<string, string>>>): Record<string, Value> => {
  const bound = MARK in parent
  return Object.fromEntries(Object.entries(env).filter(([name, value]) => !bound || !isBindingVariable(name) || parent[name] !== value))
}
