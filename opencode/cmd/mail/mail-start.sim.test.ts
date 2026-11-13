// The mail listener from the plugin's start, on the simulated host, at 20
// seeds: tests/mail-start.test.ts's name and its claim on the listener, moved
// off a real service. The mail plugin (`cmd/mail/server.ts`'s `make`,
// sim/plugins.ts `mail`) loads with its `listen` option on a host already
// paired with the Mac, and nothing else happens on that host: no session, no
// client, no turn. Its listener records its address in the pairing, and a
// signed delivery from the paired Mac over the memory network is
// authenticated and handled: for a session this host lacks, `unknown`.
//
// What stays real (tests/mail-start.test.ts): that `opencode service start`,
// through the launcher daily writes, loads the resident location, so the
// plugin starts with the service.
import { describe } from "bun:test"
import { Effect, Schema } from "effect"
import * as MemoryNet from "@dotfiles/opencode-mail/memory/net"
import * as MemoryPairs from "@dotfiles/opencode-mail/memory/pairs"
import { keyed } from "@dotfiles/opencode-mail/node/keyed"
import { sign } from "@dotfiles/opencode-mail/pairing"
import { ROUTES } from "@dotfiles/opencode-mail/peer"
import * as Hosts from "../../sim/hosts.ts"
import * as Plugins from "../../sim/plugins.ts"
import * as Seed from "../../sim/seed.ts"
import * as World from "../../sim/world.ts"

const { seeded } = Seed.runner("cmd/mail/mail-start.sim.test.ts")

const ADDRESS = { workbox: "100.64.0.2", mac: "100.64.0.1" }
/** The secret the pairing left on both hosts. */
const SECRET = "s".repeat(43)

const Answer = Schema.fromJsonString(Schema.Unknown)

describe("the mail listener from the service's start", () => {
  seeded("a fresh service, with no client, session or turn, accepts a signed delivery from a paired host", ({ seed, expect }) =>
    Effect.gen(function* () {
      const world = World.make({ seed, script: () => World.say("") })
      const network = MemoryNet.make({ latency: Effect.sleep("5 millis") })
      const pairs = MemoryPairs.make({ name: "workbox", peers: { mac: { url: `http://${ADDRESS.mac}:9`, secret: SECRET, paired: world.now() } }, invites: [] })
      yield* world.load(Plugins.mail(network, pairs, ADDRESS.workbox), { directory: "/home/resident", options: { listen: { hostname: ADDRESS.workbox, port: 0 } } })

      // Nothing else asks the host anything.
      yield* world.until(() => typeof pairs.read().url === "string", 60_000, 10)
      const url = pairs.read().url ?? ""
      const body = JSON.stringify({ to: "ses_nobody", from: { id: "ses_mac", title: "Mac main" }, replyTo: { id: "ses_mac", title: "Mac main" }, body: "hello", wake: false })
      const headers = sign("mac", SECRET, { method: "POST", path: ROUTES.receive, body }, world.now(), "n".repeat(22), keyed)
      const response = yield* Hosts.run(world, network.net(ADDRESS.mac).post(new URL(ROUTES.receive, url).href, { headers, body }, 10_000))
      // Authenticated and handled: a session this server lacks is `unknown`, not a refusal.
      expect([response.status, Schema.decodeUnknownSync(Answer)(response.body)]).toEqual([200, { outcome: "unknown" }])
      expect(world.sessions.size).toBe(0)
    }),
  )
})
