// gent's own credential store over a temporary directory, loaded from gent's
// sources (read-only): the tests make their fixtures with it, refresh as gent
// does under gent's real lock, and decode what the pool wrote with gent's
// decoder. Every token is a fake the test drew.
import { existsSync } from "node:fs"
import { join, resolve } from "node:path"

/** gent's checkout: `GENT_SOURCE`, else beside this repository. */
export const gentSource = (): string =>
  resolve(process.env.GENT_SOURCE || join(import.meta.dir, "../../../gent"))

const core = () => join(gentSource(), "packages/core")

export const gentAvailable = (): boolean => existsSync(join(core(), "src/runtime/provider.ts"))

export interface Tokens {
  readonly access: string
  readonly refresh: string
  readonly expires: number
}

/** A sign-in as gent's decoder reads it. */
export interface Decoded {
  readonly _tag: string
  readonly type: string
  readonly access: string
  readonly refresh: string
  readonly expires: number
  readonly accountId?: string
  readonly metadata?: Readonly<Record<string, string>>
  readonly signedInAt?: number
}

export interface GentStore {
  /** Sign `label` in as gent does: owned by gent unless `metadata` says otherwise. */
  readonly signIn: (
    label: string | undefined,
    tokens: Tokens,
    options?: { metadata?: Record<string, string>; signedInAt?: number },
  ) => Promise<void>
  /**
   * What gent's Anthropic driver does when it refreshes an account it owns,
   * under gent's lock: `next` is written as `toProviderAuthInfo`'s update
   * writes it (no account id, the metadata kept, the stamp kept); `next`
   * answering `undefined` writes nothing, as gent does when it finds the
   * stored token fresh. `holdMs` keeps the lock that long first, as a
   * refresh in flight does.
   */
  readonly refresh: (
    label: string,
    next: (current: Decoded | undefined) => Tokens | undefined,
    holdMs?: number,
  ) => Promise<void>
  /** The label's sign-in, read by gent's decoder. */
  readonly get: (label: string) => Promise<Decoded | undefined>
  /** The labels gent lists for Anthropic. */
  readonly slots: () => Promise<ReadonlyArray<string>>
}

export const openGentStore = async (dir: string): Promise<GentStore> => {
  const base = core()
  const { Auth, AuthInfo } = await import(join(base, "src/runtime/provider.ts"))
  const { BunProviderLockLive } = await import(join(base, "src/runtime/gent-platform-bun.ts"))
  const { Effect, Layer, Option } = await import(Bun.resolveSync("effect", base))
  const { BunServices } = await import(Bun.resolveSync("@effect/platform-bun", base))
  const layer = Auth.Live(dir).pipe(Layer.provide(BunProviderLockLive), Layer.provide(BunServices.layer))
  // biome-ignore lint: gent's Effect types are not this repository's.
  const run = <A>(program: any): Promise<A> => Effect.runPromise(Effect.provide(program, layer))
  const withAuth = <A>(use: (auth: any) => any): Promise<A> =>
    run(
      Effect.gen(function* () {
        const auth = yield* Auth
        return yield* use(auth)
      }),
    )

  return {
    signIn: (label, tokens, options = {}) =>
      withAuth((auth) =>
        auth.set(
          "anthropic",
          AuthInfo.cases.Oauth.make({
            type: "oauth",
            ...tokens,
            metadata: options.metadata ?? { owner: "gent" },
            ...(options.signedInAt === undefined ? {} : { signedInAt: options.signedInAt }),
          }),
          label,
        ),
      ),
    refresh: (label, next, holdMs = 0) =>
      withAuth((auth) =>
        auth.update(
          "anthropic",
          (current: any) =>
            Effect.sleep(holdMs).pipe(
              Effect.map(() => {
                const held = Option.getOrUndefined(current) as Decoded | undefined
                const tokens = next(held)
                if (tokens === undefined) return [undefined, Option.none()] as const
                return [
                  undefined,
                  Option.some(
                    AuthInfo.cases.Oauth.make({
                      type: "oauth",
                      ...tokens,
                      accountId: undefined,
                      ...(held?.metadata === undefined ? {} : { metadata: held.metadata }),
                    }),
                  ),
                ] as const
              }),
            ),
          label,
        ),
      ),
    get: (label) => withAuth<Decoded | undefined>((auth) => auth.get("anthropic", label)),
    slots: () => withAuth<ReadonlyArray<string>>((auth) => auth.listSlots("anthropic")),
  }
}
