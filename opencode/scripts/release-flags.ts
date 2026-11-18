// The feature flags a driven OpenCode resolves. A run against a fork checkout
// (`OPENCODE_DEV`) starts OpenCode from source, whose channel is `local`, and
// a local or dev build turns every flag on by default. Since upstream 77b322ceae
// (2026-11-18) that includes `full_codemode`, which moves `shell`, `read`,
// `edit`, `write`, `patch` and `websearch` behind Code Mode's `execute` tool:
// a scripted model's direct `shell` call then finds no tool, no shell starts,
// and the dock reads `0 shells` (tests/prime-panel.test.ts). The owner runs a
// `latest` build (scripts/daily.ts), where `full_codemode` is off, so a run
// turns it off too unless its caller names it in `OPENCODE_FLAGS`. The list
// outranks the config, so a run that wants Code Mode's full tools names
// `full_codemode` there, not in `experimental.full_codemode`.

/** The flags a run turns off unless its caller names them: those off in the owner's build that change what a model is offered. */
export const RELEASE_OFF = ["full_codemode"] as const

/** The entries of an `OPENCODE_FLAGS` list (`all,-media_blob`), without their `-`. */
const named = (flags: string) =>
  new Set(
    flags
      .split(",")
      .map((entry) => entry.trim().replace(/^-/, ""))
      .filter((entry) => entry !== ""),
  )

/**
 * `env` with `OPENCODE_FLAGS` turning off each of `RELEASE_OFF` it does not name, so a driven OpenCode offers the
 * model the tools the owner's build offers. A flag the caller names, on or off, keeps the caller's word; `all`
 * names none.
 */
export const releaseFlags = <Value extends string | undefined>(env: Readonly<Record<string, Value>>): Record<string, Value | string> => {
  const flags = env["OPENCODE_FLAGS"] ?? ""
  const own = named(flags)
  const off = RELEASE_OFF.filter((flag) => !own.has(flag)).map((flag) => `-${flag}`)
  if (off.length === 0) return { ...env }
  return { ...env, OPENCODE_FLAGS: [flags, ...off].filter((entry) => entry !== "").join(",") }
}
