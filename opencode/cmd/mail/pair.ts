/**
 * Pair this host's session mail with another host's, once, so their sessions
 * can write to each other (`@dotfiles/opencode-mail/pairing`). Both hosts run
 * the mail plugin with its `listen` option; the inviter's listener must be up.
 *
 *   bun cmd/mail/pair.ts invite [--name <this host's mail name>]
 *     Prints a one-time code, good for ten minutes, and the join command to
 *     run on the other host.
 *   bun cmd/mail/pair.ts join <inviter's url> <code> [--name <this host's mail name>]
 *     Pairs with the inviter: both hosts keep each other's name, address and
 *     a fresh shared secret.
 *   bun cmd/mail/pair.ts list
 *     The paired hosts, by name and address (never the secret).
 *   bun cmd/mail/pair.ts forget <name>
 *     Drops a peer on this host (run it on both to unpair).
 *
 * A host's mail name defaults to its host name (lower case, without
 * `.local`) and is fixed at its first pairing. The state is
 * `$XDG_STATE_HOME/opencode-mail/pairs.json` (0600).
 */
import { hostname } from "node:os"
import { Clock, Effect, Layer, Option, Schema } from "effect"
import * as FilePairs from "@dotfiles/opencode-mail/filestore/pairs"
import * as HttpPeers from "@dotfiles/opencode-mail/http/peers"
import { keyed, tokens } from "@dotfiles/opencode-mail/node/keyed"
import { INVITE_MS, invited, joined, validName } from "@dotfiles/opencode-mail/pairing"
import { PairAnswer, ROUTES } from "@dotfiles/opencode-mail/peer"
import { Net, PairStore, Tokens } from "@dotfiles/opencode-mail/service"

/** How long the inviter's listener has to answer a join. */
export const JOIN_TIMEOUT_MS = 10_000

/** This host's default mail name. */
export const defaultName = (): string => hostname().toLowerCase().replace(/\.local$/, "")

const flag = (args: ReadonlyArray<string>, name: string): string | undefined => {
  const at = args.indexOf(name)
  return at === -1 ? undefined : args[at + 1]
}

/**
 * The arguments without `--name` and its value, the one flag. A code is base64url, so
 * it may itself start with `-` or `--`: only the flag's own spelling is a flag.
 */
const positional = (args: ReadonlyArray<string>): ReadonlyArray<string> =>
  args.filter((arg, index) => arg !== "--name" && !(index > 0 && args[index - 1] === "--name"))

/** What a run prints, or why it failed. */
export type Outcome = { readonly ok: true; readonly out: string } | { readonly ok: false; readonly error: string }

const failed = (error: string): Outcome => ({ ok: false, error })

/** The pair command on `args`, against the pairing store it is given. */
export const pair = (args: ReadonlyArray<string>, script = import.meta.path) =>
  Effect.gen(function* () {
    const store = yield* PairStore
    const [command, ...rest] = positional(args)
    const named = flag(args, "--name")
    if (named !== undefined && !validName(named)) return failed(`${JSON.stringify(named)} is not a mail name (letters, digits, ., _ and -)`)

    if (command === "invite") {
      const pairs = yield* store.read
      if (pairs.url === undefined) return failed("No mail listener has run on this host: set the mail plugin's `listen` option and restart OpenCode.")
      const code = yield* (yield* Tokens).token(18)
      const name = pairs.name ?? named ?? defaultName()
      const now = yield* Clock.currentTimeMillis
      yield* store.update((current) => [undefined, invited(current, name, code, now, keyed)])
      return {
        ok: true,
        out: [
          `This host is ${name}, listening at ${pairs.url}.`,
          `On the other host, within ${INVITE_MS / 60_000} minutes, run:`,
          `  bun ${script} join ${pairs.url} ${code}`,
        ].join("\n"),
      } satisfies Outcome
    }

    if (command === "join") {
      const [url, code] = rest
      if (url === undefined || code === undefined) return failed("Usage: pair.ts join <url> <code> [--name <name>]")
      const pairs = yield* store.read
      if (pairs.url === undefined) return failed("No mail listener has run on this host, so the other host could not answer it: set the mail plugin's `listen` option and restart OpenCode.")
      const self = pairs.name ?? named ?? defaultName()
      const net = yield* Net
      const body = JSON.stringify({ code, name: self, url: pairs.url })
      const reply = yield* Effect.try(() => new URL(ROUTES.pair, url).href).pipe(
        Effect.flatMap((target) => net.post(target, { headers: {}, body }, JOIN_TIMEOUT_MS)),
        Effect.orElseSucceed(() => undefined),
      )
      if (reply === undefined) return failed(`${url} did not answer.`)
      if (reply.status !== 200) return failed(`${url} refused: ${reply.body.trim()}`)
      const answer = Schema.decodeUnknownOption(Schema.fromJsonString(PairAnswer))(reply.body)
      if (Option.isNone(answer)) return failed(`${url} answered something that is not a pairing.`)
      const now = yield* Clock.currentTimeMillis
      yield* store.update((current) => [undefined, joined(current, self, { name: answer.value.name, url, secret: answer.value.secret }, now)])
      return { ok: true, out: `Paired: this host is ${self}; ${answer.value.name} is at ${url}.` } satisfies Outcome
    }

    if (command === "list") {
      const pairs = yield* store.read
      const peers = Object.entries(pairs.peers).toSorted(([left], [right]) => left.localeCompare(right))
      return {
        ok: true,
        out: [
          `This host: ${pairs.name ?? "(not named yet)"}${pairs.url === undefined ? "" : ` at ${pairs.url}`}`,
          ...(peers.length === 0 ? ["No paired hosts."] : peers.map(([name, peer]) => `${name} at ${peer.url}, paired ${new Date(peer.paired).toISOString()}`)),
        ].join("\n"),
      } satisfies Outcome
    }

    if (command === "forget") {
      const [name] = rest
      if (name === undefined) return failed("Usage: pair.ts forget <name>")
      const gone = yield* store.update((current) => {
        if (!Object.hasOwn(current.peers, name)) return [false, current]
        const { [name]: _dropped, ...peers } = current.peers
        return [true, { ...current, peers }]
      })
      return gone ? ({ ok: true, out: `Forgot ${name}.` } satisfies Outcome) : failed(`${name} is not paired with this host.`)
    }

    return failed("Usage: pair.ts invite | join <url> <code> | list | forget <name>  [--name <name>]")
  })

if (import.meta.main) {
  const outcome = await Effect.runPromise(
    pair(process.argv.slice(2)).pipe(
      Effect.provide(Layer.mergeAll(FilePairs.layer(FilePairs.fileOf(process.env)), HttpPeers.liveNet, tokens)),
      Effect.catch((failure) => Effect.succeed(failed(failure.message))),
    ),
  )
  if (outcome.ok) console.log(outcome.out)
  else {
    console.error(outcome.error)
    process.exitCode = 1
  }
}
