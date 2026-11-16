// A host's browser in memory, for the viewer's tests: each address opened
// is kept for the test to read.
import { Layer, Ref } from "effect"
import { Opener } from "../service.ts"

export const layer = (opened: Ref.Ref<ReadonlyArray<string>>) => Layer.succeed(Opener, Opener.of({ open: (url) => Ref.update(opened, (all) => [...all, url]) }))
