// The keepalive's admission over the pool's `pace` RPC, asked as a request's
// dispatch (`dispatch: true`): a ping is a request of its model on its login,
// so it goes out only when the pool would place that request on that login
// now. A ping the pool placed no login for (an unpooled provider), or on a
// host where no plugin answers the pool's RPC, needs no answer and goes out.
// A pooled one goes out only on a measured answer that admits it on its login
// (an older pool, which names no eligible logins, admits by its `ok`), or on
// an unmeasured one, as the pool's own request boundary does; a failure, a
// timeout or an answer that is not a pace skips the ping, which only lets the
// cache go cold.
import { Pace } from "@dotfiles/opencode-pool/pace"
import { POOL_STATUS } from "@dotfiles/opencode-pool/status"
import { Effect, Layer, Option, Schema } from "effect"
import { PingAdmission } from "../service.ts"

/** The pool's RPC, whose `pace` the composition root asks. */
export const POOL = POOL_STATUS

/** The pool's `pace` method, as the plugin's RPC client calls it. */
export type Ask = (input: { readonly providerID: string; readonly model: string; readonly dispatch: true }) => Effect.Effect<unknown, unknown>

/** How long the pool has to answer, well inside the ping's interval. */
const TIMEOUT = "8 seconds"

const decode = Schema.decodeUnknownOption(Pace)

/** The host's RPC failures that mean no plugin answers the method: no pool is loaded. */
const ABSENT = new Set(["rpc.unavailable", "rpc.method_not_found"])
const decodeFailure = Schema.decodeUnknownOption(Schema.Struct({ type: Schema.String }))

/** Whether a pace answer admits a request on `login`. */
export const admitted = (pace: Pace, login: string): boolean => {
  if (!pace.measured) return true
  if (!pace.ok) return false
  return Option.match(Option.fromUndefinedOr(pace.eligible), { onNone: () => true, onSome: (eligible) => eligible.includes(login) })
}

/** A ping of `model` (`provider/id`) on `login`, asked of the pool. */
const asked = (ask: Ask, model: string, login: string) => {
  const slash = model.indexOf("/")
  if (slash <= 0) return Effect.succeed(false)
  return ask({ providerID: model.slice(0, slash), model: model.slice(slash + 1), dispatch: true }).pipe(
    Effect.timeoutOption(TIMEOUT),
    Effect.map((reply) => Option.exists(Option.flatMap(reply, decode), (pace) => admitted(pace, login))),
    // No plugin answers the pool's RPC: no pool on this host decides a login, as for an unpooled provider.
    Effect.catch((error) => Effect.succeed(Option.exists(decodeFailure(error), (failure) => ABSENT.has(failure.type)))),
  )
}

export const layer = (ask: Ask) =>
  Layer.succeed(
    PingAdmission,
    PingAdmission.of({
      admits: (ping) =>
        Option.match(ping.login, { onNone: () => Effect.succeed(true), onSome: (login) => asked(ask, ping.model, login) }).pipe(
          Effect.catchCause(() => Effect.succeed(false)),
          Effect.withSpan("PingAdmission.admits"),
        ),
    }),
  )
