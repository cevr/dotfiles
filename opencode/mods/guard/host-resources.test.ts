import { expect, test } from "bun:test"
import { Option, Result, Schema } from "effect"
import { canonicalHolder, Holder, holderOf, NO_PROOF, storageCharges, trustedObservation, UNKNOWN_OWNER, UNKNOWN_USAGE } from "./host-resources.ts"

const decode = Schema.decodeUnknownSync(Holder)
const validate = Schema.decodeUnknownResult(Holder)
const without = (record: Readonly<Record<string, Schema.Json>>, omit: string) =>
  Object.fromEntries(Object.entries(record).filter(([name]) => name !== omit))

const disk = holderOf({
  version: 1, hostId: "fixture-host", bootId: "fixture-boot", resourceId: "fixture-resource",
  incarnation: "fixture-generation", holderId: "fixture-observation", revision: Option.none(),
  kind: "cache", owner: UNKNOWN_OWNER, relation: "observation", parentResourceId: Option.none(), dependsOn: [],
  placement: { volumeId: Option.some("fixture-volume"), objectRef: Option.some("fixture-object"), confinementRef: Option.none() },
  lease: Option.none(), usage: {
    ...UNKNOWN_USAGE, allocatedBytes: Option.some(8192), sharedBytes: Option.some(4096), extentGroupRef: Option.some("fixture-extent"),
  },
  observedAtMs: 100, sampleBootMs: 10, lastUseAtMs: Option.none(), coverage: "partial",
  state: "unknown", proof: NO_PROOF, protection: "unknown", producerId: "scanner-fixture", producerSeq: 1,
})

test("canonical bytes are unchanged by order, duplicate set entries or additive non-authoritative metadata", () => {
  const port = { transport: "tcp", endpointRef: "endpoint-fixture", port: 4310 } as const
  const unordered = { ...disk, dependsOn: ["b", "a", "b"], usage: { ...disk.usage, ports: [port, port] } }
  const sorted = { ...unordered, dependsOn: ["a", "b"], usage: { ...unordered.usage, ports: [port] } }
  expect(canonicalHolder(unordered)).toBe(canonicalHolder(sorted))
  const extended = decode({ ...disk, rolloutNote: "not authority", owner: { ...disk.owner, permitted: true } })
  expect(canonicalHolder(extended)).toBe(canonicalHolder(disk))
})

test("v1 readers refuse missing required fields, incompatible versions, and unsafe counters", () => {
    const missing = [
      ...Object.keys(disk).map((key) => without(disk, key)),
      ...Object.entries({ owner: disk.owner, usage: disk.usage, proof: disk.proof, placement: disk.placement }).flatMap(([part, value]) => {
        return Object.keys(value).map((key) => ({ ...disk, [part]: without(value, key) }))
      }),
    ]
    const malformed = [
      ...missing, { ...disk, version: 2 }, { ...disk, resourceId: "/private/path" },
      ...[-1, 0.1, Number.MAX_SAFE_INTEGER + 1].flatMap((n) => [
        { ...disk, sampleBootMs: n }, { ...disk, producerSeq: n }, { ...disk, usage: { ...disk.usage, allocatedBytes: n } },
      ]),
    ]
  for (const input of malformed) expect(Result.isFailure(validate(input))).toBe(true)
})

test("neutral scanner mutations do not confer authority, and a shared extent charges once", () => {
    expect(trustedObservation(disk)).toBe(true)
    const forged = [
      { ...disk, relation: "controller" }, { ...disk, protection: "eligible-class" },
      { ...disk, state: "terminal" }, { ...disk, lease: { id: "lease", generation: 1 } },
      { ...disk, owner: { ...disk.owner, authorityId: "scanner-a" } },
      { ...disk, proof: { ...disk.proof, validUntilBootMs: 10 } },
      { ...disk, placement: { ...disk.placement, confinementRef: "scope" } },
      { ...disk, usage: { ...disk.usage, exclusiveBytes: 1 } },
    ]
    for (const input of forged) expect(trustedObservation(decode(input))).toBe(false)
    const two = { ...disk, producerSeq: 2, holderId: "disk-obs-2", resourceId: "cache-res-2" }
    expect(storageCharges([disk, two])).toEqual([{ allocatedBytes: Option.some(8192), sharedBytes: Option.some(4096) }])
})
