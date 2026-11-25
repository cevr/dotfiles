// `bun cmd/pool/antigravity-read.ts [--consent] [--profile <dir>] [--business]`:
// one read of Antigravity's quota on this host, as the pool's source makes it,
// printed as the pool's rows (each group, its 5-hour and weekly windows' use
// and reset, the groups Antigravity reported). It prints no token, no account
// and no response body. `--consent` records the owner's consent for the
// keychain in the pool's state file (`$XDG_STATE_HOME/opencode-pool/antigravity.json`,
// the one the pool reads) and reads at once: on macOS that read may show the
// keychain's dialog once. Without it, only the profile's token files are
// read, and only when a read is due (at most once per 5 minutes).
import * as BunRuntime from "@effect/platform-bun/BunRuntime"
import * as BunServices from "@effect/platform-bun/BunServices"
import { argv } from "bun"
import { Array as Arr, Config, Console, Effect, Match, Option } from "effect"
import { defaultProfile, liveSource } from "@dotfiles/opencode-pool/antigravity/live"
import type { AuthMethod } from "@dotfiles/opencode-pool/antigravity/reader"

const flag = (name: string) => argv.includes(name)
const valueOf = (name: string) => Option.flatMap(Arr.findFirstIndex(argv, (arg) => arg === name), (index) => Arr.get(argv, index + 1))

BunRuntime.runMain(
  Effect.gen(function* () {
    const home = yield* Config.String("HOME")
    const state = yield* Config.String("XDG_STATE_HOME").pipe(Config.withDefault(`${home}/.local/state`))
    const source = yield* liveSource({
      profile: Option.getOrElse(valueOf("--profile"), () => defaultProfile(home)),
      stateFile: `${state}/opencode-pool/antigravity.json`,
      auth: Match.value(flag("--business")).pipe(Match.when(true, (): AuthMethod => "business"), Match.orElse((): AuthMethod => "personal")),
      keychain: "ask",
    })
    if (flag("--consent")) yield* source.retry
    yield* source.refresh
    yield* Console.log((yield* source.lines).join("\n"))
  }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
)
