/**
 * The snapshot codec: the worker's bindings as tagged JSON, so they outlive the
 * worker. Ported from gent's `cell-value.ts` codec. It reads data properties
 * through their descriptors and checks built-ins by brand, so encoding runs no
 * getter, Proxy trap or iterator a cell wrote. Each value that cannot make the
 * round trip is named with its reason. `reviverSource` in protocol.ts decodes.
 *
 * @module
 */
import { types } from "node:util"
import { SNAPSHOT_TAG, type Json, type Omission, type OmissionReason, type Snapshot, type SnapshotBinding } from "./protocol.ts"

/** One binding's encoded size, in bytes. */
export const MAX_BINDING_BYTES = 256 * 1024
/** A whole snapshot's encoded size, in bytes. */
export const MAX_SNAPSHOT_BYTES = 768 * 1024
const MAX_DEPTH = 64
/** Each entry encodes to at least two bytes, so a longer collection is too large unread. */
const MAX_ENTRIES = MAX_BINDING_BYTES / 2

/** A value that cannot round-trip; it never enters the JSON. */
class Omitted {
  constructor(readonly reason: OmissionReason) {}
}
type Encoded = Json | Omitted

const omitted = {
  function: new Omitted("function"),
  unsupported: new Omitted("unsupported"),
  cyclic: new Omitted("cyclic"),
  "too-deep": new Omitted("too-deep"),
  "too-large": new Omitted("too-large"),
} as const

const tagged = (kind: string, value: Json): Json => ({ [SNAPSHOT_TAG]: kind, value })

// Taken at load, so a cell that replaces a built-in never runs here.
const byteLength = Buffer.byteLength.bind(Buffer)
const stringify = JSON.stringify
const prototypeOf = Object.getPrototypeOf
const ownKeys = Reflect.ownKeys
const descriptorOf = Object.getOwnPropertyDescriptor
const hasOwn = Object.hasOwn
const isArray = Array.isArray
const dateTime = Date.prototype.getTime
const regexpSource = descriptorOf(RegExp.prototype, "source")!.get!
const regexpFlags = descriptorOf(RegExp.prototype, "flags")!.get!
const mapForEach = Map.prototype.forEach
const mapSize = descriptorOf(Map.prototype, "size")!.get!
const setForEach = Set.prototype.forEach
const setSize = descriptorOf(Set.prototype, "size")!.get!
const typedArrayPrototype: object = prototypeOf(Uint8Array.prototype)
const typedArrayLength = descriptorOf(typedArrayPrototype, "length")!.get!
const typedArrayTag = descriptorOf(typedArrayPrototype, Symbol.toStringTag)!.get!

/** The UTF-8 bytes one binding may still take; the encoder stops at the first charge past it. */
class Budget {
  constructor(private bytes: number) {}

  spend(bytes: number): boolean {
    this.bytes -= bytes
    return this.bytes >= 0
  }

  /** A string and its quotes. UTF-8 takes at least a byte per UTF-16 unit, so a longer string is refused uncounted. */
  text(value: string): boolean {
    if (value.length > this.bytes) return this.spend(value.length)
    return this.spend(byteLength(value) + 2)
  }
}

/** JSON has no NaN, infinities or -0; those travel as text. */
const isJsonNumber = (value: number) => Number.isFinite(value) && !Object.is(value, -0)
const numberText = (value: number) => (Object.is(value, -0) ? "-0" : String(value))
const jsonNumber = (value: number): Json => (isJsonNumber(value) ? value : numberText(value))

const encodePrimitive = (value: unknown, budget: Budget): Encoded | undefined => {
  if (typeof value === "string") return budget.text(value) ? value : omitted["too-large"]
  if (typeof value === "function") return omitted.function
  if (typeof value === "object" && value !== null) return undefined
  if (!budget.spend(2)) return omitted["too-large"]
  if (value === null || typeof value === "boolean") return value
  if (value === undefined) return tagged("undefined", null)
  if (typeof value === "number") {
    if (!isJsonNumber(value)) return tagged("number", numberText(value))
    return budget.spend(String(value).length - 1) ? value : omitted["too-large"]
  }
  if (typeof value === "bigint") return tagged("bigint", String(value))
  return omitted.unsupported
}

/** Plain: a null prototype, or a prototype whose own prototype is null (Object.prototype of any realm). */
const isPlainObject = (value: object) => {
  const proto: unknown = prototypeOf(value)
  if (proto === null) return true
  if (typeof proto !== "object" || types.isProxy(proto)) return false
  return prototypeOf(proto) === null
}

/** An own data property's value; an accessor is cell code and refuses the object. */
const dataValue = (object: object, key: PropertyKey): { readonly value: unknown } | undefined => {
  const descriptor = descriptorOf(object, key)
  if (descriptor === undefined) return { value: undefined }
  if (!hasOwn(descriptor, "value")) return undefined
  return { value: descriptor.value }
}

const encodeArray = (array: ReadonlyArray<unknown>, inner: (item: unknown) => Encoded): Encoded => {
  if (array.length > MAX_ENTRIES) return omitted["too-large"]
  const out: Json[] = []
  for (let index = 0; index < array.length; index++) {
    const item = dataValue(array, index)
    if (item === undefined) return omitted.unsupported
    const encoded = inner(item.value)
    if (encoded instanceof Omitted) return encoded
    out.push(encoded)
  }
  return out
}

const encodeRecord = (object: object, inner: (item: unknown) => Encoded, budget: Budget): Encoded => {
  const keys = ownKeys(object)
  if (keys.length > MAX_ENTRIES) return omitted["too-large"]
  const out: Record<string, Json> = {}
  for (const key of keys) {
    if (typeof key !== "string") continue
    const descriptor = descriptorOf(object, key)
    if (descriptor === undefined || descriptor.enumerable !== true) continue
    if (!hasOwn(descriptor, "value")) return omitted.unsupported
    if (!budget.text(key)) return omitted["too-large"]
    const encoded = inner(descriptor.value)
    if (encoded instanceof Omitted) return encoded
    // Assignment to an own `__proto__` key would set the prototype and drop the key.
    Object.defineProperty(out, key, { value: encoded, writable: true, enumerable: true, configurable: true })
  }
  return hasOwn(out, SNAPSHOT_TAG) ? tagged("object", out) : out
}

/** An error's `name`, `message` or `stack` as text, when it is a primitive data property. */
const errorField = (error: object, key: string, fallback: string): string | undefined => {
  const found = dataValue(error, key) ?? dataValue(prototypeOf(error) ?? {}, key)
  if (found === undefined) return undefined
  if (found.value === undefined) return fallback
  if (typeof found.value === "object" && found.value !== null) return undefined
  return String(found.value)
}

const encodeError = (error: object, budget: Budget): Encoded => {
  const name = errorField(error, "name", "Error")
  const message = errorField(error, "message", "")
  const stack = errorField(error, "stack", "")
  if (name === undefined || message === undefined || stack === undefined) return omitted.unsupported
  if (!budget.text(name) || !budget.text(message) || !budget.text(stack)) return omitted["too-large"]
  return tagged("error", { name, message, stack })
}

const encodeCollection = (value: object, kind: "map" | "set", inner: (item: unknown) => Encoded): Encoded => {
  const size: number = (kind === "map" ? mapSize : setSize).call(value)
  if (size > MAX_ENTRIES) return omitted["too-large"]
  const out: Json[] = []
  let failed: Omitted | undefined
  const add = (item: unknown, key: unknown) => {
    if (failed) return
    const encodedKey = kind === "map" ? inner(key) : null
    if (encodedKey instanceof Omitted) return void (failed = encodedKey)
    const encoded = inner(item)
    if (encoded instanceof Omitted) return void (failed = encoded)
    out.push(kind === "map" ? [encodedKey, encoded] : encoded)
  }
  ;(kind === "map" ? mapForEach : setForEach).call(value, add)
  return failed ?? tagged(kind, out)
}

const encodeTypedArray = (value: NodeJS.TypedArray, budget: Budget): Encoded => {
  const kind: string = typedArrayTag.call(value)
  const length: number = typedArrayLength.call(value)
  if (length > MAX_ENTRIES || !budget.spend(length * 2)) return omitted["too-large"]
  const values: Json[] = []
  for (let index = 0; index < length; index++) {
    const item = value[index]
    if (typeof item === "bigint") values.push(String(item))
    else if (typeof item === "number") values.push(jsonNumber(item))
  }
  return tagged(kind, values)
}

const encodeValue = (value: unknown, depth: number, seen: object[], budget: Budget): Encoded => {
  if (depth > MAX_DEPTH) return omitted["too-deep"]
  const primitive = encodePrimitive(value, budget)
  if (primitive !== undefined) return primitive
  // Every trap of a Proxy is cell code.
  if (typeof value !== "object" || value === null || types.isProxy(value)) return omitted.unsupported
  if (seen.includes(value)) return omitted.cyclic
  if (!budget.spend(3)) return omitted["too-large"]
  seen.push(value)
  const inner = (child: unknown) => encodeValue(child, depth + 1, seen, budget)
  let encoded: Encoded
  if (types.isNativeError(value)) encoded = encodeError(value, budget)
  else if (types.isDate(value)) encoded = tagged("date", jsonNumber(dateTime.call(value)))
  else if (types.isRegExp(value)) {
    const source: string = regexpSource.call(value)
    encoded = budget.text(source) ? tagged("regexp", [source, regexpFlags.call(value)]) : omitted["too-large"]
  } else if (types.isMap(value)) encoded = encodeCollection(value, "map", inner)
  else if (types.isSet(value)) encoded = encodeCollection(value, "set", inner)
  else if (types.isTypedArray(value)) encoded = encodeTypedArray(value, budget)
  else if (isArray(value) && prototypeOf(value) === Array.prototype) encoded = encodeArray(value, inner)
  else if (isPlainObject(value)) encoded = encodeRecord(value, inner, budget)
  else encoded = omitted.unsupported
  seen.pop()
  return encoded
}

/** Every binding as tagged JSON; those that cannot round-trip are named with the reason. */
export const encodeSnapshot = (namespace: ReadonlyMap<string, unknown>): Snapshot => {
  const bindings: SnapshotBinding[] = []
  const left: Omission[] = []
  let total = 0
  for (const [name, value] of namespace) {
    const budget = new Budget(Math.min(MAX_BINDING_BYTES, MAX_SNAPSHOT_BYTES - total))
    let encoded: Encoded
    try {
      encoded = encodeValue(value, 0, [], budget)
    } catch {
      // A host getter may still throw; that value cannot round-trip either.
      encoded = omitted.unsupported
    }
    if (encoded instanceof Omitted) {
      left.push({ name, reason: encoded.reason })
      continue
    }
    const size = byteLength(stringify(encoded))
    if (size > MAX_BINDING_BYTES || total + size > MAX_SNAPSHOT_BYTES) {
      left.push({ name, reason: "too-large" })
      continue
    }
    total += size
    bindings.push({ name, value: encoded })
  }
  return { bindings, omitted: left }
}
