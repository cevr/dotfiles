// One process of the two-process refresh race: resolve one store account
// through the pool's login store source and print a fingerprint of the token it got
// (never the token) and when it asked (epoch ms).
import { createHash } from "node:crypto"
import { argv } from "bun"
import { Schema } from "effect"
import { SlotStoreSource } from "../../mods/pool/store/store.ts"
import { readScratchFileSync, scratchInput } from "../read-path.ts"
import { RefreshRequest } from "./refresh-request.ts"
import { scratchSlotFiles } from "./store.ts"

const { dir, tokenURL, credentialID } = Schema.decodeUnknownSync(RefreshRequest)(readScratchFileSync(argv[2] || "", "utf8"))
if (!/^http:\/\/127\.0\.0\.1:\d{1,5}\/v1\/oauth\/token$/.test(tokenURL)) throw new Error("expected the scratch store's loopback token endpoint")
const source = new SlotStoreSource({ dir: scratchInput(dir), tokenURL, files: scratchSlotFiles })
const began = Date.now()
const resolved = await source.resolve(credentialID)
console.log(`${createHash("sha256").update(resolved.access).digest("hex").slice(0, 16)} ${began}`)
