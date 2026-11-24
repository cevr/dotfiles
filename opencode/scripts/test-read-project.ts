import { resolveSync } from "bun"
import { Effect, Option, Path } from "effect"
import { INSTALLED_MODULE, readInputChecker } from "./test-reads.ts"

const path = Effect.runSync(Effect.provide(Path.Path, Path.layer))

/** Scan only project source from the runner's checkout, never host or installed source files. */
export const projectReadChecker = (root: string, files: ReadonlyArray<string>, sourceText: (file: string) => string) => {
  const sources = new Set(files.filter((file) => /\.[cm]?[jt]sx?$/.test(file)))
  const readSource = (file: string) => (sources.has(file) && sourceText(file)) || ""
  const resolvePackage = (specifier: string, from: string) => {
    const target = Effect.runSync(Effect.option(Effect.try(() => resolveSync(specifier, path.dirname(path.join(root, from))))))
    return Option.match(target, {
      onNone: () => "",
      onSome: (file) => {
        const local = path.relative(root, file)
        return (sources.has(local) && local) ||
          (!specifier.startsWith("@dotfiles/") && file.includes("/node_modules/") && INSTALLED_MODULE) || ""
      },
    })
  }
  return readInputChecker(readSource, resolvePackage)
}
