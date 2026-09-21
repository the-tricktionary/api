import { Timestamp } from '@google-cloud/firestore'
import { createMarkReducer, filterMarkStream, simpleReducer } from '@ropescore/rulesets'
import { TimingCueType } from '../generated/graphql.js'
import type { EventDefinitionDoc, SpeedMark, SpeedResultDoc, TimingTrack } from '../store/schema.js'

/** Gaps between steps longer than this many median gaps count as a miss */
const MISS_THRESHOLD = 1.5

export interface SpeedSegment {
  index: number
  label?: string
  /** Seconds from the start of the event */
  start: number
  end: number
  count: number
  stepsPerSecond: number
}

export interface SpeedAnalysis {
  duration: number
  stepsPerSecond: number
  maxStepsPerSecond: number
  misses: number
  stepsLost: number
  stepsPerSecondSeries: number[]
  segments: SpeedSegment[]
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
function clicksToMarks (clicks: NonNullable<SpeedResultDoc['clicks']>): SpeedMark[] {
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
function graphDataToMarks (result: Pick<SpeedResultDoc, 'graphData' | 'createdAt' | 'recordedAt' | 'count' | 'eventDefinition'>): SpeedMark[] {
  const offsets = (result.graphData ?? []).filter(n => Number.isFinite(n))
  if (!offsets.length) return []
  const totalDuration = result.eventDefinition?.totalDuration ?? 0
  const lastOffset = offsets[offsets.length - 1] ?? 0
  const durationMs = totalDuration > 0 ? totalDuration * 1000 : lastOffset * 10
  const start = toMillis(result.recordedAt ?? result.createdAt) - durationMs

  const marks: SpeedMark[] = offsets.map((offset, sequence) => ({
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
export function marksOf (result: SpeedResultDoc): SpeedMark[] {
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
export function countSteps (marks: readonly SpeedMark[]): number {
  const reducer = createMarkReducer<string, string>(simpleReducer)
  for (const mark of marks) reducer.addMark(mark)
  const steps = reducer.tally.step ?? 0
  return Math.max(0, Math.round(steps))
}

/**
 * Throws if the marks can't be processed by the rulesets reducers, which
 * require a gap-free sequence starting at 0.
 */
export function assertValidMarkStream (marks: readonly SpeedMark[]) {
  for (let idx = 0; idx < marks.length; idx++) {
    const mark = marks[idx]
    if (mark.sequence !== idx) throw new RangeError(`Mark ${idx} has sequence ${mark.sequence}, marks must be provided in order with a starting sequence of 0`)
    if (mark.schema === 'undo' && typeof mark.target !== 'number') throw new RangeError(`Undo mark ${idx} does not specify a target`)
  }
}

/**
 * Where the event's clock starts, in absolute milliseconds.
 *
 * The 'start' mark is the moment the athlete pressed start, or the moment the
 * timing track started playing. With a track the clock starts at its start
 * cue instead, since the track usually has a "ready, set" lead-in.
 */
function eventStart (marks: ReadonlyArray<{ schema: string, timestamp: number }>, firstStep: number, timingTrack?: TimingTrack | null) {
  const startMark = marks.find(mark => mark.schema === 'start')
  if (startMark == null) return firstStep
  const startCue = timingTrack?.cues.find(cue => cue.type === TimingCueType.Start)
  return startMark.timestamp + (startCue?.offset ?? 0)
}

/**
 * The segments of the event in seconds from its start: one per stretch
 * between the switch cues, or a single one spanning the whole event when
 * there are none.
 *
 * Cues are offsets into the audio, so they are measured from the start cue
 * where there is one. A track without audio has no lead-in to skip, and a
 * custom event's switches are offsets into the event itself, so both start
 * from zero.
 */
export function segmentBounds (durationSeconds: number, timingTrack?: TimingTrack | null): Array<{ start: number, end: number, label?: string }> {
  const startCue = timingTrack?.cues.find(cue => cue.type === TimingCueType.Start)
  const switches = timingTrack?.cues.filter(cue => cue.type === TimingCueType.Switch) ?? []
  if (switches.length === 0) return [{ start: 0, end: durationSeconds, ...(startCue?.label ? { label: startCue.label } : {}) }]

  const startOffset = startCue?.offset ?? 0
  const bounds: Array<{ start: number, end: number, label?: string }> = []
  let previous: { offset: number, label?: string } = { offset: startOffset, ...(startCue?.label ? { label: startCue.label } : {}) }
  for (const cue of [...switches, { type: TimingCueType.End, offset: startOffset + durationSeconds * 1000, label: undefined }]) {
    bounds.push({
      start: (previous.offset - startOffset) / 1000,
      end: Math.min(durationSeconds, (cue.offset - startOffset) / 1000),
      ...(previous.label ? { label: previous.label } : {})
    })
    previous = cue
  }
  return bounds
}

/**
 * The pace through the event, one value per second.
 *
 * Counting the steps that land in each second can only ever produce whole
 * numbers, which both throws away precision and makes the plot jump between
 * neighbouring integers even when the athlete is holding a steady rhythm.
 * Instead the gap between each pair of steps gives a rate that holds until
 * the next step, and every second reports the time-weighted average of the
 * rates covering it. A second the athlete did not step through keeps its
 * uncovered time at zero, so a catch still shows as a dip.
 */
function paceSeries (steps: ReadonlyArray<{ timestamp: number, value: number }>, start: number, buckets: number): number[] {
  const series = new Array<number>(buckets).fill(0)

  let from = start
  for (const step of steps) {
    const to = step.timestamp
    const span = to - from
    from = to
    if (span <= 0) continue

    const rate = (step.value / span) * 1000
    const first = Math.max(0, Math.floor((to - span - start) / 1000))
    const last = Math.min(buckets - 1, Math.floor((to - start) / 1000))
    for (let idx = first; idx <= last; idx++) {
      const bucketFrom = start + idx * 1000
      const overlap = Math.min(to, bucketFrom + 1000) - Math.max(to - span, bucketFrom)
      if (overlap > 0) series[idx] += (rate * overlap) / 1000
    }
  }

  return series.map(round2)
}

/**
 * Derives pacing statistics from a mark stream.
 *
 * Only step marks with a positive value are considered, the optional start
 * mark pins the start of the event, otherwise the first step is the start.
 * When the event has a total duration that is used as the duration, otherwise
 * the time from the start to the last step is used.
 */
export function analyseMarks (rawMarks: readonly SpeedMark[], totalDuration: number, timingTrack?: TimingTrack | null): SpeedAnalysis | null {
  const marks = filterMarkStream(rawMarks as Parameters<typeof filterMarkStream>[0])
  const steps = marks
    .filter(mark => mark.schema === 'step' && (mark.value ?? 1) > 0)
    .map(mark => ({ timestamp: mark.timestamp, value: mark.value ?? 1 }))
    .sort((a, b) => a.timestamp - b.timestamp)
  if (steps.length === 0) return null

  const start = eventStart(marks, steps[0].timestamp, timingTrack)
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
  const stepsPerSecondSeries = paceSeries(steps, start, buckets)

  const segments: SpeedSegment[] = segmentBounds(duration, timingTrack).map((bounds, index) => {
    const from = start + bounds.start * 1000
    const to = start + bounds.end * 1000
    const segmentCount = steps
      .filter(step => step.timestamp >= from && step.timestamp < to)
      .reduce((acc, step) => acc + step.value, 0)
    const seconds = bounds.end - bounds.start
    return {
      index,
      ...(bounds.label ? { label: bounds.label } : {}),
      start: round2(bounds.start),
      end: round2(bounds.end),
      count: segmentCount,
      stepsPerSecond: seconds > 0 ? round2(segmentCount / seconds) : 0
    }
  })

  return {
    duration: round2(duration),
    stepsPerSecond: round2(stepsPerSecond),
    maxStepsPerSecond: round2(maxStepsPerSecond),
    misses,
    stepsLost,
    stepsPerSecondSeries,
    segments
  }
}

/**
 * The snapshot taken when the result was recorded wins. Falling back to the
 * event's own cues is only safe for a custom event, whose cues are stored on
 * the result itself: a known event's track can be edited later, and that must
 * not rewrite how an old result was segmented.
 */
export function analysisOf (result: SpeedResultDoc, eventDefinition: EventDefinitionDoc): SpeedAnalysis | null {
  const marks = marksOf(result)
  if (!marks.length) return null
  const timing = result.timingTrack ?? (result.eventDefinitionId ? null : eventDefinition.timingTrack)
  return analyseMarks(marks, eventDefinition.totalDuration, timing)
}
