import { processesLaws } from "../laws.ts"
import * as MemoryProcesses from "./processes.ts"

processesLaws("memory Processes", MemoryProcesses.layer([{ pid: 7, name: "sleep", args: "sleep 41.5" }]), { pid: 7, args: "sleep 41.5" })
