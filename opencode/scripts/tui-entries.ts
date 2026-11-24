import { Option } from "effect"
import { TUI_OFF, tuiPluginsOf } from "../mods/update/trees.ts"

export const pluginPackagesFrom = (names: ReadonlyArray<string>, manifest: (name: string) => Option.Option<string>) =>
  names.flatMap((name) => Option.toArray(Option.map(manifest(name), (text) => ({ name, manifest: text }))))

export const tuiEntriesFrom = (packages: Parameters<typeof tuiPluginsOf>[0], dirOf: (name: string) => string) =>
  [...tuiPluginsOf(packages).map(dirOf), ...TUI_OFF]
