/**
 * `digest pair`: pair a browser with the digest page so it may answer there, and on the tailnet mark messages and
 * read them; list and unpair them. On his hosts his own devices (his Tailscale user's) read, mark and answer on the
 * tailnet unpaired (`digest.tailnetRead`, `digest.tailnetWrite`), so pairing is for the agent machines' browsers
 * (this host and `digest.agentHosts`), for loopback answers, and for any device where a switch is "paired".
 *
 *   bun cmd/digest/pair.ts [--dir <digest dir>] [--port <port>]     a one-use code, and the page's link with it
 *   bun cmd/digest/pair.ts --list [--dir <digest dir>]                the browsers paired now: id, when, which browser
 *   bun cmd/digest/pair.ts --revoke <id>|all [--dir <digest dir>]     unpair one browser, or every one
 *
 * - The code is good once, for five minutes. The page exchanges it for a token, which it keeps in its own origin's
 *   storage.
 * - Only hashes are kept, in the pairing file beside the log (`--dir`, default `$XDG_STATE_HOME/opencode-digest`,
 *   the digest plugin's).
 * - Up to MAX_PAIRED browsers are paired at once (his Mac's, his phone's, a few more). One more unpairs the oldest.
 * - A revoked browser's next answer is refused, and its page asks to pair again.
 * - The link carries the one-use code, never a token; nothing printed here pairs once the code is used or out of time.
 */
import { parseArgs } from "node:util"
import { Array as Arr, Clock, Console, DateTime, Effect, Match, Option, Schema } from "effect"
import * as TuiDirs from "@dotfiles/decider/tui-dirs"
import * as FilePairing from "@dotfiles/opencode-digest/filestore/pairing"
import { hostWithPort, noTailnet, type Tailnet } from "@dotfiles/opencode-digest/bind"
import { HOSTNAME, PORT } from "@dotfiles/opencode-digest/http/listener"
import { CODE_TTL_MS, MAX_PAIRED, type Paired, showCode } from "@dotfiles/opencode-digest/pairing"
import { probe } from "@dotfiles/opencode-digest/process/tailnet"

/** What the command does, and where. */
export type Target =
  | { readonly kind: "issue"; readonly dir: string; readonly port: number }
  | { readonly kind: "list"; readonly dir: string }
  | { readonly kind: "revoke"; readonly dir: string; readonly which: { readonly id: string } | "all" }

/** The target the arguments name; none for a port that is not one. */
export const targetOf = (args: ReadonlyArray<string>): Option.Option<Target> => {
  const { values } = parseArgs({ args: [...args], options: { dir: { type: "string" }, port: { type: "string" }, list: { type: "boolean" }, revoke: { type: "string" } }, strict: true })
  const dir = Option.getOrElse(Option.fromUndefinedOr(values.dir), () => `${TuiDirs.dirs().state}/opencode-digest`)
  const port = Option.getOrElse(Option.map(Option.fromUndefinedOr(values.port), Number), () => PORT)
  return Option.match(Option.fromUndefinedOr(values.revoke), {
    onSome: (revoke) => Option.some<Target>({ kind: "revoke", dir, which: Option.getOrElse(Option.as(Option.liftPredicate(revoke, (each) => each === "all"), "all" as const), () => ({ id: revoke })) }),
    onNone: () =>
      Option.match(Option.liftPredicate(values.list, (each) => each === true), {
        onSome: () => Option.some<Target>({ kind: "list", dir }),
        onNone: () => Option.map(Option.liftPredicate(port, (each) => Number.isInteger(each) && each > 0 && each < 65_536), (valid): Target => ({ kind: "issue", dir, port: valid })),
      }),
  })
}

/**
 * What the owner reads after an issue: the link to open on this host, the code to type instead, and the page's
 * addresses on the tailnet where a phone types it. Only its addresses: under a name the tailnet page only sends a
 * browser on to its address (policy.ts). Each address is its own origin, so pairs on its own.
 */
export const said = (code: string, port: number, tailnet: Tailnet = noTailnet("none")): string => {
  const urls = tailnet.addresses.map((each) => `  http://${hostWithPort(each, port)}/`)
  const remote = Arr.match(urls, {
    onEmpty: () => [`The page has no tailnet address here (${tailnet.why}), so it is on this host only.`],
    onNonEmpty: (all) => [
      "On a phone or another device on your tailnet, open one of these and type the code:",
      ...all,
      "Each address pairs on its own: a browser paired at one of them is asked to pair again at another.",
    ],
  })
  return [
    `Open this in this host's browser to pair it (good once, for ${CODE_TTL_MS / 60_000} minutes):`,
    `  http://${HOSTNAME}:${port}/#pair=${code}`,
    `or type the code on the page: ${showCode(code)}`,
    ...remote,
  ].join("\n")
}

/** The paired browsers, one line each. */
export const listed = (paired: ReadonlyArray<Paired>): string =>
  Option.match(Arr.match(paired, { onEmpty: () => Option.none<string>(), onNonEmpty: () => Option.some("") }), {
    onNone: () => "No browser is paired.",
    onSome: () =>
      [
        `${paired.length} of at most ${MAX_PAIRED} browsers paired (unpair one with --revoke <id>, or all with --revoke all):`,
        ...paired.map((each) => `  ${each.id}  paired ${DateTime.formatIso(DateTime.makeUnsafe(each.created))}  ${each.label}`),
      ].join("\n"),
  })

/** Arguments that name no target. */
class Usage extends Schema.TaggedError<Usage>()("Usage", { message: Schema.String }) {}

const USAGE = "usage: bun cmd/digest/pair.ts [--dir <digest dir>] [--port <port>] | --list | --revoke <id>|all"

/** The target's work, said; the exit code, 0 once done (a revoke of no such browser is 1). */
export const main = (args: ReadonlyArray<string>, print: (text: string) => Effect.Effect<void>, tailnet: Effect.Effect<Tailnet> = probe) =>
  Effect.try({ try: () => targetOf(args), catch: (cause) => new Usage({ message: String(cause) }) }).pipe(
    Effect.flatMap((target) => Effect.mapError(Effect.fromOption(target), () => new Usage({ message: USAGE }))),
    Effect.flatMap((target) => {
      const pairing = FilePairing.make(target.dir)
      return Match.value(target).pipe(
        Match.when({ kind: "issue" }, (issue) => Effect.flatMap(Clock.currentTimeMillis, (now) => Effect.flatMap(pairing.issue(now), (code) => Effect.map(tailnet, (found) => [said(code, issue.port, found), 0] as const)))),
        Match.when({ kind: "list" }, () => Effect.map(pairing.list, (paired) => [listed(paired), 0] as const)),
        Match.when({ kind: "revoke" }, (revoke) =>
          Effect.map(pairing.revoke(revoke.which), (count) => [`Unpaired ${count} browser${"s".repeat(Number(count !== 1))}.`, Number(count === 0)] as const),
        ),
        Match.exhaustive,
      )
    }),
    Effect.flatMap(([text, code]) => Effect.as(print(text), code)),
    Effect.catch((error) => Effect.as(Effect.logError(`digest pair: ${error.message}`), 1)),
  )

if (import.meta.main) Effect.runFork(Effect.tap(main(Bun.argv.slice(2), Console.log), (code) => Effect.sync(() => void (process.exitCode = code))))
