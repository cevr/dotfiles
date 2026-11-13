// The network between paired hosts, in memory: the double the simulated hosts
// use (sim/mail.ts), held to the real network's laws (http/net-laws.ts, run
// here by net.test.ts and on loopback by http/net.test.ts).
//
// One `Network` is the wire between every host on it; each host's `Net` is
// `network.layer(hostname)`, so a listener knows where a request came from. A
// listener answers on its own fibers, with the services it listened with (its
// clock, its logger, its plugin copy), in the scope it listened in: a request
// it is answering when that scope closes is cut off, and its sender sees the
// connection close. A request takes `latencyMs` each way, on the clock of the
// fiber that sends it.
//
// Faults, for a test to set: a host `cut` off the wire (what it sends and what
// is sent to it never arrives: its sender waits out its timeout), and a host
// whose answers are `lost` (its requests arrive and are answered, but the
// answer never reaches the sender, who waits out its timeout as it would on a
// real network).
import { type Context, Effect, Exit, Fiber, Layer, Option, Scope } from "effect"
import { type Address, Net, NetFailed, type Received, type Wire } from "../service.ts"

interface Listening {
  readonly answer: (request: Received) => Effect.Effect<Wire>
  readonly context: Context.Context<never>
  readonly scope: Scope.Scope
}

/** A request as it went over the wire: from which host, to which URL, with its headers and body. */
export interface Sent {
  readonly from: string
  readonly url: string
  readonly headers: Readonly<Record<string, string>>
  readonly body: string
}

/** The lowest port a listener on port 0 is given, as an operating system's ephemeral range starts. */
export const FIRST_FREE_PORT = 49_152

/** A request URL's listener key (`hostname:port`) and path; none for a URL that does not parse. */
const target = (url: string) =>
  Option.liftThrowable(() => new URL(url))().pipe(Option.map((parsed) => ({ key: `${parsed.hostname}:${parsed.port}`, path: parsed.pathname })))

/** A request's header, as the fetch API reads one: by its name in any case. */
const headerOf = (headers: Readonly<Record<string, string>>) => (name: string) =>
  Option.getOrUndefined(Option.map(Option.fromNullishOr(Object.entries(headers).find(([key]) => key.toLowerCase() === name.toLowerCase())), ([, value]) => value))

export const make = (options: { readonly latencyMs?: number } = {}) => {
  const latency = Effect.sleep(Option.getOrElse(Option.fromNullishOr(options.latencyMs), () => 0))
  const listening = new Map<string, Listening>()
  const cut = new Set<string>()
  const lost = new Set<string>()
  const sent: Array<Sent> = []
  const ports = { next: FIRST_FREE_PORT }

  const freePort = (hostname: string) => {
    while (listening.has(`${hostname}:${ports.next}`)) ports.next += 1
    ports.next += 1
    return ports.next - 1
  }

  const listen = (address: Address, answer: (request: Received) => Effect.Effect<Wire>) =>
    Effect.gen(function* () {
      const port = Option.getOrElse(
        Option.liftPredicate(address.port, (asked) => asked !== 0),
        () => freePort(address.hostname),
      )
      const key = `${address.hostname}:${port}`
      if (listening.has(key)) return yield* new NetFailed({ message: `${key}: the address is in use` })
      const context = yield* Effect.context<never>()
      const scope = yield* Scope.Scope
      yield* Effect.acquireRelease(
        Effect.sync(() => void listening.set(key, { answer, context, scope })),
        () => Effect.sync(() => void listening.delete(key)),
      )
      return port
    })

  /** Waits out the sender's timeout: what never arrives, or an answer lost on the way back. */
  const never = Effect.never

  const post = (from: string) => (url: string, request: { readonly headers: Readonly<Record<string, string>>; readonly body: string }, timeoutMs: number) =>
    Effect.gen(function* () {
      sent.push({ from, url, headers: request.headers, body: request.body })
      const to = yield* Effect.fromOption(target(url)).pipe(Effect.mapError(() => new NetFailed({ message: `${url} is not a URL` })))
      yield* latency
      if (cut.has(from) || cut.has(to.key.slice(0, to.key.lastIndexOf(":")))) return yield* never
      const found = yield* Effect.fromOption(Option.fromNullishOr(listening.get(to.key))).pipe(
        Effect.mapError(() => new NetFailed({ message: `Unable to connect: nothing listens at ${to.key}` })),
      )
      const received: Received = { method: "POST", path: to.path, body: request.body, header: headerOf(request.headers), address: from }
      const answering = yield* found.answer(received).pipe(Effect.provideContext(found.context), Effect.forkIn(found.scope))
      const exit = yield* Fiber.await(answering)
      const wire = yield* Exit.match(exit, {
        onSuccess: (answered): Effect.Effect<Wire, NetFailed> => Effect.succeed(answered),
        onFailure: () => Effect.fail(new NetFailed({ message: `the connection to ${to.key} closed before it answered` })),
      })
      yield* latency
      if (lost.has(to.key.slice(0, to.key.lastIndexOf(":")))) return yield* never
      return wire
    }).pipe(
      Effect.timeoutOrElse({
        duration: timeoutMs,
        orElse: () => Effect.fail(new NetFailed({ message: `${url}: no answer within ${timeoutMs} ms` })),
      }),
    )

  /** The network as `hostname` reaches it. */
  const net = (hostname: string) => Net.of({ listen, post: post(hostname) })

  return {
    net,
    layer: (hostname: string) => Layer.succeed(Net, net(hostname)),
    /** Every request sent so far, in order. */
    sent: (): ReadonlyArray<Sent> => sent,
    /** Whether a listener holds `hostname:port`. */
    listening: (hostname: string, port: number) => listening.has(`${hostname}:${port}`),
    /** Cuts `hostname` off the wire, or puts it back. */
    cut: (hostname: string, off: boolean) => {
      if (off) cut.add(hostname)
      else cut.delete(hostname)
    },
    /** Loses `hostname`'s answers on the way back, or stops losing them. */
    lose: (hostname: string, losing: boolean) => {
      if (losing) lost.add(hostname)
      else lost.delete(hostname)
    },
  }
}

export type Network = ReturnType<typeof make>
