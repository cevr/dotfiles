// The btrfs metadata read a Linux volume sample rests on. The workbox's
// btrfs-progs (read 2026-11-26, as its user, so without the per-device
// table) ends each profile line with the percentage used; an older one ends
// at the number. Before this parse took both, every guarded check on the
// workbox was granted and then refused "unavailable" at its launch.
import { expect, test } from "bun:test"
import { Option } from "effect"
import { btrfsMetadataHeadroom } from "./readings.ts"

const WORKBOX = `Overall:
    Device size:		      816043786240
    Device allocated:		      811747770368
    Device unallocated:		        4296015872
    Device missing:		                 0
    Device slack:		18446743259259600896
    Used:			      675608932352
    Free (estimated):		      104361709568	(min: 102213701632)
    Free (statfs, df):		      104360660992
    Data ratio:			              1.00
    Metadata ratio:		              2.00
    Global reserve:		         536870912	(used: 0)
    Multiple profiles:		                no

Data,single: Size:688238100480, Used:588172406784 (85.46%)

Metadata,DUP: Size:61721280512, Used:43718033408 (70.83%)

System,DUP: Size:33554432, Used:131072 (0.39%)`

const metadataFree = 61_721_280_512 - 43_718_033_408

test("the workbox's btrfs usage, percentages and all, gives its metadata headroom", () => {
  expect(btrfsMetadataHeadroom(WORKBOX)).toEqual(Option.some(metadataFree))
})

test("an older btrfs-progs without percentages, and the per-device table as root, give the same headroom", () => {
  const bare = WORKBOX.replaceAll(/ \([\d.]+%\)/gu, "")
  expect(btrfsMetadataHeadroom(bare)).toEqual(Option.some(metadataFree))
  const root = `${WORKBOX.replace("(70.83%)", "(70.83%)\n   /dev/vdb   61721280512")}\n\nUnallocated:\n   /dev/vdb   4296015872`
  expect(btrfsMetadataHeadroom(root)).toEqual(Option.some(metadataFree))
})

test("several metadata profiles add up; no metadata line is no headroom, never zero", () => {
  const mixed = `${WORKBOX}\n\nMetadata,single: Size:1000, Used:400 (40.00%)`
  expect(btrfsMetadataHeadroom(mixed)).toEqual(Option.some(metadataFree + 600))
  expect(btrfsMetadataHeadroom("Data,single: Size:10, Used:5 (50.00%)")).toEqual(Option.none())
  expect(btrfsMetadataHeadroom("")).toEqual(Option.none())
})
