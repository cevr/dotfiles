// One process of the two-process refresh race: resolve one store account
// through the pool's login store source and print a fingerprint of the token it got
// (never the token). When requested, record that it found the other worker's
// real SQLite lock busy before the test allows the refresh response.
import { createHash } from "node:crypto"
import { argv, write } from "bun"
import { Effect, Option, Schema } from "effect"
import { SlotStoreSource } from "../../mods/pool/store/store.ts"
import { readScratchFileSync, scratchInput } from "../read-path.ts"
import { RefreshRequest } from "./refresh-request.ts"
import { scratchSlotFiles } from "./store.ts"

const { dir, tokenURL, credentialID, busyFile } = Schema.decodeUnknownSync(RefreshRequest)(readScratchFileSync(argv[2] || "", "utf8"))
if (!/^http:\/\/127\.0\.0\.1:\d{1,5}\/v1\/oauth\/token$/.test(tokenURL)) throw new Error("expected the scratch store's loopback token endpoint")
const marker = scratchInput(busyFile)
const source = new SlotStoreSource({
  dir: scratchInput(dir), tokenURL,
  files: {
    ...scratchSlotFiles,
    tryLock: (at) => scratchSlotFiles.tryLock(at).pipe(Effect.tap((lock) => {
      if (Option.isNone(lock)) return Effect.asVoid(Effect.promise(() => write(marker, "")))
      return Effect.void
    })),
  },
})
const resolved = await source.resolve(credentialID)
console.log(createHash("sha256").update(resolved.access).digest("hex").slice(0, 16))
