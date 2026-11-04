/**
 * The snapshot codec: the worker's bindings as structured clones (`bun:jsc`),
 * so they outlive the worker. Each binding is cloned on its own, so cycles and
 * shared references inside one binding survive, and those between two do not.
 *
 * The clone is taken of a copy, never of the cell's own objects. The copy is
 * built from data properties read through their descriptors, with brands
 * checked by `node:util` and built-ins taken at load, so encoding runs no
 * getter, Proxy trap, iterator or stack hook a cell wrote. Leaves the
 * serializer reads by internal slot only (dates, patterns, byte arrays) go in
 * as they are. Errors go in as plain stand-ins: reading an error's stack can
 * call a cell's `Error.prepareStackTrace`.
 *
 * What the clone loses comes back by fixups, keyed by the object's place in a
 * walk both sides take over the copy: a bare object's null prototype, a
 * Buffer's prototype, an error's type and name, and the prototype of an
 * instance of a top-level class the restore declares again. Each value that
 * cannot make the round trip is named with its reason.
 *
 * `decodeBinding` also reads the tagged JSON earlier versions stored.
 *
 * @module
 */
import { deserialize, serialize } from "bun:jsc"
import { types } from "node:util"
import type { Json, Omission, OmissionReason, Snapshot, SnapshotBinding } from "../frame.ts"
import { MAX_BINDING_BYTES, MAX_SNAPSHOT_BYTES } from "../limits.ts"
/** How deep the copy goes; the serializer recurses, so a deeper value fails there anyway. */
const MAX_DEPTH = 10_000
/** Strings at least this long are charged once each against the budget, as the serializer stores them once. */
const COUNTED_STRING = 64
/** The key that marks a stored clone. */
const CLONE_TAG = "$kernel"

// Taken at load, so a cell that replaces a built-in never runs here.
const prototypeOf = Object.getPrototypeOf
const setPrototypeOf = Object.setPrototypeOf
const ownKeys = Reflect.ownKeys
const descriptorOf = Object.getOwnPropertyDescriptor
const defineProperty = Object.defineProperty
const hasOwn = Object.hasOwn
const apply = Reflect.apply
const isArray = Array.isArray
const ArrayConstructor = Array
const MapConstructor = Map
const SetConstructor = Set
const Bytes = Uint8Array
const RangeErrorConstructor = RangeError
const toStringTag = Symbol.toStringTag
const ObjectPrototype = Object.prototype
const ArrayPrototype = Array.prototype
const MapPrototype = Map.prototype
const SetPrototype = Set.prototype
const DatePrototype = Date.prototype
const RegExpPrototype = RegExp.prototype
const ArrayBufferPrototype = ArrayBuffer.prototype
const BufferPrototype: object = Buffer.prototype
const mapForEach = Map.prototype.forEach
const mapSet = Map.prototype.set
const mapGet = Map.prototype.get
const mapHas = Map.prototype.has
const mapClear = Map.prototype.clear
const mapSize = descriptorOf(Map.prototype, "size")!.get!
const setForEach = Set.prototype.forEach
const setAdd = Set.prototype.add
const setHas = Set.prototype.has
const setClear = Set.prototype.clear
const weakRefDeref = WeakRef.prototype.deref
const registryUnregister = FinalizationRegistry.prototype.unregister
const typedArrayPrototype: object = prototypeOf(Uint8Array.prototype)
const typedArrayBuffer = descriptorOf(typedArrayPrototype, "buffer")!.get!
const dataViewBuffer = descriptorOf(DataView.prototype, "buffer")!.get!
const arrayBufferBytes = descriptorOf(ArrayBuffer.prototype, "byteLength")!.get!
const toBase64 = Uint8Array.prototype.toBase64
const fromBase64 = Uint8Array.fromBase64
const IteratorPrototype: object = prototypeOf(prototypeOf([][Symbol.iterator]()))
const AsyncIteratorPrototype: object = prototypeOf(prototypeOf(async function* () {}).prototype)
const { isProxy, isPromise, isWeakMap, isWeakSet, isGeneratorObject, isModuleNamespaceObject, isSharedArrayBuffer } = types
const { isBoxedPrimitive, isArgumentsObject, isNativeError, isDate, isRegExp, isTypedArray, isDataView, isArrayBuffer, isMap, isSet } = types

/** The native error types a stand-in can name, by name. */
const ERRORS: ReadonlyMap<string, ErrorConstructor> = new MapConstructor(
  [Error, TypeError, RangeError, SyntaxError, ReferenceError, EvalError, URIError].map((constructor) => [constructor.name, constructor]),
)
const errorTypeOf: ReadonlyMap<object, string> = new MapConstructor([...ERRORS].map(([name, constructor]) => [constructor.prototype, name]))

/** The intrinsic prototypes of the byte views. */
const VIEWS: ReadonlySet<object> = new SetConstructor([
  Int8Array,
  Uint8Array,
  Uint8ClampedArray,
  Int16Array,
  Uint16Array,
  Int32Array,
  Uint32Array,
  Float16Array,
  Float32Array,
  Float64Array,
  BigInt64Array,
  BigUint64Array,
  DataView,
].map((constructor) => constructor.prototype))

// The codec calls no method on a value a cell can reach: a cell may have replaced it on the prototype.
const has = <K>(map: ReadonlyMap<K, unknown>, key: K): boolean => apply(mapHas, map, [key])
const get = <K, V>(map: ReadonlyMap<K, V>, key: K): V | undefined => apply(mapGet, map, [key])
const set = <K, V>(map: Map<K, V>, key: K, value: V): void => void apply(mapSet, map, [key, value])
const sizeOf = (map: ReadonlyMap<unknown, unknown>): number => apply(mapSize, map, [])
const inSet = <T>(items: ReadonlySet<T>, item: T): boolean => apply(setHas, items, [item])
const addTo = <T>(items: Set<T>, item: T): void => void apply(setAdd, items, [item])
/** A data property's descriptor with no prototype, so `defineProperty` reads no `get` or `set` a cell put on `Object.prototype`. */
const data = (value: unknown, enumerable = true): PropertyDescriptor =>
  ({ __proto__: null, value, writable: true, enumerable, configurable: true }) as PropertyDescriptor
/** Appends by definition: assigning an index would find a setter a cell put on `Array.prototype`. */
const append = (list: unknown[], value: unknown): void => void defineProperty(list, list.length, data(value))
/** A Map's keys and values, alternating, or a Set's items. */
const entriesOf = (collection: object): unknown[] => {
  const out: unknown[] = []
  if (isMap(collection)) apply(mapForEach, collection, [(value: unknown, key: unknown) => (append(out, key), append(out, value))])
  else apply(setForEach, collection, [(item: unknown) => append(out, item)])
  return out
}

/** What restore puts back on the object at `at` in the walk: its prototype, or the error it stands for. */
type Fixup = Need & { readonly at: number }

/** What a copied object needs back after the round trip; its place in the walk is set when the walk numbers it. */
type Need =
  | { readonly kind: "null-prototype" | "buffer" }
  | { readonly kind: "error"; readonly type: string }
  | { readonly kind: "class"; readonly name: string }

/** The prototypes of the classes a restore declares again, each by the global that holds its class. */
export type Classes = ReadonlyMap<object, string>

/** A value that cannot round-trip; the copy stops at the first. */
class Omitted {
  constructor(readonly reason: OmissionReason) {}
}

/** Whether `run` throws: a brand check by a built-in that throws on a foreign receiver. */
const throws = (run: () => unknown) => {
  try {
    run()
    return false
  } catch {
    return true
  }
}

/** The value of an own data property; `undefined` when absent; `Omitted` for an accessor. */
const dataOf = (object: object, key: string): { readonly value: unknown } | undefined | Omitted => {
  const descriptor = descriptorOf(object, key)
  if (descriptor === undefined) return undefined
  return hasOwn(descriptor, "value") ? { value: descriptor.value } : new Omitted("unsupported")
}

/** Why an object with a prototype of its own cannot be kept: its class by name, read without running code. */
const foreignReason = (object: object): OmissionReason => {
  if (!throws(() => apply(weakRefDeref, object, [])) || !throws(() => apply(registryUnregister, object, [{}]))) return "live"
  for (let proto: unknown = prototypeOf(object); typeof proto === "object" && proto !== null; proto = prototypeOf(proto)) {
    if (isProxy(proto)) return "unsupported"
    if (proto === IteratorPrototype || proto === AsyncIteratorPrototype) return "live"
    if (proto === ObjectPrototype) break
    const constructor = dataOf(proto, "constructor")
    if (constructor !== undefined && !(constructor instanceof Omitted) && typeof constructor.value === "function" && !isProxy(constructor.value)) {
      const name = dataOf(constructor.value, "name")
      if (name !== undefined && !(name instanceof Omitted) && typeof name.value === "string" && name.value !== "") return `instance of ${name.value}`
    }
    const tag = descriptorOf(proto, toStringTag)
    if (tag !== undefined && hasOwn(tag, "value") && typeof tag.value === "string" && tag.value !== "") return `instance of ${tag.value}`
  }
  return "unsupported"
}

/** Objects that hold on to something outside the value: they mean nothing in a new process. Weak references are told in `foreignReason`. */
const isLive = (object: object) =>
  isPromise(object) ||
  isWeakMap(object) ||
  isWeakSet(object) ||
  isGeneratorObject(object) ||
  isModuleNamespaceObject(object) ||
  isSharedArrayBuffer(object)

/** The bytes one binding may still take; `charge` fails at the first charge past it. */
class Budget {
  private readonly strings = new SetConstructor<string>()
  private readonly buffers = new SetConstructor<object>()
  constructor(private left: number) {}

  charge(bytes: number): boolean {
    this.left -= bytes
    return this.left >= 0
  }

  /** A string takes at least a byte per character, once however often it recurs. */
  text(value: string): boolean {
    if (value.length < COUNTED_STRING) return this.charge(1)
    if (inSet(this.strings, value)) return true
    addTo(this.strings, value)
    return this.charge(value.length)
  }

  /** A byte store's contents, once however many views share it. */
  store(buffer: object, bytes: number): boolean {
    if (inSet(this.buffers, buffer)) return true
    addTo(this.buffers, buffer)
    return this.charge(bytes)
  }
}

/**
 * The copy the serializer reads: containers rebuilt from data properties,
 * leaves as they are, errors as stand-ins. Fixups are keyed by the copy's
 * objects until the walk numbers them.
 */
const copyOf = (root: unknown, budget: Budget, classes: Classes): { readonly copy: unknown; readonly needs: ReadonlyMap<object, Need> } | Omitted => {
  const copies = new MapConstructor<object, unknown>()
  const needs = new MapConstructor<object, Need>()
  /** Containers whose copies are made but not filled. */
  const queue: Array<{ readonly from: object; readonly to: object; readonly depth: number }> = []

  const visit = (value: unknown, depth: number): unknown => {
    if (typeof value === "function") return new Omitted("function")
    if (typeof value === "symbol") return new Omitted("unsupported")
    if (typeof value === "string") return budget.text(value) ? value : new Omitted("too-large")
    if (typeof value !== "object" || value === null) return budget.charge(1) ? value : new Omitted("too-large")
    if (has(copies, value)) return get(copies, value)
    if (depth > MAX_DEPTH) return new Omitted("too-deep")
    if (!budget.charge(1)) return new Omitted("too-large")
    const made = shell(value, depth)
    if (made instanceof Omitted) return made
    set(copies, value, made)
    return made
  }

  /** The object's copy, unfilled; a leaf is its own copy. */
  const shell = (value: object, depth: number): object | Omitted => {
    if (isProxy(value)) return new Omitted("unsupported")
    if (isLive(value)) return new Omitted("live")
    if (isBoxedPrimitive(value) || isArgumentsObject(value)) return new Omitted("unsupported")
    const proto: unknown = prototypeOf(value)
    if (isNativeError(value)) {
      const type = typeof proto === "object" && proto !== null ? get(errorTypeOf, proto) : undefined
      if (type === undefined) return new Omitted(foreignReason(value))
      // Only `name` and `message`: reading anything else may build the stack, and with it call a cell's hook.
      const name = dataOf(value, "name")
      const message = dataOf(value, "message")
      if (name instanceof Omitted || message instanceof Omitted) return name instanceof Omitted ? name : (message as Omitted)
      if (!isPrimitive(name?.value) || !isPrimitive(message?.value)) return new Omitted("unsupported")
      const standIn: Record<string, string> = {}
      const text = message === undefined || message.value === undefined ? "" : String(message.value)
      if (!budget.text(text)) return new Omitted("too-large")
      put(standIn, "message", text)
      if (name !== undefined && name.value !== undefined) put(standIn, "name", String(name.value))
      set(needs, standIn, { kind: "error", type })
      return standIn
    }
    if (isDate(value)) return proto === DatePrototype ? value : new Omitted(foreignReason(value))
    if (isRegExp(value)) return proto === RegExpPrototype ? value : new Omitted(foreignReason(value))
    if (isTypedArray(value) || isDataView(value)) {
      const buffer = apply(isDataView(value) ? dataViewBuffer : typedArrayBuffer, value, []) as ArrayBuffer
      if (isSharedArrayBuffer(buffer)) return new Omitted("live")
      const isBuffer = proto === BufferPrototype && isTypedArray(value)
      if (!isBuffer && !inSet(VIEWS, proto as object)) return new Omitted(foreignReason(value))
      if (!budget.store(buffer, apply(arrayBufferBytes, buffer, []) as number)) return new Omitted("too-large")
      if (isBuffer) set(needs, value, { kind: "buffer" })
      return value
    }
    if (isArrayBuffer(value)) {
      if (proto !== ArrayBufferPrototype) return new Omitted(foreignReason(value))
      return budget.store(value, apply(arrayBufferBytes, value, []) as number) ? value : new Omitted("too-large")
    }
    if (isMap(value)) {
      if (proto !== MapPrototype) return new Omitted(foreignReason(value))
      const copy = new MapConstructor()
      append(queue, { from: value, to: copy, depth })
      return copy
    }
    if (isSet(value)) {
      if (proto !== SetPrototype) return new Omitted(foreignReason(value))
      const copy = new SetConstructor()
      append(queue, { from: value, to: copy, depth })
      return copy
    }
    if (isArray(value)) {
      if (proto !== ArrayPrototype) return new Omitted(foreignReason(value))
      // Holes cost the clone nothing, so the length is not charged.
      const length = (descriptorOf(value, "length") as PropertyDescriptor).value as number
      const copy = new ArrayConstructor(length)
      append(queue, { from: value, to: copy, depth })
      return copy
    }
    // An instance of a declared class is its own properties; restore gives it the class's prototype again.
    const owner = typeof proto === "object" && proto !== null ? get(classes, proto) : undefined
    if (proto !== ObjectPrototype && proto !== null && owner === undefined) return new Omitted(foreignReason(value))
    const copy = {}
    if (proto === null) set(needs, copy, { kind: "null-prototype" })
    if (owner !== undefined) set(needs, copy, { kind: "class", name: owner })
    append(queue, { from: value, to: copy, depth })
    return copy
  }

  /** Copies a container's own enumerable data properties, or its entries; an accessor stops the copy. */
  const fill = (from: object, to: object, depth: number): Omitted | undefined => {
    if (isMap(from) || isSet(from)) {
      const items = entriesOf(from)
      for (let index = 0; index < items.length; index++) {
        const copied = visit(items[index], depth + 1)
        if (copied instanceof Omitted) return copied
        items[index] = copied
      }
      if (isSet(from)) for (let index = 0; index < items.length; index++) addTo(to as Set<unknown>, items[index])
      else for (let index = 0; index < items.length; index += 2) set(to as Map<unknown, unknown>, items[index], items[index + 1])
      return undefined
    }
    const keys = ownKeys(from)
    for (let index = 0; index < keys.length; index++) {
      const key = keys[index]
      if (typeof key !== "string") continue
      const descriptor = descriptorOf(from, key)
      if (descriptor === undefined || descriptor.enumerable !== true) continue
      if (!hasOwn(descriptor, "value")) return new Omitted("unsupported")
      if (!budget.text(key)) return new Omitted("too-large")
      const copied = visit(descriptor.value, depth + 1)
      if (copied instanceof Omitted) return copied
      put(to, key, copied)
    }
    return undefined
  }

  try {
    const copy = visit(root, 0)
    if (copy instanceof Omitted) return copy
    // A queue, not recursion: a deep value cannot overflow the stack here.
    for (let index = 0; index < queue.length; index++) {
      const next = queue[index]!
      const failed = fill(next.from, next.to, next.depth)
      if (failed) return failed
    }
    return { copy, needs }
  } catch {
    // A namespace's binding before its module ran, or a host object that refuses to be read.
    return new Omitted("unsupported")
  }
}

const isPrimitive = (value: unknown) => value === null || (typeof value !== "object" && typeof value !== "function")

/** Defines, not assigns: an own `__proto__` key stays a key, and no setter on a prototype runs. */
const put = (target: object, key: string, value: unknown) => defineProperty(target, key, data(value))

const isLeaf = (object: object) => isDate(object) || isRegExp(object) || isTypedArray(object) || isDataView(object) || isArrayBuffer(object)

/**
 * Every object in a clone, in the order both sides number them: breadth first,
 * a container's own enumerable properties, a Map's keys and values, a Set's
 * items. Dates, patterns and byte stores are leaves.
 */
const walk = (root: unknown): ReadonlyArray<object> => {
  const seen = new SetConstructor<object>()
  const order: object[] = []
  const enter = (value: unknown) => {
    if (typeof value !== "object" || value === null || inSet(seen, value)) return
    addTo(seen, value)
    append(order, value)
  }
  enter(root)
  for (let index = 0; index < order.length; index++) {
    const object = order[index]!
    if (isLeaf(object)) continue
    if (isMap(object) || isSet(object)) {
      const items = entriesOf(object)
      for (let item = 0; item < items.length; item++) enter(items[item])
      continue
    }
    const keys = ownKeys(object)
    for (let key = 0; key < keys.length; key++) {
      const name = keys[key]
      if (typeof name !== "string") continue
      const descriptor = descriptorOf(object, name)
      if (descriptor !== undefined && descriptor.enumerable === true && hasOwn(descriptor, "value")) enter(descriptor.value)
    }
  }
  return order
}

/** One binding as a stored clone, or why it cannot be one. */
const encodeBinding = (value: unknown, limit: number, classes: Classes): { readonly json: Json; readonly bytes: number } | Omitted => {
  const copied = copyOf(value, new Budget(limit), classes)
  if (copied instanceof Omitted) return copied
  let bytes: Uint8Array
  try {
    bytes = new Bytes(serialize(copied.copy))
  } catch (cause) {
    return new Omitted(cause instanceof RangeErrorConstructor ? "too-deep" : "unsupported")
  }
  if (bytes.byteLength > limit) return new Omitted("too-large")
  const fixups: Fixup[] = []
  if (sizeOf(copied.needs) > 0) {
    const order = walk(copied.copy)
    for (let at = 0; at < order.length; at++) {
      const need = get(copied.needs, order[at]!)
      if (need !== undefined) append(fixups, { at, ...need })
    }
  }
  const clone = apply(toBase64, bytes, []) as string
  const json: Json = fixups.length > 0 ? { [CLONE_TAG]: "clone", data: clone, fixups } : { [CLONE_TAG]: "clone", data: clone }
  return { json, bytes: bytes.byteLength }
}

/**
 * Each binding as a clone, within the limits, and each one left out by name
 * with its reason. `limit` is what the snapshot's clones may take in all.
 */
export const encodeSnapshot = (namespace: ReadonlyMap<string, unknown>, classes: Classes = new MapConstructor(), limit = MAX_SNAPSHOT_BYTES): Snapshot => {
  const bindings: SnapshotBinding[] = []
  const omitted: Omission[] = []
  let left = limit
  apply(mapForEach, namespace, [
    (value: unknown, name: string) => {
      const encoded = encodeBinding(value, left < MAX_BINDING_BYTES ? left : MAX_BINDING_BYTES, classes)
      if (encoded instanceof Omitted) return append(omitted, { name, reason: encoded.reason })
      left -= encoded.bytes
      append(bindings, { name, value: encoded.json })
    },
  ])
  return { bindings, omitted }
}

const isFixup = (value: unknown): value is Fixup => {
  if (typeof value !== "object" || value === null) return false
  const { at, kind, type, name } = value as Record<string, unknown>
  if (typeof at !== "number") return false
  if (kind === "class") return typeof name === "string"
  return kind === "null-prototype" || kind === "buffer" || (kind === "error" && typeof type === "string" && has(ERRORS, type))
}

/** The error a stand-in stood for, made in this realm; its stack is its first line, as the old one is gone. */
const reviveError = (standIn: object, type: string): Error => {
  const message = dataOf(standIn, "message") as { readonly value: string }
  const name = dataOf(standIn, "name") as { readonly value: string } | undefined
  const error = new (get(ERRORS, type) as ErrorConstructor)(message.value)
  if (name !== undefined) put(error, "name", name.value)
  const head = name?.value ?? type
  defineProperty(error, "stack", data(message.value === "" ? head : `${head}: ${message.value}`, false))
  return error
}

/** Puts revived errors where their stand-ins are; a Map or Set is rebuilt in its order. */
const replaceStandIns = (order: ReadonlyArray<object>, revived: ReadonlyMap<object, Error>) => {
  const swap = (value: unknown) => (typeof value === "object" && value !== null && has(revived, value) ? get(revived, value) : value)
  for (let index = 0; index < order.length; index++) {
    const object = order[index]!
    if (has(revived, object) || isLeaf(object)) continue
    if (isMap(object) || isSet(object)) {
      const items = entriesOf(object)
      if (isSet(object)) {
        apply(setClear, object, [])
        for (let item = 0; item < items.length; item++) addTo(object, swap(items[item]))
      } else {
        apply(mapClear, object, [])
        for (let item = 0; item < items.length; item += 2) set(object as Map<unknown, unknown>, swap(items[item]), swap(items[item + 1]))
      }
      continue
    }
    const keys = ownKeys(object)
    for (let key = 0; key < keys.length; key++) {
      const name = keys[key]
      if (typeof name !== "string") continue
      const descriptor = descriptorOf(object, name)
      if (descriptor !== undefined && hasOwn(descriptor, "value") && descriptor.value !== swap(descriptor.value))
        defineProperty(object, name, { __proto__: null, ...descriptor, value: swap(descriptor.value) } as PropertyDescriptor)
    }
  }
}

/**
 * A stored binding's value, made in this realm; `undefined` for one this codec
 * did not write, or an instance whose class `prototypeOfClass` cannot find.
 */
export const decodeBinding = (stored: Json, prototypeOfClass: (name: string) => object | undefined = () => undefined): { readonly value: unknown } | undefined => {
  if (typeof stored !== "object" || stored === null || isArray(stored)) return decodeLegacy(stored)
  const { [CLONE_TAG]: tag, data: clone, fixups = [] } = stored as Record<string, Json | undefined>
  if (tag !== "clone") return decodeLegacy(stored)
  if (typeof clone !== "string" || !isArray(fixups)) return undefined
  for (let index = 0; index < fixups.length; index++) if (!isFixup(fixups[index])) return undefined
  try {
    let value: unknown = deserialize(apply(fromBase64, Bytes, [clone]))
    if (fixups.length === 0) return { value }
    const order = walk(value)
    const revived = new MapConstructor<object, Error>()
    for (let index = 0; index < fixups.length; index++) {
      const fixup = fixups[index] as Fixup
      const object = order[fixup.at]
      if (object === undefined) return undefined
      if (fixup.kind === "error") set(revived, object, reviveError(object, fixup.type))
      else if (fixup.kind === "class") {
        const proto = prototypeOfClass(fixup.name)
        if (proto === undefined) return undefined
        setPrototypeOf(object, proto)
      } else setPrototypeOf(object, fixup.kind === "buffer" ? BufferPrototype : null)
    }
    if (sizeOf(revived) > 0) {
      replaceStandIns(order, revived)
      if (has(revived, value)) value = get(revived, value)
    }
    return { value }
  } catch {
    return undefined
  }
}

// ── the tagged JSON of earlier versions ─────────────────────────────────────

/** The typed arrays the tagged JSON names by their constructor's name. */
const LEGACY_VIEWS: ReadonlyMap<string, { from: (items: ArrayLike<unknown>) => object }> = new MapConstructor(
  [Int8Array, Uint8Array, Uint8ClampedArray, Int16Array, Uint16Array, Int32Array, Uint32Array, Float32Array, Float64Array, BigInt64Array, BigUint64Array].map(
    (constructor) => [constructor.name, constructor as unknown as { from: (items: ArrayLike<unknown>) => object }],
  ),
)

/**
 * A value in the tagged JSON earlier versions stored: plain JSON as itself,
 * `{ "$kernel": kind, value }` for the rest. `undefined` when it is not one.
 */
const decodeLegacy = (stored: Json): { readonly value: unknown } | undefined => {
  const revive = (value: Json): unknown => {
    if (value === null || typeof value !== "object") return value
    if (isArray(value)) return value.map(revive)
    const record = value as { readonly [key: string]: Json }
    const kind = record[CLONE_TAG]
    const plain = (from: { readonly [key: string]: Json }) => {
      const out = {}
      for (const key of Object.keys(from)) put(out, key, revive(from[key]!))
      return out
    }
    if (typeof kind !== "string") return plain(record)
    const inner = record.value as never
    if (kind === "undefined") return undefined
    if (kind === "number") return Number(inner)
    if (kind === "bigint") return BigInt(inner)
    if (kind === "date") return new Date(Number(inner))
    if (kind === "regexp") return new RegExp((inner as string[])[0]!, (inner as string[])[1])
    if (kind === "map") return new MapConstructor((inner as Json[][]).map(([key, item]) => [revive(key!), revive(item!)]))
    if (kind === "set") return new SetConstructor((inner as Json[]).map(revive))
    // An object with its own "$kernel" key, wrapped so the key reads as data.
    if (kind === "object") return plain(inner)
    if (kind === "error") {
      const { name, message, stack } = inner as Record<string, string>
      const error = new Error(message)
      put(error, "name", name)
      defineProperty(error, "stack", data(stack, false))
      return error
    }
    const view = get(LEGACY_VIEWS, kind)
    if (view === undefined) throw new TypeError(`no ${kind} in tagged JSON`)
    return view.from((inner as Json[]).map((item) => (kind.startsWith("Big") ? BigInt(item as string) : Number(item))))
  }
  try {
    return { value: revive(stored) }
  } catch {
    return undefined
  }
}
