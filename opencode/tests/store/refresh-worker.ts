// One process of the two-process refresh race: resolve one store account
// through the pool's login store source and print a fingerprint of the token it got
// (never the token). When requested, record that it found the other worker's
// real SQLite lock busy before the test allows the refresh response.
import { createHash } from "node:crypto"
import { Effect, Option } from "effect"
import { NODE_FILES, StoreSource } from "../../mods/pool/store/store.ts"

const [dir, tokenURL, credentialID, busyFile] = process.argv.slice(2)
if (!dir || !tokenURL || !credentialID || !busyFile) throw new Error("usage: refresh-worker <dir> <tokenURL> <credentialID> <busy-file>")
const source = new StoreSource({
  dir,
  tokenURL,
  files: {
    ...NODE_FILES,
    tryLock: (dir) => NODE_FILES.tryLock(dir).pipe(Effect.tap((lock) => {
      if (Option.isNone(lock)) return Effect.promise(() => Bun.write(busyFile, ""))
      return Effect.void
    })),
  },
})
const resolved = await source.resolve(credentialID)
console.log(createHash("sha256").update(resolved.access).digest("hex").slice(0, 16))
