/**
 * `digest devices`: key his agent machines and excluded devices in the device store, by Tailscale stable node ID,
 * once and by hand. The only way an ID enters or leaves the store (mods/digest/devices.ts): the installer and the
 * plugin never look a device up, so a rename, a lost file or another device taking a name never changes a key.
 *
 *   bun cmd/digest/devices.ts exclude <magicdns-name>          key a device of his to exclude (reads nothing unpaired)
 *   bun cmd/digest/devices.ts agent <magicdns-name>            key one of his agent machines (reads; pairs to write)
 *   bun cmd/digest/devices.ts exclude|agent <name> --id <ID>   add an ID with no name lookup (still one of his devices)
 *   bun cmd/digest/devices.ts forget exclude|agent <name>      remove the name and all its IDs (exit 1 if not there)
 *   bun cmd/digest/devices.ts list                             both copies, and which device each ID is now
 *   options: --dir <digest dir> (default the plugin's), --config <config home> (default $XDG_CONFIG_HOME),
 *            --cli <tailscale> (default the usual paths)
 *
 * - The lookup runs once, here: among the devices of this host's own Tailscale user only (never another user's, a
 *   tagged or a shared-in one), by MagicDNS name or its first label (never HostName). It prints the device (name,
 *   OS, last seen, ID) so a human confirms it is the right one, and writes its ID. None or several: nothing written.
 * - Every write (by name or by --id) is checked under the store's lock against a status read then (filestore/devices.ts
 *   change, devices.ts refusalOf): an added ID must be a device of his own user now. A typo, a colleague's ID, a device
 *   gone, or a status that does not read: exit 1, nothing written. A rerun or a removal adds nothing and needs no status.
 * - A name is keyed as the installer ships it: its first label, lower case (`lenovo-rescue.<tailnet>.ts.net.` keys
 *   `lenovo-rescue`), said when it differs.
 * - Run it on each host: each host's digest reads its own store. Loopback only: it writes local files, no route.
 */
import { parseArgs } from "node:util"
import { Array as Arr, Console, Effect, Match, Option, Schema } from "effect"
import * as TuiDirs from "@dotfiles/decider/tui-dirs"
import { type Copy, copyWord, nameKey, unionOf, withId, withoutName } from "@dotfiles/opencode-digest/devices"
import type { PeerStatus, StatusRead } from "@dotfiles/opencode-digest/bind"
import * as FileDevices from "@dotfiles/opencode-digest/filestore/devices"
import { carriesName, hisDevices } from "@dotfiles/opencode-digest/members"
import { CLIS, statusFrom } from "@dotfiles/opencode-digest/process/tailnet"

type Kind = "agents" | "excluded"
const KINDS = { exclude: "excluded", agent: "agents" } as const satisfies Record<string, Kind>

/** What the command does. */
export type Target =
  | { readonly kind: "key"; readonly list: Kind; readonly name: string; readonly id: Option.Option<string> }
  | { readonly kind: "forget"; readonly list: Kind; readonly name: string }
  | { readonly kind: "list" }

/** Where: the two copies, and the CLI to read the status with. */
export interface Place {
  readonly paths: readonly [string, string]
  readonly clis: ReadonlyArray<string>
}

class Usage extends Schema.TaggedError<Usage>()("Usage", { message: Schema.String }) {}

export const USAGE = "usage: bun cmd/digest/devices.ts exclude|agent <magicdns-name> [--id <ID>] | forget exclude|agent <name> | list   [--dir <digest dir>] [--config <config home>] [--cli <tailscale>]"

/** The target and place the arguments name; none for arguments that name none. */
export const targetOf = (args: ReadonlyArray<string>): Option.Option<readonly [Target, Place]> => {
  const { values, positionals } = parseArgs({ args: [...args], options: { dir: { type: "string" }, config: { type: "string" }, cli: { type: "string" }, id: { type: "string" } }, strict: true, allowPositionals: true })
  const dirs = TuiDirs.dirs()
  const place: Place = {
    paths: FileDevices.pathsOf(Option.getOrElse(Option.fromUndefinedOr(values.dir), () => `${dirs.state}/opencode-digest`), Option.getOrElse(Option.fromUndefinedOr(values.config), () => dirs.config)),
    clis: Option.match(Option.fromUndefinedOr(values.cli), { onNone: () => CLIS, onSome: (cli) => [cli] }),
  }
  const [verb = "", first = "", second = "", ...rest] = positionals
  const kindOf = (word: string): Option.Option<Kind> => Option.map(Option.liftPredicate(word, (each): each is keyof typeof KINDS => Object.hasOwn(KINDS, each)), (each) => KINDS[each])
  const target: Option.Option<Target> = Match.value(verb).pipe(
    Match.when("list", () => Option.liftPredicate<Target>({ kind: "list" }, () => first === "")),
    Match.when("forget", () => Option.map(Option.filter(kindOf(first), () => second !== "" && rest.length === 0), (list): Target => ({ kind: "forget", list, name: second }))),
    Match.orElse(() => Option.map(Option.filter(kindOf(verb), () => first !== "" && second === ""), (list): Target => ({ kind: "key", list, name: first, id: Option.filter(Option.fromUndefinedOr(values.id), (id) => id !== "") }))),
  )
  return Option.map(target, (each) => [each, place] as const)
}

/** One device, as a human confirms it. */
export const deviceLine = (peer: PeerStatus): string =>
  `${Option.getOrElse(peer.dnsName, () => "(no MagicDNS name)")}  ${Option.getOrElse(Option.liftPredicate(peer.os, (os) => os !== ""), () => "(OS unknown)")}  last seen ${Option.getOrElse(peer.lastSeen, () => "now or unknown")}  ID ${Option.getOrElse(peer.stableId, () => "(none)")}`

/** His devices in a status read; none when it did not read or Tailscale is not running. */
const hisIn = (read: StatusRead): ReadonlyArray<PeerStatus> =>
  Match.valueTags(read, { Read: ({ status }) => Arr.flatten(Option.toArray(Option.map(Option.liftPredicate(status, (each) => each.backendState === "Running"), hisDevices))), Unread: () => [] })

/** The store's two copies, and every entry with what each ID is among his devices now. */
export const listOf = (copies: readonly [Copy, Copy], paths: readonly [string, string], his: ReadonlyArray<PeerStatus>): string => {
  const union = unionOf(copies)
  const entries = (kind: Kind, label: string) =>
    union[kind].flatMap(({ name, ids }) => {
      return [`  ${label} ${name}: ${ids.length} ID(s)`, ...ids.map((id) => `    ${id}: ${Option.match(Option.fromUndefinedOr(his.find((peer) => Option.contains(peer.stableId, id))), { onNone: () => "no device of yours now", onSome: deviceLine })}`)]
    })
  return [`copy 1 ${paths[0]}: ${copyWord(copies[0])}`, `copy 2 ${paths[1]}: ${copyWord(copies[1])}`, ...entries("agents", "agent"), ...entries("excluded", "exclude")].join("\n")
}

/** The ID to key for `name`: the one device of his carrying it, said; none (with why) for none or several. */
export const lookedUp = (name: string, his: ReadonlyArray<PeerStatus>): readonly [Option.Option<string>, string] => {
  const found = his.filter((peer) => carriesName(name, peer))
  return Match.value(found.length).pipe(
    Match.when(0, () => [Option.none<string>(), [`No device of yours is named ${name}; nothing written. Your devices now:`, ...his.map((peer) => `  ${deviceLine(peer)}`)].join("\n")] as const),
    Match.when(1, () => [Option.flatMap(Option.fromUndefinedOr(found[0]), (peer) => peer.stableId), `Found: ${found.map(deviceLine).join("")}`] as const),
    Match.orElse(() => [Option.none<string>(), [`Several devices of yours answer to ${name}; nothing written. Key one with --id:`, ...found.map((peer) => `  ${deviceLine(peer)}`)].join("\n")] as const),
  )
}

/** The command's work, said through `print`; the exit code. */
export const main = (args: ReadonlyArray<string>, print: (text: string) => Effect.Effect<void>) =>
  Effect.try({ try: () => targetOf(args), catch: (cause) => new Usage({ message: `${String(cause)}\n${USAGE}` }) }).pipe(
    Effect.flatMap((target) => Effect.mapError(Effect.fromOption(target), () => new Usage({ message: USAGE }))),
    Effect.flatMap(([target, place]) =>
      Effect.gen(function* () {
        const his = hisIn(yield* statusFrom(place.clis))
        if (target.kind === "list") return [listOf(yield* FileDevices.readCopies(place.paths), place.paths, his), 0] as const
        // Every write checks its added IDs against a status read again under the store's lock (FileDevices.change).
        const fresh = statusFrom(place.clis)
        const name = nameKey(target.name)
        const as = Option.getOrElse(Option.liftPredicate(` (as ${name}, the form the installer ships)`, () => name !== target.name), () => "")
        if (target.kind === "forget") {
          yield* FileDevices.change(place.paths, fresh, (store) =>
            Effect.as(
              Effect.filterOrFail(Effect.succeed(store), (each) => each[target.list].some((entry) => nameKey(entry.name) === name), () => new FileDevices.StoreRefused({ message: `${name} is not in the store (${target.list}); nothing written` })),
              withoutName(store, target.list, name),
            ),
          )
          return [`Forgot ${name} (${target.list}) in both copies.`, 0] as const
        }
        const [id, said] = Option.match(target.id, {
          onSome: (given) => [Option.some(given), `Keying ID ${given} with no lookup: ${Option.match(Option.fromUndefinedOr(his.find((peer) => Option.contains(peer.stableId, given))), { onNone: () => "no device of yours has it now (refused below)", onSome: deviceLine })}.`] as const,
          onNone: () => lookedUp(target.name, his),
        })
        return yield* Option.match(id, {
          onNone: () => Effect.succeed([said, 1] as const),
          onSome: (key) =>
            Effect.as(FileDevices.change(place.paths, fresh, (store) => Effect.succeed(withId(store, target.list, name, key))), [`${said}\nKeyed ${name}${as} (${target.list}) as ${key} in both copies.`, 0] as const).pipe(
              Effect.tapError(() => print(said)),
            ),
        })
      }),
    ),
    Effect.flatMap(([text, code]) => Effect.as(print(text), code)),
    Effect.catch((error) => Effect.as(Effect.logError(`digest devices: ${error.message}`), 1)),
  )

if (import.meta.main) Effect.runFork(Effect.tap(main(Bun.argv.slice(2), Console.log), (code) => Effect.sync(() => void (process.exitCode = code))))
