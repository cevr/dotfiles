// The real network between paired hosts (Bun's server and fetch) keeps the
// network laws, on loopback.
import { Effect } from "effect"
import { HOST, netLaws } from "./net-laws.ts"
import { realNet } from "./peers.ts"

netLaws("the real network on loopback", Effect.succeed({ net: realNet, from: HOST }))
