// The Anthropic auth plugin our pool works with: the fork of
// @ex-machina/opencode-anthropic-auth with the credential-choice seam, loaded
// from its checkout's sources. OpenCode loads a local plugin from a
// directory, and the checkout's own entry is its build output, so a run
// gets a small directory that re-exports the sources.
import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"

/** The checkout: `OPENCODE_ANTHROPIC_AUTH`, else beside this repository. */
export const anthropicAuthSource = (env: Readonly<Record<string, string | undefined>> = process.env): string =>
  resolve(env.OPENCODE_ANTHROPIC_AUTH || join(import.meta.dir, "../../../opencode-anthropic-auth"))

/** Write the loader directory under `dir` and return it, for a config's `plugins`. */
export const anthropicAuthPlugin = (dir: string, source = anthropicAuthSource()): string => {
  const entry = join(source, "src/index.ts")
  if (!existsSync(entry)) {
    throw new Error(`no Anthropic auth plugin at ${source}; clone cevr/opencode-anthropic-auth there or set OPENCODE_ANTHROPIC_AUTH`)
  }
  const plugin = join(dir, "anthropic-auth")
  mkdirSync(plugin, { recursive: true })
  writeFileSync(join(plugin, "package.json"), `${JSON.stringify({ name: "anthropic-auth-loader", type: "module" })}\n`)
  writeFileSync(join(plugin, "server.ts"), `export { default } from ${JSON.stringify(entry)}\n`)
  return plugin
}

/** The pool plugin's directory in this repository. */
export const poolPlugin = resolve(import.meta.dir, "../mods/pool")
