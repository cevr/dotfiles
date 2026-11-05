// The plugin directories a run loads: the Anthropic auth plugin (its domain
// vendored from @ex-machina/opencode-anthropic-auth, see
// mods/anthropic-auth/README.md) and the account pool it serves.
import { resolve } from "node:path"

/** The Anthropic auth plugin's directory in this repository. */
export const anthropicAuthPlugin = resolve(import.meta.dir, "../cmd/anthropic-auth")

/** The pool plugin's directory in this repository. */
export const poolPlugin = resolve(import.meta.dir, "../cmd/pool")
