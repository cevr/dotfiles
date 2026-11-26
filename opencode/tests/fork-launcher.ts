import { spawn } from "bun"
import { Data, Option } from "effect"
import { launcher } from "../mods/update/filestore/launcher.ts"
import { readScratchFileSync, scratchInput } from "./read-path.ts"
import { forkFixture, writeScratchScript } from "./scratch-child.ts"

class ForkLauncherInput extends Data.TaggedError("ForkLauncherInput")<{ readonly message: string }> {}
const reject = (message: string) => Option.getOrThrowWith(Option.none<never>(), () => new ForkLauncherInput({ message }))

const forkShim = (argv: ReadonlyArray<string>) =>
  `#!/bin/sh\nexec ${argv.map((word) => `'${word.replaceAll("'", `'\\''`)}'`).join(" ")} "$@"\n`

interface Inputs {
  readonly fork: string
  readonly cwd: string
  readonly link: string
  readonly shim: string
  readonly resident: string
  readonly env: Readonly<Record<string, string>>
}

const checked = ({ fork, cwd, link, shim, resident, env }: Inputs, args: ReadonlyArray<string>) => {
  if (args[0] !== "service") return reject("only service commands use the staged fork launcher")
  const { argv: [bun, noEnvFile, entry], ...options } = forkFixture(fork, cwd, args, env)
  const bin = scratchInput(shim)
  return {
    ...options, link: scratchInput(link), shim: bin,
    linkText: launcher(bin, scratchInput(resident)),
    shimText: forkShim([bun, noEnvFile, entry]),
  }
}

/** Stage the real launcher against a checked fork and the service fixture's own resident. */
export const stageForkLauncher = (inputs: Inputs) => {
  const { link, shim, linkText, shimText } = checked(inputs, ["service", "start"])
  writeScratchScript(shim, shimText)
  writeScratchScript(link, linkText)
}

/** Run only the staged production launcher, not an arbitrary executable or a replaced shim. */
export const spawnForkLauncher = (inputs: Inputs, args: ReadonlyArray<string>) => {
  const { link, shim, linkText, shimText, ...options } = checked(inputs, args)
  if (readScratchFileSync(link, "utf8") !== linkText || readScratchFileSync(shim, "utf8") !== shimText)
    return reject("unexpected staged fork launcher text")
  return spawn([link, ...args], { ...options, stdin: "ignore", stdout: "pipe", stderr: "pipe" })
}
