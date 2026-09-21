import type { EventDefinitionDoc } from '../store/schema.js'

/** Shortest first, then by name */
export function byEventOrder (a: EventDefinitionDoc, b: EventDefinitionDoc) {
  return a.totalDuration - b.totalDuration || a.name.localeCompare(b.name)
}
