// The programs on PATH, as Bun finds them: an executable file by that name in
// one of `env.PATH`'s directories.
import { Effect, Layer } from "effect"
import { Programs } from "../service.ts"

type Env = Readonly<Record<string, string | undefined>>

/** The programs on `env`'s PATH, looked up again on every call so a program installed later is found. */
export const layer = (env: Env = process.env) =>
  Layer.succeed(
    Programs,
    Programs.of({ found: (name: string) => Effect.sync(() => Bun.which(name, { PATH: env.PATH ?? "" }) !== null) }),
  )
