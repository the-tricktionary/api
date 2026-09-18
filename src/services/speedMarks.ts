import { Timestamp } from '@google-cloud/firestore'
import { createMarkReducer, filterMarkStream, simpleReducer } from '@ropescore/rulesets'
import type { SpeedMarkDoc, SpeedResultDoc } from '../store/schema.js'

/** Gaps between steps longer than this many median gaps count as a miss */
const MISS_THRESHOLD = 1.5

export interface SpeedAnalysis {
  duration: number
  stepsPerSecond: number
  maxStepsPerSecond: number
  misses: number
  stepsLost: number
  stepsPerSecondSeries: number[]
}

function toMillis (ts: Timestamp | { _seconds: number, _nanoseconds: number }) {
  // Documents read back through the key-value cache come back as plain objects
  return Timestamp.prototype.toMillis.call(ts)
}

function round2 (n: number) {
  return Math.round(n * 100) / 100
}

/**
 * Marks recorded by the first v4 API as a bare list of absolute click
 * timestamps, one per step.
 */
function clicksToMarks (clicks: NonNullable<SpeedResultDoc['clicks']>): SpeedMarkDoc[] {
  return clicks.map((click, sequence) => ({
    sequence,
    timestamp: toMillis(click),
    schema: 'step'
  }))
}

/**
 * The v2 app stored `graphData`: the cumulative offset (in 10 ms units, from
 * the start press) of every second step, averaged with the step before it.
 * Each entry therefore stands for two steps. The v2 `createdAt` was written
 * when the event ended, so the start is reconstructed from the duration.
 *
 * This is lossy but keeps the pacing graph of old results, the count stays
 * whatever was stored on the document.
 */
function graphDataToMarks (result: Pick<SpeedResultDoc, 'graphData' | 'createdAt' | 'count' | 'eventDefinition'>): SpeedMarkDoc[] {
  const offsets = (result.graphData ?? []).filter(n => Number.isFinite(n))
  if (!offsets.length) return []
  const totalDuration = result.eventDefinition?.totalDuration ?? 0
  const lastOffset = offsets[offsets.length - 1] ?? 0
  const durationMs = totalDuration > 0 ? totalDuration * 1000 : lastOffset * 10
  const start = toMillis(result.createdAt) - durationMs

  const marks: SpeedMarkDoc[] = offsets.map((offset, sequence) => ({
    sequence,
    timestamp: start + (offset * 10),
    schema: 'step',
    value: 2
  }))
  // Make the marks add up to the stored count when we can
  const remainder = result.count - (2 * (marks.length - 1))
  const last = marks[marks.length - 1]
  if (last != null && remainder >= 1) last.value = remainder

  return marks
}

/**
 * The mark stream of a result, converting the legacy formats on the fly until
 * the speed-marks migration has been run.
 */
export function marksOf (result: SpeedResultDoc): SpeedMarkDoc[] {
  if (Array.isArray(result.marks)) return result.marks
  if (Array.isArray(result.clicks) && result.clicks.length) return clicksToMarks(result.clicks)
  if (Array.isArray(result.graphData) && result.graphData.length) return graphDataToMarks(result)
  return []
}

/**
 * The number of steps a mark stream tallies up to, using the same reducer the
 * rulesets speed judges use so undo/clear marks and negative corrections
 * behave identically to the scoring app.
 */
export function countSteps (marks: readonly SpeedMarkDoc[]): number {
  const reducer = createMarkReducer<string, string>(simpleReducer)
  for (const mark of marks) reducer.addMark(mark)
  const steps = reducer.tally.step ?? 0
  return Math.max(0, Math.round(steps))
}

/**
 * Throws if the marks can't be processed by the rulesets reducers, which
 * require a gap-free sequence starting at 0.
 */
export function assertValidMarkStream (marks: readonly SpeedMarkDoc[]) {
  for (let idx = 0; idx < marks.length; idx++) {
    const mark = marks[idx]
    if (mark.sequence !== idx) throw new RangeError(`Mark ${idx} has sequence ${mark.sequence}, marks must be provided in order with a starting sequence of 0`)
    if (mark.schema === 'undo' && typeof mark.target !== 'number') throw new RangeError(`Undo mark ${idx} does not specify a target`)
  }
}

/**
 * Derives pacing statistics from a mark stream.
 *
 * Only step marks with a positive value are considered, the optional start
 * mark pins the start of the event, otherwise the first step is the start.
 * When the event has a total duration that is used as the duration, otherwise
 * the time from the start to the last step is used.
 */
export function analyseMarks (rawMarks: readonly SpeedMarkDoc[], totalDuration: number): SpeedAnalysis | null {
  const marks = filterMarkStream(rawMarks as Parameters<typeof filterMarkStream>[0])
  const steps = marks
    .filter(mark => mark.schema === 'step' && (mark.value ?? 1) > 0)
    .map(mark => ({ timestamp: mark.timestamp, value: mark.value ?? 1 }))
    .sort((a, b) => a.timestamp - b.timestamp)
  if (steps.length === 0) return null

  const start = marks.find(mark => mark.schema === 'start')?.timestamp ?? steps[0].timestamp
  const end = steps[steps.length - 1].timestamp
  const duration = totalDuration > 0 ? totalDuration : (end - start) / 1000
  const count = steps.reduce((acc, step) => acc + step.value, 0)
  const stepsPerSecond = duration > 0 ? count / duration : 0

  // Gaps between consecutive steps, in seconds per step so multi-step marks
  // (like the migrated v2 data) compare fairly with single steps
  const gaps: Array<{ seconds: number, value: number }> = []
  for (let idx = 1; idx < steps.length; idx++) {
    const seconds = (steps[idx].timestamp - steps[idx - 1].timestamp) / 1000
    if (seconds > 0) gaps.push({ seconds, value: steps[idx].value })
  }

  let maxStepsPerSecond = 0
  let misses = 0
  let stepsLost = 0

  if (gaps.length) {
    const perStep = gaps.map(gap => gap.seconds / gap.value).sort((a, b) => a - b)
    const median = perStep.length % 2 === 1
      ? perStep[(perStep.length - 1) / 2]
      : (perStep[perStep.length / 2 - 1] + perStep[perStep.length / 2]) / 2

    for (const gap of gaps) {
      const rate = gap.value / gap.seconds
      if (rate > maxStepsPerSecond) maxStepsPerSecond = rate

      if (median > 0 && (gap.seconds / gap.value) / median > MISS_THRESHOLD) {
        misses++
        // Steps that would have fit in the gap at the usual pace, minus the
        // ones that were actually counted at the end of it
        stepsLost += Math.max(0, Math.round(gap.seconds / median) - gap.value)
      }
    }
  }

  const buckets = totalDuration > 0 ? totalDuration : Math.max(1, Math.ceil((end - start) / 1000))
  const stepsPerSecondSeries = new Array<number>(buckets).fill(0)
  for (const step of steps) {
    const idx = Math.floor((step.timestamp - start) / 1000)
    if (idx >= 0 && idx < buckets) stepsPerSecondSeries[idx] += step.value
  }

  return {
    duration: round2(duration),
    stepsPerSecond: round2(stepsPerSecond),
    maxStepsPerSecond: round2(maxStepsPerSecond),
    misses,
    stepsLost,
    stepsPerSecondSeries
  }
}
