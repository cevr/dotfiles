/**
 * Generated from a run of sim/sim.test.ts at 44f5ed09 (its SIM-SIG lines): for each acceptance check, each red
 * job's exact set of violation signatures (SPEC v2 ruling 7, widened). See sim/known-red.ts.
 */

/** The pin table's contract: check key, then job name, then that job's violation signatures. */
export interface PinTable {
  readonly [check: string]: Readonly<Record<string, ReadonlyArray<string>>>
}

export const PINS: PinTable = {
}
