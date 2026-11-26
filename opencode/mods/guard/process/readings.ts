/**
 * The Linux (and Mac) readings of external output that a host sample rests
 * on, as pure parsers: `df -kP`, `df -ki`, `stat -f -c %T`, `btrfs
 * filesystem usage -b`, `/proc/stat`, `/proc/vmstat`, `/proc/meminfo`, the
 * PSI files and `systemctl show -p ControlGroup`. Each finds its fields by
 * name or by header, so extra fields and columns never break it; a failed
 * reading is a `Result` failure naming the file or command and the line
 * it could not read. Fixtures: readings.test.ts (the workbox, 2026-11-26).
 */
import { Array as Arr, Option, Result } from "effect"
import { type Ticks, type Volume } from "../host-supply.ts"

/** A reading, or why it failed: the file or command and the line. */
export type Reading<A> = Result.Result<A, string>

const countText = (raw: string): Option.Option<number> => Option.some(raw).pipe(
  Option.filter((text) => /^\d+$/u.test(text)),
  Option.map(Number),
  Option.filter(Number.isSafeInteger),
)
/** The count at `index` of `items`, if there is one and it is a count. */
const count = (items: ReadonlyArray<string>, index: number) => Option.flatMap(Arr.get(items, index), countText)
const rowsOf = (text: string) => text.split("\n").filter((line) => line.trim().length > 0)
const shown = (line: string) => `"${line}"`
const field = <A>(found: Option.Option<A>, why: () => string): Reading<A> => Result.fromOption(found, why)

/** `df` output as one header and the data fields below it, joined: a long
 * device name wraps the row in the non-POSIX format, never its column order. */
const dfTable = (text: string, command: string): Reading<{ readonly header: ReadonlyArray<string>; readonly fields: ReadonlyArray<string> }> => {
  const rows = rowsOf(text)
  const rest = rows.slice(1)
  if (rest.length === 0) return Result.fail(`${command}: no line below the header (read ${shown(rows.join("\n"))})`)
  return Result.succeed({
    header: rows.slice(0, 1).join("").trim().split(/\s+/u).map((name) => name.toLowerCase()),
    fields: rest.join(" ").trim().split(/\s+/u),
  })
}
const column = (table: { readonly header: ReadonlyArray<string>; readonly fields: ReadonlyArray<string> }, names: ReadonlyArray<string>) =>
  Option.filter(Option.some(table.header.findIndex((name) => names.includes(name))), (index) => index >= 0)

/** `df -kP <dir>`: the device, its size and free 1 KiB blocks, and its mount. */
export const dfSizes = (text: string, command: string) => Result.flatMap(dfTable(text, command), (table) => {
  const at = (names: ReadonlyArray<string>) => Option.flatMap(column(table, names), (index) => count(table.fields, index))
  const mountAt = Option.getOrElse(column(table, ["mounted"]), () => 5)
  const device = Option.filter(Option.fromNullishOr(table.fields[0]), (name) => name.length > 0)
  const mount = table.fields.slice(mountAt).join(" ")
  const line = shown(table.fields.join(" "))
  return Result.all({
    device: field(device, () => `${command}: no device in ${line}`),
    totalBlocks: field(at(["1024-blocks", "1k-blocks"]), () => `${command}: no 1024-blocks count in ${line}`),
    freeBlocks: field(at(["available", "avail"]), () => `${command}: no Available count in ${line}`),
    mount: field(Option.liftPredicate(mount, (path) => path.startsWith("/")), () => `${command}: no mount point in ${line}`),
  })
})

/** `df -ki <dir>`: free inodes, by the header's IFree (Linux) or ifree
 * (the Mac) column. A filesystem that counts no inodes (Inodes 0) has
 * dynamic ones. */
export const dfFreeInodes = (text: string, command: string): Reading<Volume["freeInodes"]> =>
  Result.flatMap(dfTable(text, command), (table): Reading<Volume["freeInodes"]> => {
    const total = Option.flatMap(column(table, ["inodes"]), (index) => count(table.fields, index))
    if (Option.exists(total, (inodes) => inodes === 0)) return Result.succeed("dynamic" as const)
    const free = Option.flatMap(column(table, ["ifree"]), (index) => count(table.fields, index))
    return field(free, () => `${command}: no IFree count in ${shown(table.fields.join(" "))}`)
  })

/** Unallocated-chunk-blind metadata headroom from `btrfs filesystem usage -b`:
 * the sum of Size - Used over its `Metadata,<profile>:` lines. btrfs-progs 5.x
 * and later end each line with the percentage used, "(70.83%)"; older ones
 * end at the number. Either is the same budget. */
export const btrfsMetadataHeadroom = (raw: string): Option.Option<number> => {
  const totals = [...raw.matchAll(/^\s*Metadata,[^:\n]*:\s*Size:\s*(\d+),\s*Used:\s*(\d+)(?:\s+\(\d+(?:\.\d+)?%\))?\s*$/gmu)]
  if (totals.length === 0) return Option.none()
  return Option.some(totals.reduce((headroom, [, size, used]) => headroom + Math.max(0, Number(size) - Number(used)), 0))
}

/** What the filesystem kind is: the `stat -f -c %T` name. Any kind reads
 * by df; btrfs alone needs its metadata read too. */
export const fsKindOf = (text: string) => text.trim().split(/\s+/u)[0] ?? ""

/** One volume's reading from its outputs: btrfs counts inodes dynamically
 * and budgets metadata apart from data; every other kind reads df alone. */
export const volumeReading = (input: {
  readonly fsKind: string
  readonly inodes: Reading<Volume["freeInodes"]>
  readonly btrfsUsage: Option.Option<{ readonly text: string; readonly command: string }>
  readonly capacityBytes: number
  readonly freeBytes: number
  readonly diskFloorBytes: number
}): Reading<Volume> => {
  const { capacityBytes, freeBytes, diskFloorBytes } = input
  if (input.fsKind !== "btrfs") return Result.map(input.inodes, (freeInodes) =>
    ({ capacityBytes, freeBytes, freeInodes, metadataFreeBytes: freeBytes, diskFloorBytes }))
  return Option.match(input.btrfsUsage, {
    onNone: () => Result.fail("btrfs filesystem usage -b: not read"),
    onSome: ({ text, command }) => Result.map(
      field(btrfsMetadataHeadroom(text), () => `${command}: no Metadata Size/Used line`),
      (metadataFreeBytes) => ({ capacityBytes, freeBytes, freeInodes: "dynamic" as const, metadataFreeBytes, diskFloorBytes })),
  })
}

const lineOf = (text: string, start: string) => Option.fromNullishOr(text.split("\n").find((line) => line.startsWith(start)))
/** The counter after `key ` on its own line (/proc/stat, /proc/vmstat, cpu.stat). */
export const keyed = (text: string, key: string, file: string): Reading<number> => Result.flatMap(
  field(lineOf(text, `${key} `), () => `${file}: no ${key} line`),
  (line) => field(count(line.trim().split(/\s+/u), 1), () => `${file}: ${key} is not a count in ${shown(line)}`),
)

/** /proc/stat's aggregate `cpu ` line: total and idle ticks over its first
 * eight counters (user..steal; guest and guest_nice are inside user and nice). */
export const procTicks = (text: string, at: number): Reading<Ticks> => Result.flatMap(
  field(lineOf(text, "cpu "), () => "/proc/stat: no aggregate cpu line"),
  (line) => {
    const ticks = Option.all(line.trim().split(/\s+/u).slice(1, 9).map(countText))
    return Result.map(field(Option.filter(ticks, (values) => values.length === 8), () => `/proc/stat: fewer than 8 counters in ${shown(line)}`),
      (values) => ({ at, total: values.reduce((sum, tick) => sum + tick, 0), idle: values[3] ?? 0 }))
  },
)

/** A /proc/meminfo field in kB. */
export const meminfo = (text: string, name: string): Reading<number> => Result.flatMap(
  field(lineOf(text, `${name}:`), () => `/proc/meminfo: no ${name} line`),
  (line) => field(count(line.trim().split(/\s+/u), 1), () => `/proc/meminfo: ${name} is not a count in ${shown(line)}`),
)

/** A PSI file's `some` (or `full`) avg10, a percentage. */
export const pressure = (text: string, group: "some" | "full", file: string): Reading<number> => Result.flatMap(
  field(lineOf(text, `${group} `), () => `${file}: no ${group} line`),
  (line) => field(Option.liftPredicate(Number(line.match(/\bavg10=(\d+(?:\.\d+)?)(?:\s|$)/u)?.[1] ?? "x"),
    (value) => Number.isFinite(value) && value >= 0 && value <= 100), () => `${file}: no avg10 percentage in ${shown(line)}`),
)

/** pswpin + pswpout from /proc/vmstat. */
export const swapPages = (text: string): Reading<number> =>
  Result.map(Result.all([keyed(text, "pswpin", "/proc/vmstat"), keyed(text, "pswpout", "/proc/vmstat")]), ([a, b]) => a + b)

/** `systemctl --user show <unit> -p ControlGroup --value` (or without
 * --value, `ControlGroup=<path>`): the unit's cgroup, none when inactive. */
export const controlGroupOf = (text: string): Option.Option<string> => {
  const value = text.trim().replace(/^ControlGroup=/u, "").trim()
  return Option.liftPredicate(value, (path) => path.startsWith("/") && !path.split("/").includes(".."))
}

/** The caller's place, read once for everyone: the `user-<uid>.slice` its
 * cgroup sits under. A login session scope, the user manager's services and
 * a transient scope are all inside it, so each reads the same limits; a
 * cgroup outside any user slice is its own place. */
export const userPlaceOf = (path: string) => {
  const names = path.split("/")
  const at = names.findIndex((name) => /^user-\d+\.slice$/u.test(name))
  return Option.match(Option.liftPredicate(at, (index) => index >= 0), {
    onNone: () => path,
    onSome: (index) => names.slice(0, index + 1).join("/"),
  })
}
