import { NotFoundError, ValidationError } from '../errors.js'
import { TagValueType } from '../generated/graphql.js'
import { TRICK_TYPE_TAG_ID } from '../store/schema.js'
import { localised } from './localised.js'

import type z from 'zod'
import type { Discipline } from '../generated/graphql.js'
import type { DataSources } from '../store/firestoreDataSource.js'
import type { TagDoc, TagEnumValue, TrickDoc, TrickTagValue } from '../store/schema.js'
import type { trickTagsInputSchema } from '../validation.js'

export interface TagValueModel {
  id: string
  names: TagEnumValue['names']
}

export interface TrickTagModel {
  tag: TagDoc
  value: TrickTagValue
}

/** Allowance for floating point error when checking steps */
const STEP_EPSILON = 1e-9

/** The ID of the `trick-type` value the trick holds */
export function trickTypeOf (trick: Pick<TrickDoc, 'tags'>): string | undefined {
  const value = trick.tags[TRICK_TYPE_TAG_ID]
  return Array.isArray(value) ? value[0] : undefined
}

export function tagValues (tag: Pick<TagDoc, 'values'>): TagValueModel[] {
  return Object.entries(tag.values ?? {})
    .sort(([idA, a], [idB, b]) => a.order - b.order || idA.localeCompare(idB))
    .map(([id, value]) => ({ id, names: value.names }))
}

/** The trick type first, then by English name */
export function byTagOrder (a: TagDoc, b: TagDoc) {
  if (!!a.system !== !!b.system) return a.system ? -1 : 1
  return localised(a.names).localeCompare(localised(b.names)) || a.id.localeCompare(b.id)
}

export function tagAppliesTo (tag: Pick<TagDoc, 'disciplines'>, discipline: Discipline) {
  return tag.disciplines.length === 0 || tag.disciplines.includes(discipline)
}

function describeNumberRange (tag: Pick<TagDoc, 'min' | 'max' | 'step'>) {
  const parts = []
  if (tag.min != null) parts.push(`at least ${tag.min}`)
  if (tag.max != null) parts.push(`at most ${tag.max}`)
  if (tag.step != null) parts.push(`a whole number of steps of ${tag.step} from ${tag.min ?? 0}`)
  return parts.join(', ')
}

function numberAllowed (tag: Pick<TagDoc, 'min' | 'max' | 'step'>, value: number) {
  if (!Number.isFinite(value)) return false
  if (tag.min != null && value < tag.min) return false
  if (tag.max != null && value > tag.max) return false
  if (tag.step != null) {
    const steps = (value - (tag.min ?? 0)) / tag.step
    if (Math.abs(steps - Math.round(steps)) > STEP_EPSILON) return false
  }
  return true
}

/** Why a trick of the discipline can't hold the value, null when it can */
export function trickTagProblem (tag: TagDoc, value: TrickTagValue, discipline: Discipline): string | null {
  if (!tagAppliesTo(tag, discipline)) return `the tag ${tag.id} does not apply to ${discipline} tricks`

  switch (tag.valueType) {
    case TagValueType.Flag:
      return value === true ? null : `the tag ${tag.id} holds no value`
    case TagValueType.Number:
      if (typeof value !== 'number') return `the tag ${tag.id} holds a number`
      return numberAllowed(tag, value) ? null : `the tag ${tag.id} holds numbers ${describeNumberRange(tag)}`
    case TagValueType.Enum: {
      if (!Array.isArray(value) || value.length === 0) return `the tag ${tag.id} holds one of its values`
      if (tag.multiple !== true && value.length > 1) return `the tag ${tag.id} holds only one of its values`
      if (new Set(value).size !== value.length) return `a value of the tag ${tag.id} is given more than once`
      const unknown = value.find(valueId => tag.values?.[valueId] == null)
      return unknown == null ? null : `the tag ${tag.id} has no value ${unknown}`
    }
    default:
      return `the tag ${tag.id} has an unknown type`
  }
}

/** The tags the discipline requires that the trick lacks */
export function missingRequiredTags (values: TrickDoc['tags'], discipline: Discipline, tags: readonly TagDoc[]) {
  return tags.filter(tag => tag.required === true && tagAppliesTo(tag, discipline) && values[tag.id] == null)
}

/** Refused unless every tag fits the discipline and the discipline's required tags are there */
function assertTrickTags (values: TrickDoc['tags'], discipline: Discipline, tags: readonly TagDoc[], refusal: string) {
  const byId = new Map(tags.map(tag => [tag.id, tag]))
  const problems = [
    ...Object.entries(values).flatMap(([tagId, value]) => {
      const tag = byId.get(tagId)
      const problem = tag != null ? trickTagProblem(tag, value, discipline) : `there is no tag ${tagId}`
      return problem != null ? [problem] : []
    }),
    ...missingRequiredTags(values, discipline, tags).map(tag => `the tag ${tag.id} is required on ${discipline} tricks`)
  ]
  if (problems.length > 0) throw new ValidationError(`${refusal}: ${problems.join('; ')}`)
}

/** A trick's tags from the input, see `assertTrickTags` */
export async function trickTagsFromInput (inputs: z.output<typeof trickTagsInputSchema>, discipline: Discipline, { dataSources }: { dataSources: DataSources }) {
  const tags = await dataSources.tags.findAll()
  const byId = new Map(tags.map(tag => [tag.id, tag]))

  const values: TrickDoc['tags'] = {}
  const mismatched: string[] = []
  for (const input of inputs) {
    const tag = byId.get(input.tagId)
    if (tag == null) throw new NotFoundError(`Tag ${input.tagId} not found`, { extensions: { entity: 'tag', id: input.tagId } })
    const value = trickTagValueFromInput(tag, input)
    if (value === undefined) mismatched.push(`the tag ${tag.id} is a ${tag.valueType} tag`)
    else values[tag.id] = value
  }
  if (mismatched.length > 0) throw new ValidationError(`The tags cannot be set: ${mismatched.join('; ')}`)

  assertTrickTags(values, discipline, tags, 'The tags cannot be set')
  return values
}

/** For a trick moving to the discipline with its tags, see `assertTrickTags` */
export async function assertTrickTagsFit (values: TrickDoc['tags'], discipline: Discipline, { dataSources }: { dataSources: DataSources }) {
  assertTrickTags(values, discipline, await dataSources.tags.findAll(), `The trick cannot move to ${discipline} with its tags`)
}

/** Undefined when the input doesn't match the tag's type */
function trickTagValueFromInput (tag: Pick<TagDoc, 'valueType'>, input: { number?: number | null, values?: string[] | null }): TrickTagValue | undefined {
  switch (tag.valueType) {
    case TagValueType.Flag:
      return input.number == null && input.values == null ? true : undefined
    case TagValueType.Number:
      return input.values == null && input.number != null ? input.number : undefined
    case TagValueType.Enum:
      return input.number == null && input.values != null ? input.values : undefined
    default:
      return undefined
  }
}

// Search

/** Lowercased, the value is interpreted against the tag's type when matching */
export interface TagQueryToken {
  tagId: string
  value?: string
}

const TAG_TOKEN = /^#([a-z0-9]+(?:-[a-z0-9]+)*)(?::(\S+))?$/
const NUMBER_CONDITION = /^(>=|<=|>|<|=)?(-?\d+(?:\.\d+)?)$/

/** A `#` word that isn't a well formed token stays in the text */
export function parseTagQuery (query: string): { text: string, tokens: TagQueryToken[] } {
  const tokens: TagQueryToken[] = []
  const words: string[] = []
  for (const word of query.trim().split(/\s+/)) {
    const match = TAG_TOKEN.exec(word.toLowerCase())
    if (match != null) tokens.push({ tagId: match[1], ...(match[2] != null ? { value: match[2] } : {}) })
    else if (word !== '') words.push(word)
  }
  return { text: words.join(' '), tokens }
}

/** An unknown tag, or a value the tag can't hold, matches nothing */
function tokenMatches (token: TagQueryToken, tag: TagDoc | undefined, value: TrickTagValue | undefined) {
  if (tag == null || value == null) return false
  if (token.value == null) return true

  switch (tag.valueType) {
    case TagValueType.Number: {
      const condition = NUMBER_CONDITION.exec(token.value)
      if (!condition || typeof value !== 'number') return false
      const target = parseFloat(condition[2])
      switch (condition[1]) {
        case '>': return value > target
        case '>=': return value >= target
        case '<': return value < target
        case '<=': return value <= target
        default: return Math.abs(value - target) <= STEP_EPSILON
      }
    }
    case TagValueType.Enum:
      return Array.isArray(value) && value.includes(token.value)
    default:
      return false
  }
}

/** `tags` has to hold at least the tags the tokens name */
export function matchesTagQuery (trick: Pick<TrickDoc, 'tags'>, tokens: readonly TagQueryToken[], tags: ReadonlyMap<string, TagDoc>) {
  return tokens.every(token => tokenMatches(token, tags.get(token.tagId), trick.tags[token.tagId]))
}

/** The names of a trick's tags and of the enum values it holds */
export function tagSearchNames (values: Record<string, TrickTagValue>, tags: ReadonlyMap<string, TagDoc>, lang: string) {
  const names = new Set<string>()
  for (const [tagId, value] of Object.entries(values)) {
    const tag = tags.get(tagId)
    if (tag == null) continue
    names.add(localised(tag.names, lang))
    if (!Array.isArray(value)) continue
    for (const valueId of value) {
      const enumValue = tag.values?.[valueId]
      if (enumValue != null) names.add(localised(enumValue.names, lang))
    }
  }
  names.delete('')
  return [...names]
}
