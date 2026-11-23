import { Glob } from "bun"
import { Data, Option, Predicate } from "effect"
import { ROOT as workspace } from "../scripts/reach.ts"
import { localTestPaths, scratchRoot } from "./scratch.ts"

const { existsSync, isAbsolute, join, relative, resolve, readFileSync, readdirSync, readlinkSync, realpathSync } = localTestPaths

class InvalidTestInput extends Data.TaggedError("InvalidTestInput")<{ readonly message: string }> {}

const denied = (file: string, boundary: string): never =>
  Option.getOrThrowWith(Option.none<never>(), () => new InvalidTestInput({ message: `test input ${file} is not under ${boundary}` }))

/** A computed input selected by a known glob, from opencode/. Reject anything outside that set. */
export const matchingInput = (pattern: string, file = pattern) => {
  const target = resolve(workspace, file)
  if (!new Glob(pattern).match(relative(workspace, target))) return denied(file, pattern)
  return target
}

const outside = (root: string, target: string) => {
  const suffix = relative(root, target)
  return suffix === ".." || suffix.startsWith("../") || isAbsolute(suffix)
}

/** An absolute path in a scratch tree, including one returned by a fixture builder. */
export const scratchInput = (file: string) => {
  const root = scratchRoot()
  const repo = realpathSync(join(workspace, ".."))
  const target = realpathSync((existsSync(file) && file) || resolve(file, ".."))
  if (!isAbsolute(file) || outside(root, target) || !outside(repo, target)) return denied(file, root)
  return file
}

/** An explicitly supplied alternate checkout/installation, never the test's own checkout. */
export const externalInput = (file: string) => {
  if (!outside(realpathSync(join(workspace, "..")), realpathSync(file))) return denied(file, "an external checkout")
  return file
}

/** A package-manager input (not a tracked workspace input). Resolve before checking. */
export const installedInput = (file: string) => {
  if (!realpathSync(file).includes("/node_modules/")) return denied(file, "an installed package")
  return file
}

export function readScratchFileSync(file: string, encoding: BufferEncoding): string
export function readScratchFileSync(file: string): Buffer
export function readScratchFileSync(file: string, encoding?: BufferEncoding): Buffer | string {
  const at = scratchInput(file)
  if (Predicate.isUndefined(encoding)) return readFileSync(at)
  return readFileSync(at, encoding)
}

export const readScratchDirectorySync = (file: string, options?: { encoding?: "utf8"; recursive?: boolean }) =>
  readdirSync(scratchInput(file), { recursive: options?.recursive, encoding: "utf8" })

/** Read the link itself, not its destination (the destination may deliberately not exist). */
export const readScratchLinkSync = (file: string) => {
  scratchInput(resolve(file, ".."))
  return readlinkSync(file)
}
