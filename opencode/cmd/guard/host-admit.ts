#!/usr/bin/env bun
/**
 * host-admit, kept as a stub after the host's admission gate was removed
 * (the owner, 2026-11-26: no nice launcher, no heavy queue). Scripts and
 * agents that still type `host-admit check run … -- CMD` keep working: any
 * form with a `--` runs what follows it as written, in this terminal, with
 * its stdin, stdout and stderr, prints nothing of its own and exits with its
 * code (128 + the signal when a signal ended it). A signal this process gets
 * is passed to the command. `host status --json` answers a small honest
 * reading of the host: its cores, load, memory and the disk under the
 * working directory. Every other form exits 2 and says so.
 */
import { argv, spawn, spawnSync } from "bun"
import { Array as Arr, Console, Effect, Option, Schema } from "effect"
import { availableParallelism, constants, freemem, loadavg, totalmem } from "node:os"

const usage = `host-admit 2: runs commands as written; admission was removed
  host status --json                 cores, load, memory, and the disk here
  <anything> -- COMMAND [ARGS...]     runs COMMAND as written, exits with its code`

const output = Schema.encodeSync(Schema.fromJsonString(Schema.Json))
const FORWARDED: ReadonlyArray<NodeJS.Signals> = ["SIGHUP", "SIGINT", "SIGQUIT", "SIGTERM"]

/** The disk under `cwd`, as `df -kP` reads it: its size and what is free, in bytes; zero when df cannot read it. */
const diskOf = (cwd: string) => {
  const ran = spawnSync(["df", "-kP", cwd], { stdout: "pipe", stderr: "ignore" })
  const [, total = "0", , free = "0"] = ran.stdout.toString().trim().split("\n").at(-1)?.split(/\s+/) ?? []
  return { totalBytes: Number(total) * 1024, freeBytes: Number(free) * 1024 }
}

/** What the host has, read now: no ledger, no sample kept. */
export const hostStatus = (cwd: string) => {
  const disk = diskOf(cwd)
  const [one = 0, five = 0, fifteen = 0] = loadavg()
  return {
    version: 2,
    cores: availableParallelism(),
    load: { one, five, fifteen },
    memory: { totalBytes: totalmem(), freeBytes: freemem() },
    disk: { path: cwd, ...disk },
  }
}

/** The command after the first `--`, as written; none when there is no `--` or nothing follows it. */
export const commandOf = (args: ReadonlyArray<string>): Option.Option<ReadonlyArray<string>> => {
  const at = args.indexOf("--")
  return Option.filter(Option.some(args.slice(at + 1)), (command) => at >= 0 && command.length > 0)
}

/** Run `command` in this terminal; its exit code, 128 + the signal when one ended it. */
const runAsWritten = (command: ReadonlyArray<string>) => Effect.gen(function* () {
  const child = yield* Effect.try({
    try: () => spawn([...command], { stdin: "inherit", stdout: "inherit", stderr: "inherit" }),
    catch: (cause) => cause,
  }).pipe(Effect.option)
  if (Option.isNone(child)) {
    yield* Console.error(`host-admit: cannot run ${command[0]}`)
    return 127
  }
  const forward = FORWARDED.map((signal) => {
    const pass = () => void child.value.kill(signal)
    process.on(signal, pass)
    return () => void process.off(signal, pass)
  })
  const code = yield* Effect.promise(() => child.value.exited)
  forward.forEach((off) => off())
  return Option.match(Option.fromNullishOr(child.value.signalCode), {
    onNone: () => code,
    onSome: (signal) => 128 + Option.getOrElse(Option.map(Arr.findFirst(Object.entries(constants.signals), ([name]) => name === signal), ([, number]) => number), () => 9),
  })
})

export const main = (args: ReadonlyArray<string>, cwd: string) => Effect.gen(function* () {
  const command = commandOf(args)
  if (Option.isSome(command)) return yield* runAsWritten(command.value)
  if (args[0] === "host" && args[1] === "status") {
    yield* Console.log(output(hostStatus(cwd)))
    return 0
  }
  if (args[0] === "--version") {
    yield* Console.log("host-admit 2")
    return 0
  }
  if (args[0] === "--help" || args[0] === "-h") {
    yield* Console.log(usage)
    return 0
  }
  yield* Console.error(usage)
  return 2
})

if (import.meta.main) Effect.runFork(Effect.tap(main(argv.slice(2), process.cwd()), (code) => Effect.sync(() => void (process.exitCode = code))))
