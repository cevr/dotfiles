import { argv, env } from "bun"
import * as BunRuntime from "@effect/platform-bun/BunRuntime"
import { Effect, FileSystem, Option, Schema } from "effect"
import { runProcessMain } from "../../cmd/guard/host-admit.ts"
import { AdmissionUnavailable } from "../../mods/guard/admission.ts"
import { POLICY } from "../../mods/guard/host-supply.ts"
import { supply } from "../../mods/guard/memory/admission-acceptance.ts"
import { clockOf } from "../../mods/guard/process/admission.ts"
import { superviseAdmitted } from "../../mods/wake/process/supervise.ts"

const script = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Struct({
  outside: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 12000 })),
})))
const broken = () => new AdmissionUnavailable({ reason: "unavailable" })

// This executable is under tests, absent from the command registry and
// shipped trees. No environment variable can select this port in host-admit.
const arguments_ = argv.slice(2)
const [mode, job] = arguments_
if (mode === "wake" && job) {
  BunRuntime.runMain(Effect.promise(() => superviseAdmitted(job, argv.slice(0, 2))))
} else {
  let beforeResume = Effect.void
  if (env.HCL_PAUSE_RESUME === "true") beforeResume = Effect.never
  runProcessMain(arguments_, {
    beforeResume,
    sample: Effect.fn("HostAdmitFixture.sample")(function* (host, target) {
      if (Option.isNone(target)) return yield* broken()
      const fs = yield* FileSystem.FileSystem
      const input = yield* fs.readFileString(`${env.HOME}/host-admit-supply.json`).pipe(Effect.flatMap(script), Effect.mapError(broken))
      const now = yield* clockOf(host)
      const defaultSupply = supply({ cores: 12, now })
      const id = target.value
      const volume = { capacityBytes: 64 * 2 ** 30, freeBytes: 32 * 2 ** 30, freeInodes: "dynamic" as const,
        metadataFreeBytes: 2 ** 30, diskFloorBytes: POLICY.diskFloorBytes }
      const envelope = { ...defaultSupply.envelope, volumes: { [id]: volume.capacityBytes - volume.diskFloorBytes } }
      return { now, envelope, sample: { ...defaultSupply.sample, qualification: "advisory" as const,
        outsideNoncriticalMilli: input.outside, volumes: { [id]: volume }, envelope } }
    }),
  })
}
