import { pingLogLaws } from "../laws.ts"
import { layer } from "./ping-log.ts"

pingLogLaws("the in-memory keepalive log", () => layer())
