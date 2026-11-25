// `bun cmd/pool/antigravity-read.ts [--profile <dir>] [--business [--consent]]`:
// one read of Antigravity's quota on this host, as the pool's source makes it,
// printed as the pool's rows (each group, its 5-hour and weekly windows' use
// and reset, the groups Antigravity reported). It prints no token, no account
// and no response body. It reads through the same authority, state file and lock
// as the pool (`$XDG_STATE_HOME/opencode-pool/antigravity.json`), so it keeps the
// same floor: no read within 5 minutes of the last attempt, whoever made it.
// A personal sign-in is read from the managed profile's token files alone
// (default `$XDG_STATE_HOME/opencode-pool/antigravity/profiles/default`), never
// from ~/.gemini or the keychain. `--consent`, for a business sign-in only, is
// the owner's consent to ONE keychain attempt, used by this read when no token
// file reads (on macOS it may show the keychain's dialog once).
//
// `bun cmd/pool/antigravity-read.ts --profile-env [<dir>]` reads nothing: it
// makes the managed profile for a personal sign-in as T3 Code makes one
// (profile.ts: 0700 directories, settings.json, links into ~/.gemini), writes
// the environment agy runs with there to `<dir>.env` (0600, no secret) and
// prints that path, the one line that signs agy in on it, and how an agy pane
// runs on it.
import * as BunRuntime from "@effect/platform-bun/BunRuntime"
import * as BunServices from "@effect/platform-bun/BunServices"
import { argv } from "bun"
import { Array as Arr, Config, Console, Effect, Layer, Match, Option } from "effect"
import { FetchHttpClient } from "effect/http"
import { defaultProfile, liveSource, prepareProfile } from "@dotfiles/opencode-pool/antigravity/live"
import { managedProfile, PaneLaunch, paneLaunch } from "@dotfiles/opencode-pool/antigravity/profile"
import type { AuthMethod } from "@dotfiles/opencode-pool/antigravity/reader"

const flag = (name: string) => argv.includes(name)
const valueOf = (name: string) =>
  Option.flatMap(Arr.findFirstIndex(argv, (arg) => arg === name), (index) => Option.filter(Arr.get(argv, index + 1), (value) => !value.startsWith("--")))

BunRuntime.runMain(
  Effect.gen(function* () {
    const home = yield* Config.String("HOME")
    const state = yield* Config.String("XDG_STATE_HOME").pipe(Config.withDefault(`${home}/.local/state`))
    const auth = Match.value(flag("--business")).pipe(Match.when(true, (): AuthMethod => "business"), Match.orElse((): AuthMethod => "personal"))
    const named = Option.orElse(valueOf("--profile-env"), () => valueOf("--profile"))
    const profile = Option.getOrElse(named, () => defaultProfile(state))
    if (flag("--profile-env")) {
      // T3 signs only a personal account in with `--login` (Drivers/AntigravityDriver.ts 427); a business one reads the keychain.
      if (auth === "business") return yield* Console.error("--profile-env makes a profile for a personal sign-in only, as T3 does; a business sign-in is read from the keychain (--consent).")
      const managed = managedProfile(profile, home)
      const prepared = yield* prepareProfile(managed)
      const pane = PaneLaunch.match(paneLaunch(managed, "tui"), { Acp: ({ line }) => line, TokenPathUnknown: ({ why }) => why })
      yield* Console.log(
        [
          `Wrote ${prepared.envFile} and the profile ${managed.root}`,
          ...prepared.links.map(([link, outcome]) => `  ${link}: ${outcome}`),
          "Sign in on the managed profile with:",
          `  ${prepared.signIn}`,
          `agy panes: ${pane}`,
        ].join("\n"),
      )
      return
    }
    const source = yield* liveSource({ profile, stateFile: `${state}/opencode-pool/antigravity.json`, auth })
    const read = yield* source.read(flag("--consent"))
    yield* Console.log([read.note, ...read.lines].join("\n"))
  }).pipe(Effect.provide(Layer.mergeAll(BunServices.layer, FetchHttpClient.layer))),
)
