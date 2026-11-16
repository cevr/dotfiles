// This host's browser: `open` on a Mac, `xdg-open` elsewhere when a desktop
// has it. A host with neither (the workbox) fails, and the pane says the
// address instead, so the owner opens it where he sits.
import { Effect, Layer, Option } from "effect"
import { OpenFailed, Opener } from "../service.ts"

/** The program that opens a web address on `platform`, if this host has one. */
export const openerOf = (platform: string, which: (name: string) => Option.Option<string>): Option.Option<string> =>
  Option.match(Option.liftPredicate(platform, (name) => name === "darwin"), { onSome: () => Option.some("open"), onNone: () => which("xdg-open") })

export const layer = (platform: string) =>
  Layer.sync(Opener, () => {
    const program = openerOf(platform, (name) => Option.fromNullishOr(Bun.which(name)))
    return Opener.of({
      open: Effect.fn("ProcessOpener.open")(function* (url: string) {
        const opener = yield* Option.match(program, { onNone: () => Effect.fail(new OpenFailed({ message: `no browser on this host: open ${url}` })), onSome: Effect.succeed })
        const code = yield* Effect.tryPromise({
          try: () => Bun.spawn([opener, url], { stdin: "ignore", stdout: "ignore", stderr: "ignore" }).exited,
          catch: (cause) => new OpenFailed({ message: `${opener}: ${String(cause)}` }),
        })
        if (code !== 0) return yield* new OpenFailed({ message: `${opener} exited ${code}: open ${url}` })
      }),
    })
  })
