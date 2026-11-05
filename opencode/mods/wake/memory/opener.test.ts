import { openerLaws } from "../laws.ts"
import * as MemoryOpener from "./opener.ts"

openerLaws("memory Opener", (answer) => MemoryOpener.layer(MemoryOpener.empty(answer)))
