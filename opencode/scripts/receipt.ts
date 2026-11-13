// `bun <dotfiles>/opencode/scripts/receipt.ts`: writes the receipt (mods/rift/receipt.ts) of a round's proof
// for the checkout it runs in, in any repository a `rift` land lands by receipts (`rift.mergeCheck`): the
// dotfiles, Ergo, any other. A land takes the receipt while it names the Rift's head and tracked files, and
// runs nothing of the Rift's own again.
//
//   receipt.ts -- <command> [<command>…]       runs each command (`sh -c`, here, one after another, its
//                                              output passed through) and receipts them all: focused tests,
//                                              a mutant run, a Quint or model run, real-host laws
//   receipt.ts --attest '<proof>' [--code N]   receipts a proof already made, not run here: the batch
//                                              verifier's verdict and its findings file, a report
//
// Either way the receipt names where the checkout stood before (its head and the tree of its tracked files
// on disk), each command with its exit and time, and when it ended; it goes into the checkout (its Git dir's
// rift-receipt.json) and the host's receipts folder (`${XDG_CACHE_HOME:-~/.cache}/rift-land/receipts`). It
// exits 1 when a command failed (the receipt is red, and a land runs the Rift's focused gate or stops), 2 on
// a usage error, else 0.
import { Array as Arr, Match, Option } from "effect"
import { landLogs, scriptReceipts } from "../mods/rift/process/landing.ts"

const ENV = process.env
const ARGV = process.argv.slice(2)
const USAGE = "usage: receipt.ts -- <command> [<command>…] | receipt.ts --attest '<proof>' [--code N]"

/** The argument after `flag`, when `flag` is there. */
const after = (flag: string): Option.Option<string> =>
  Option.flatMap(
    Option.filter(Option.some(ARGV.indexOf(flag)), (at) => at >= 0),
    (at) => Arr.get(ARGV, at + 1),
  )

/** A command run here through `sh -c`, its output passed through, to its exit code. */
const ran = (command: string) => () => Bun.spawn(["sh", "-c", command], { env: ENV, stdout: "inherit", stderr: "inherit" }).exited

/** One step of the receipt: its command, and its run to an exit or the exit of a proof made elsewhere. */
interface Step {
  readonly command: string
  readonly exit: number | (() => Promise<number>)
}

/** The run's steps: the one attested proof, or each command (a leading `--` is dropped by Bun before this sees it). */
const steps: ReadonlyArray<Step> = Match.value(ARGV.includes("--attest")).pipe(
  Match.when(true, () =>
    Option.match(after("--attest"), {
      onSome: (proof) => [{ command: `attested: ${proof}`, exit: Number(Option.getOrElse(after("--code"), () => "0")) }],
      onNone: () => [],
    }),
  ),
  Match.orElse(() => Arr.map(Arr.filter(ARGV, (each, at) => at > 0 || each !== "--"), (command) => ({ command, exit: ran(command) }))),
)

/** The line a run ends with, and its exit. */
const ending = (checks: ReadonlyArray<{ readonly code: number }>, file: string) => {
  const red = checks.filter((check) => check.code !== 0).length
  const verdict = Arr.match(Arr.filter(checks, (check) => check.code !== 0), {
    onEmpty: () => "green",
    onNonEmpty: () => `RED (${red} of ${checks.length} failed)`,
  })
  return { line: `receipt: ${verdict}: ${file}`, code: Math.min(1, red) }
}

Arr.match(steps, {
  onEmpty: () => {
    console.error(USAGE)
    process.exit(2)
  },
  onNonEmpty: (some) =>
    scriptReceipts(landLogs(ENV), process.cwd(), "round", some).then(({ checks, file }) => {
      const end = ending(checks, file)
      console.error(end.line)
      process.exit(end.code)
    }),
})
