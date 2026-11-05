// The memory store keeps the SideQuestions laws.
import { Effect } from "effect"
import { sideQuestionsLaws } from "../laws.ts"
import { layer, shelf } from "./store.ts"

sideQuestionsLaws("SideQuestions in memory", Effect.map(shelf, layer))
