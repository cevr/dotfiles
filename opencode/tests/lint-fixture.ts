import { Data, Effect, Option, Schema } from "effect"
import { spawn } from "../scripts/effect-debt.ts"
import { ROOT } from "../scripts/reach.ts"
import { installedInput, matchingInput, scratchInput } from "./read-path.ts"
import { localTestPaths, scratch } from "./scratch.ts"

const { resolve } = localTestPaths
const Config = Schema.fromJsonString(Schema.Struct({
  jsPlugins: Schema.Array(Schema.String),
  extends: Schema.optionalKey(Schema.Never),
  overrides: Schema.optionalKey(Schema.Array(Schema.Struct({
    extends: Schema.optionalKey(Schema.Never),
    jsPlugins: Schema.optionalKey(Schema.Never),
  }))),
}))

class LintFixtureInput extends Data.TaggedError("LintFixtureInput")<{ readonly message: string }> {}

const refuse = (message: string) => Option.getOrThrowWith(Option.none<never>(), () => new LintFixtureInput({ message }))

const lint = (cwd: string, config: string, files: ReadonlyArray<string>, home: string, timeout: number) => {
  const inputs = Schema.decodeUnknownSync(Config)(localTestPaths.readFileSync(config, "utf8"))
  const own = matchingInput("lint/test-env.ts")
  const installed = resolve(ROOT, "lint/node_modules/oxlint-plugin-effect/dist/plugin.js")
  for (const entry of inputs.jsPlugins) {
    const file = resolve(resolve(config, ".."), entry)
    if (file === installed) installedInput(file)
    else if (file !== own) return refuse(`unknown lint fixture plugin: ${file}`)
  }
  if (files.length === 0) return refuse("lint fixture needs explicit files")
  const tool = installedInput(resolve(ROOT, "node_modules/.bin/oxlint"))
  const env = {
    PATH: "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin", HOME: home, TMPDIR: home,
    XDG_CONFIG_HOME: home, XDG_CACHE_HOME: home, XDG_DATA_HOME: home, XDG_STATE_HOME: home,
  }
  return spawn([tool, "--threads=3", "--disable-nested-config", "--format=json", "-c", config, ...files], cwd, timeout, env)
}

/**
 * Oxlint on generated sources and config. This is a checked checkout setup,
 * not a scratch child: Oxlint loads the real checkout's rules plugin.
 */
export const lintFixture = (cwd: string, configName: string, files: ReadonlyArray<string>, timeout: number) =>
  Effect.suspend(() => {
    const directory = scratchInput(cwd)
    const config = scratchInput(resolve(directory, configName))
    for (const name of files) {
      if (name.startsWith("-") || !/\.[cm]?[jt]sx?$/.test(name)) return refuse(`not a lint fixture source: ${name}`)
      scratchInput(resolve(directory, name))
    }
    return lint(directory, config, files, directory, timeout)
  })

/** The same linter over a runtime-selected list of real sources. */
export const lintCheckoutFixture = (scope: string, files: ReadonlyArray<string>, timeout: number) =>
  Effect.acquireUseRelease(
    Effect.sync(() => scratch("checkout-lint-")),
    ({ path }) => Effect.suspend(() => {
      for (const file of files) {
        if (file.startsWith("-") || !/\.[cm]?[jt]sx?$/.test(file)) return refuse(`not a lint fixture source: ${file}`)
        matchingInput(scope, file)
      }
      return lint(ROOT, matchingInput(".oxlintrc.json"), files, path, timeout)
    }),
    (dir) => Effect.sync(() => dir[Symbol.dispose]()),
  )
