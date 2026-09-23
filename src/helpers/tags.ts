import { TagValueType, TrickType } from '../generated/graphql.js'
import { TRICK_TYPE_TAG_ID } from '../store/schema.js'

import type { Discipline } from '../generated/graphql.js'
import type { TagDoc, TagEnumValue, TrickDoc, TrickTagValue } from '../store/schema.js'

/** A value of an enum tag as the schema's `TagValue` */
export interface TagValueModel {
  id: string
  names: TagEnumValue['names']
}

/** A tag on a trick as the schema's `TrickTag` */
export interface TrickTagModel {
  tag: TagDoc
  value: TrickTagValue
}

/** How close to a whole number of steps a number has to be, floats being floats */
const STEP_EPSILON = 1e-9

function isTrickType (value: unknown): value is TrickType {
  return (Object.values(TrickType) as unknown[]).includes(value)
}

/**
 * The tags a trick carries. A trick written before the trick type became a tag
 * only has the legacy `trickType` field, which stands in for the tag.
 */
export function trickTagValues (trick: Pick<TrickDoc, 'tags' | 'trickType'>): Record<string, TrickTagValue> {
  const tags = { ...trick.tags }
  if (tags[TRICK_TYPE_TAG_ID] == null && isTrickType(trick.trickType)) tags[TRICK_TYPE_TAG_ID] = [trick.trickType]
  return tags
}

/** The trick type, from the `trick-type` tag or, before a trick has one, the legacy field */
export function trickTypeOf (trick: Pick<TrickDoc, 'tags' | 'trickType'>): TrickType {
  const value = trick.tags?.[TRICK_TYPE_TAG_ID]
  const [fromTag] = Array.isArray(value) ? value : []
  return isTrickType(fromTag) ? fromTag : trick.trickType
}

/** The `tags` field of a trick of this type, the trick type tag is always an array like any enum tag's */
export function trickTypeTag (trickType: TrickType): Record<string, TrickTagValue> {
  return { [TRICK_TYPE_TAG_ID]: [trickType] }
}

/** A name in `lang`, falling back to english */
export function localisedName (names: Record<string, string>, lang?: string | null) {
  return names[lang ?? 'en'] ?? names.en ?? ''
}

/** A `lang -> value` map as the schema's `LocalisedString`s, sorted by language */
export function localisedStrings (names: Record<string, string>) {
  return Object.entries(names)
    .map(([lang, value]) => ({ lang, value }))
    .sort((a, b) => a.lang.localeCompare(b.lang))
}

/** The values of an enum tag in order */
export function tagValues (tag: Pick<TagDoc, 'values'>): TagValueModel[] {
  return Object.entries(tag.values ?? {})
    .sort(([idA, a], [idB, b]) => a.order - b.order || idA.localeCompare(idB))
    .map(([id, value]) => ({ id, names: value.names }))
}

/** The trick type first, then by english name */
export function byTagOrder (a: TagDoc, b: TagDoc) {
  if (!!a.system !== !!b.system) return a.system ? -1 : 1
  return localisedName(a.names).localeCompare(localisedName(b.names)) || a.id.localeCompare(b.id)
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

/**
 * Why a trick of the discipline couldn't hold the value under the tag as
 * defined, null when it can
 */
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
      if (!tag.multiple && value.length > 1) return `the tag ${tag.id} holds only one of its values`
      if (new Set(value).size !== value.length) return `a value of the tag ${tag.id} is given more than once`
      const unknown = value.find(valueId => tag.values?.[valueId] == null)
      return unknown == null ? null : `the tag ${tag.id} has no value ${unknown}`
    }
    default:
      return `the tag ${tag.id} has an unknown type`
  }
}

/** What a trick holds of a tag, from the schema's `TrickTagInput`, not yet checked against the tag */
export function trickTagValueFromInput (tag: Pick<TagDoc, 'valueType'>, input: { number?: number | null, values?: string[] | null }): TrickTagValue | undefined {
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

/** A `#tag` or `#tag:value` token of a search query, lowercased, the value not yet made sense of */
export interface TagQueryToken {
  tagId: string
  value?: string
}

const TAG_TOKEN = /^#([a-z0-9]+(?:-[a-z0-9]+)*)(?::(\S+))?$/
const NUMBER_CONDITION = /^(>=|<=|>|<|=)?(-?\d+(?:\.\d+)?)$/

/**
 * Splits the `#tag` and `#tag:value` tokens out of a search query. A `#`
 * word that isn't a well formed tag token is left in the text.
 */
export function parseTagQuery (query: string): { text: string, tokens: TagQueryToken[] } {
  const tokens: TagQueryToken[] = []
  const words: string[] = []
  for (const word of query.trim().split(/\s+/)) {
    const match = TAG_TOKEN.exec(word.toLowerCase())
    if (match) tokens.push({ tagId: match[1], ...(match[2] != null ? { value: match[2] } : {}) })
    else if (word !== '') words.push(word)
  }
  return { text: words.join(' '), tokens }
}

/**
 * Whether a trick matches a token under the tag it names. An unknown tag, and
 * a value the tag could never hold, match nothing.
 */
function tokenMatches (token: TagQueryToken, tag: TagDoc | undefined, value: TrickTagValue | undefined) {
  if (!tag || value == null) return false
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

/** Whether a trick matches every token, `tags` holds at least the tags the tokens name */
export function matchesTagQuery (trick: Pick<TrickDoc, 'tags' | 'trickType'>, tokens: readonly TagQueryToken[], tags: ReadonlyMap<string, TagDoc>) {
  const values = trickTagValues(trick)
  return tokens.every(token => tokenMatches(token, tags.get(token.tagId), values[token.tagId]))
}

/**
 * The names a trick is found by through its tags in a language: the tags'
 * names, and the names of the enum values it holds
 */
export function tagSearchNames (values: Record<string, TrickTagValue>, tags: ReadonlyMap<string, TagDoc>, lang: string) {
  const names = new Set<string>()
  for (const [tagId, value] of Object.entries(values)) {
    const tag = tags.get(tagId)
    if (!tag) continue
    names.add(localisedName(tag.names, lang))
    if (!Array.isArray(value)) continue
    for (const valueId of value) {
      const enumValue = tag.values?.[valueId]
      if (enumValue) names.add(localisedName(enumValue.names, lang))
    }
  }
  names.delete('')
  return [...names]
}
