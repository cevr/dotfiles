// A run's batch cadence (SKILL.md, Batch cadence): land a batch when this many
// units are ready, or the oldest ready unit has waited this many minutes. The
// default is 3 ready or 30 min; the plan's `Batch cadence` line holds the
// run's, and a spec's `Batch cadence` line overrides it for its unit.
//
// The line is prose, so only its numbers are read: `<n> ready` (or `<n> units
// are ready`) sets the count, `<n> min` (or `<n> h`) sets the wait. A number
// the line does not give comes from the level above (the plan's, then the
// default); a line with none (`override: lands with hskokoro`) changes nothing.

export interface Cadence {
  /** A batch is due once this many units are ready. */
  readonly ready: number;
  /** Or once the oldest ready unit has waited this many minutes. */
  readonly minutes: number;
}

export const DEFAULT_CADENCE: Cadence = { ready: 3, minutes: 30 };

/** The text after the first `Batch cadence` label that starts a line (a list item or bold label too), or none. */
export const cadenceLine = (doc: string): string | undefined => {
  const match = /^[\s>*_-]*batch cadence\b[*_:\s]*(.*)$/im.exec(doc);
  return match === null ? undefined : match[1]!.trim();
};

/** The cadence a `Batch cadence` line sets, taking what it leaves out from `fallback`. */
export const parseCadence = (line: string, fallback: Cadence): Cadence => {
  const ready = /(\d+)\s+(?:units?\s+)?(?:are\s+)?ready\b/i.exec(line);
  const minutes = /(\d+)\s*(?:min|mins|minutes?)\b/i.exec(line);
  const hours = /(\d+(?:\.\d+)?)\s*(?:h|hr|hrs|hours?)\b/i.exec(line);
  return {
    ready: ready === null ? fallback.ready : Math.max(1, Number(ready[1])),
    minutes: minutes !== null ? Number(minutes[1]) : hours !== null ? Math.round(Number(hours[1]) * 60) : fallback.minutes,
  };
};

/** A unit's cadence: its spec's line over the plan's line over the default. */
export const cadenceOf = (plan: string | undefined, spec: string | undefined): Cadence => {
  const levels = [plan, spec].flatMap((doc) => {
    const line = doc === undefined ? undefined : cadenceLine(doc);
    return line === undefined ? [] : [line];
  });
  return levels.reduce((cadence, line) => parseCadence(line, cadence), DEFAULT_CADENCE);
};

/** The cadence as the status table prints it, and the orchestrate mod reads it: `3 ready or 30 min`. */
export const formatCadence = (cadence: Cadence): string => `${cadence.ready} ready or ${cadence.minutes} min`;
