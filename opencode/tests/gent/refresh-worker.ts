// One process of the two-process refresh race: resolve one gent account
// through the pool's gent source and print a fingerprint of the token it got
// (never the token) and when it asked (epoch ms).
import { createHash } from "node:crypto"
import { GentSource } from "../../mods/pool/src/gent.ts"

const [dir, tokenURL, credentialID] = process.argv.slice(2)
if (!dir || !tokenURL || !credentialID) throw new Error("usage: refresh-worker <dir> <tokenURL> <credentialID>")
const source = new GentSource({ dir, tokenURL })
const began = Date.now()
const resolved = await source.resolve(credentialID)
console.log(`${createHash("sha256").update(resolved.access).digest("hex").slice(0, 16)} ${began}`)
