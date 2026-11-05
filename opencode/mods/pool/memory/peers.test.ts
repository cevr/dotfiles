import { peersLaws } from "../laws.ts"
import * as MemoryPeers from "./peers.ts"

peersLaws("memory Peers", (world) => MemoryPeers.layer(new Map(world.map(({ name, answer }) => [name, answer]))))
