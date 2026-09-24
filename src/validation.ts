import { Timestamp } from '@google-cloud/firestore'
import z from 'zod'
import { Discipline, GrantType, GroupRole, Scope, TagValueType, TimingCueType, VerificationLevel, VideoType } from './generated/graphql.js'
import { DISCIPLINE_SLUGS, disciplineFromSlug } from './helpers/disciplines.js'
import { originPattern } from './helpers/cors.js'

import type { Grant } from './store/schema.js'

/** A BCP-47-ish language tag, normalised to lowercase, e.g. `en`, `sv` or `pt-br` */
export const langSchema = z.string().trim()
  .regex(/^[a-z]{2,3}(-[a-z0-9]{2,8})*$/i, 'A language tag must be a BCP-47 tag such as `en` or `pt-br`')
  .transform(lang => lang.toLowerCase())

/** e.g. `frog`, `toad-crossover` */
export const slugSchema = z.string().trim()
  .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, 'A slug may only contain lowercase letters and numbers, separated by single dashes')

/** e.g. `tricktionary`, `ijru@5.0.0` */
export const rulesIdSchema = z.string()
  .regex(/^[a-z0-9-]+(@[0-9]+(\.[0-9]+)*)?$/, 'A rules ID may only contain lowercase letters, numbers and dashes, optionally followed by a version (e.g. `ijru@5.0.0`)')

/** A list of `{ lang, value }` pairs turned into a `lang -> value` map, `en` is required */
export const localisedStringsSchema = z.array(z.object({
  lang: langSchema,
  value: z.string().trim().min(1, 'A value is required')
}))
  .min(1, 'At least one value is required')
  .refine(values => new Set(values.map(value => value.lang)).size === values.length, 'Each language may only be specified once')
  .refine(values => values.some(value => value.lang === 'en'), 'An english (`en`) value is required')
  .transform(values => Object.fromEntries(values.map(value => [value.lang, value.value])))

/** A dotted path into the interface message tree, e.g. `nav.tricks` or `trick.level` */
export const uiMessageKeySchema = z.string().trim()
  .regex(/^[A-Za-z][A-Za-z0-9]*(\.[A-Za-z][A-Za-z0-9]*)*$/, 'A message key is a dot separated path of alphanumeric parts, such as `trick.level` or `enums.discipline.DoubleDutch`')

/** A list of `{ key, value, source }` triples, an empty or absent value removes the key */
export const uiMessagesSchema = z.array(z.object({
  key: uiMessageKeySchema,
  value: z.string().trim().nullish(),
  source: z.string().trim().nullish()
}))
  .refine(entries => new Set(entries.map(entry => entry.key)).size === entries.length, 'Each key may only be specified once')

export const trickLocalisationSchema = z.object({
  name: z.string().trim().min(1, 'A name is required'),
  alternativeNames: z.array(z.string())
    .transform(names => names.map(name => name.trim()).filter(name => name.length > 0)),
  description: z.string().trim()
})

/**
 * A single level, e.g. `5`, `0.5`, `3+` or `1-`: a number with an optional
 * `+`/`-` modifier. Dashes join levels into a combo (`5-2`), commas separate
 * alternatives (`5-2, 3+, 1-`).
 */
const singleLevel = /\d+(\.\d+)?[+-]?/
const levelCombo = new RegExp(`^${singleLevel.source}(-${singleLevel.source})*$`)

export const levelSchema = z.string().trim()
  .transform(level => level.split(',').map(part => part.trim()))
  .refine(parts => parts.every(part => levelCombo.test(part)), 'A level is a list of levels such as `5`, `2-5`, `5+, 2` or `5-2, 3+, 1-`')
  .transform(parts => parts.join(', '))

/** the tricktionary's own levels are a single number from 1 to 5 */
export const tricktionaryLevelSchema = z.string().trim()
  .regex(/^[1-5]$/, 'A tricktionary level must be a whole number between 1 and 5')

/** The 11 character ID YouTube identifies a video by, e.g. `dQw4w9WgXcQ` */
export const youTubeVideoIdSchema = z.string().trim()
  .regex(/^[A-Za-z0-9_-]{11}$/, 'A YouTube video ID is 11 letters, digits, dashes or underscores')

// z.number() already rejects NaN and infinities in zod 4
export const slowMoStartSchema = z.number()
  .min(0, 'A slow motion start cannot be negative')
  .nullish()

// Attribution

/** The name a contributor is credited by */
const attributionNameSchema = z.string().trim()
  .min(1, 'A name to be credited by is required')
  .max(100, 'A name can be at most 100 characters')

export const attributionInputSchema = z.object({
  name: attributionNameSchema,
  usernameOrId: z.string().trim().min(1).nullish()
})

// Tags

const MAX_TAG_VALUES = 50

/** Also the ID of an enum tag's value */
export const tagSlugSchema = slugSchema.max(40, 'A slug can be at most 40 characters')

export const tagIdSchema = z.string().regex(/^[\w-]{1,64}$/, 'That is not a tag ID')

const tagNameSchema = z.string().trim().max(60, 'A name can be at most 60 characters')
const requiredTagNameSchema = tagNameSchema.min(1, 'A name is required')

const tagNumberSchema = z.number().min(-1_000_000).max(1_000_000)

export const tagInputSchema = z.object({
  name: requiredTagNameSchema,
  valueType: z.enum(TagValueType),
  disciplines: z.array(z.enum(Discipline))
    .refine(disciplines => new Set(disciplines).size === disciplines.length, 'Each discipline may only be listed once'),
  min: tagNumberSchema.nullish(),
  max: tagNumberSchema.nullish(),
  step: tagNumberSchema.positive('A step has to be more than 0').nullish(),
  multiple: z.boolean().nullish(),
  values: z.array(z.object({ id: tagSlugSchema, name: requiredTagNameSchema }))
    .max(MAX_TAG_VALUES, `A tag can have at most ${MAX_TAG_VALUES} values`)
    .refine(values => new Set(values.map(value => value.id)).size === values.length, 'Each value may only be listed once')
    .nullish(),
  required: z.boolean().nullish()
})
  .refine(
    tag => tag.valueType === TagValueType.Number || (tag.min == null && tag.max == null && tag.step == null),
    'Only a number tag has a minimum, maximum or step'
  )
  .refine(tag => tag.min == null || tag.max == null || tag.min <= tag.max, 'The minimum cannot be above the maximum')
  .refine(
    tag => tag.valueType === TagValueType.Enum || (tag.multiple == null && tag.values == null),
    'Only an enum tag has values'
  )
  .refine(tag => tag.valueType !== TagValueType.Enum || (tag.values?.length ?? 0) > 0, 'An enum tag needs at least one value')
  .refine(tag => tag.valueType !== TagValueType.Flag || tag.required !== true, 'A flag tag cannot be required, every trick would carry it')

/** An empty name removes the translation */
export const tagLocalisationSchema = z.object({
  name: tagNameSchema.nullish(),
  values: z.array(z.object({ id: tagSlugSchema, name: tagNameSchema.nullish() }))
    .refine(values => new Set(values.map(value => value.id)).size === values.length, 'Each value may only be listed once')
    .nullish()
})

export const trickTagsInputSchema = z.array(z.object({
  tagId: tagIdSchema,
  number: z.number().nullish(),
  values: z.array(tagSlugSchema).nullish()
}))
  .refine(tags => new Set(tags.map(tag => tag.tagId)).size === tags.length, 'Each tag may only be listed once')

export const trickTagFiltersSchema = z.array(z.object({
  slug: tagSlugSchema,
  values: z.array(tagSlugSchema).min(1, 'Leave values out rather than empty').nullish(),
  min: z.number().nullish(),
  max: z.number().nullish()
}))

// Tricks

export const createTrickSchema = z.object({
  discipline: z.enum(Discipline),
  slug: slugSchema,
  localisation: trickLocalisationSchema,
  tags: trickTagsInputSchema
})

export const updateTrickDetailsSchema = z.object({
  discipline: z.enum(Discipline).nullish(),
  slug: slugSchema.nullish(),
  tags: trickTagsInputSchema.nullish()
})

export const optionalAttributionSchema = attributionInputSchema.nullish()

export const youTubeVideoSchema = z.object({
  videoId: youTubeVideoIdSchema,
  type: z.enum(VideoType),
  slowMoStart: slowMoStartSchema,
  attribution: optionalAttributionSchema
})

export const videoUploadSchema = z.object({
  type: z.enum(VideoType),
  slowMoStart: slowMoStartSchema,
  attribution: optionalAttributionSchema
})

// Trick submissions

export const trickSubmissionSchema = z.object({
  discipline: z.enum(Discipline),
  lang: langSchema.nullish(),
  name: trickLocalisationSchema.shape.name,
  alternativeNames: trickLocalisationSchema.shape.alternativeNames.nullish(),
  description: trickLocalisationSchema.shape.description.nullish(),
  attributionName: attributionNameSchema,
  acceptLicence: z.literal(true, 'The submission has to be licensed under CC BY 4.0 to be accepted')
})

export const acceptTrickSubmissionSchema = z.object({
  discipline: z.enum(Discipline),
  slug: slugSchema,
  localisation: trickLocalisationSchema,
  tags: trickTagsInputSchema,
  videoType: z.enum(VideoType),
  slowMoStart: slowMoStartSchema
})

export const reviewNoteSchema = z.string().trim()
  .max(500, 'A note can be at most 500 characters')

const superAdminGrantSchema = z.strictObject({ type: z.literal(GrantType.SuperAdmin) })
const trickEditorGrantSchema = z.strictObject({ type: z.literal(GrantType.TrickEditor) })
const translatorGrantSchema = z.strictObject({
  type: z.literal(GrantType.Translator),
  lang: langSchema.refine(lang => lang !== 'en', 'A Translator grant may not be for english, english is edited by a TrickEditor')
})
const levelEditorGrantSchema = z.strictObject({
  type: z.literal(GrantType.LevelEditor),
  rulesId: rulesIdSchema,
  verificationLevel: z.enum(VerificationLevel).nullish()
})
const speedEditorGrantSchema = z.strictObject({ type: z.literal(GrantType.SpeedEditor) })
const tagWranglerGrantSchema = z.strictObject({ type: z.literal(GrantType.TagWrangler) })

const grantInputSchema = z.discriminatedUnion('type', [
  superAdminGrantSchema,
  trickEditorGrantSchema,
  translatorGrantSchema,
  levelEditorGrantSchema,
  speedEditorGrantSchema,
  tagWranglerGrantSchema
])

export const grantsSchema = z.array(grantInputSchema)
  .refine(grants => {
    const keys = grants.map(grant => {
      if (grant.type === GrantType.Translator) return `${grant.type}:${grant.lang}`
      if (grant.type === GrantType.LevelEditor) return `${grant.type}:${grant.rulesId}`
      return grant.type
    })
    return new Set(keys).size === keys.length
  }, 'Each grant may only be specified once')
  .transform((grants): Grant[] => grants.map(grant => grant.type === GrantType.LevelEditor
    ? {
        type: grant.type,
        rulesId: grant.rulesId,
        ...(grant.verificationLevel != null ? { verificationLevel: grant.verificationLevel } : {})
      }
    : grant
  ))

// Speed results

const MAX_MARKS = 20_000
const MAX_SEGMENTS = 50

const speedResultNameSchema = z.string().trim().max(120)
const speedResultCountSchema = z.number().int().min(0).max(1_000_000)

/**
 * A cue on a custom relay. The event's clock runs from zero to its total
 * duration, so an end cue has nothing to say and a start cue can only sit at
 * zero, where it exists to name the opening stretch: every segment takes the
 * label of the cue that opens it, and without one the first would have none.
 */
const customEventCueSchema = z.object({
  type: z.enum(TimingCueType),
  offset: z.number().int().min(0).max(3_600_000),
  label: z.string().trim().max(40).nullish()
})

/** A custom event definition embedded in a speed result, duration in seconds */
export const eventDefinitionInputSchema = z.object({
  name: z.string().trim().min(1).max(120),
  totalDuration: z.number().int().min(0).max(3_600),
  cues: z.array(customEventCueSchema).max(50)
    .refine(
      cues => cues.every(cue => cue.type !== TimingCueType.End),
      'A custom event ends at its total duration, so it has no end cue'
    )
    .refine(
      cues => cues.filter(cue => cue.type === TimingCueType.Start).length <= 1,
      'A custom event can only have one start cue'
    )
    .refine(
      cues => cues.every(cue => cue.type !== TimingCueType.Start || cue.offset === 0),
      'A custom event starts at zero, so its start cue can only sit there to name the opening stretch'
    )
    .refine(
      cues => cues.every(cue => cue.type !== TimingCueType.Switch || cue.offset >= 1),
      'A switch cannot happen before the event starts'
    )
    .refine(
      cues => new Set(cues.map(cue => cue.offset)).size === cues.length,
      'Two cues cannot share an offset'
    )
    .nullish()
})
  .refine(
    data => !data.cues?.length || (data.totalDuration > 0 && data.cues.every(cue => cue.offset < data.totalDuration * 1000)),
    'Cues must fall inside the event, which needs a total duration'
  )
  .transform(data => ({
    name: data.name,
    totalDuration: data.totalDuration,
    ...(data.cues?.length
      ? {
          cues: [...data.cues]
            .sort((a, b) => a.offset - b.offset)
            .map(cue => ({
              type: cue.type,
              offset: cue.offset,
              ...(cue.label ? { label: cue.label } : {})
            }))
        }
      : {})
  }))

/** One mark of a rulesets-compatible mark stream, the timestamp arrives parsed by the Timestamp scalar */
export const speedMarkSchema = z.object({
  sequence: z.number().int().min(0),
  timestamp: z.instanceof(Timestamp),
  schema: z.string().trim().min(1).max(32),
  value: z.number().nullish(),
  target: z.number().int().min(0).nullish()
})

export const speedParticipantSchema = z.object({
  segmentIndex: z.number().int().min(0).max(MAX_SEGMENTS - 1).nullish(),
  memberId: z.string().min(1)
})

const speedParticipantsSchema = z.array(speedParticipantSchema).max(MAX_SEGMENTS)

const speedSegmentCountsSchema = z.array(z.number().int().min(0)).min(2).max(MAX_SEGMENTS)

export const speedResultCreateSchema = z.object({
  name: speedResultNameSchema.nullish(),
  count: speedResultCountSchema.nullish(),
  segmentCounts: speedSegmentCountsSchema.nullish(),
  marks: z.array(speedMarkSchema).max(MAX_MARKS).nullish(),
  withTimingTrack: z.boolean().nullish(),
  eventDefinitionId: z.string().min(1).nullish(),
  eventDefinition: eventDefinitionInputSchema.nullish(),
  groupId: z.string().min(1).nullish(),
  participants: speedParticipantsSchema.nullish()
})

export const speedResultUpdateSchema = z.object({
  name: speedResultNameSchema.nullish(),
  count: speedResultCountSchema.nullish(),
  segmentCounts: speedSegmentCountsSchema.nullish(),
  eventDefinitionId: z.string().min(1).nullish(),
  eventDefinition: eventDefinitionInputSchema.nullish()
})

export const speedResultGroupSchema = z.object({
  groupId: z.string().min(1).nullish(),
  participants: speedParticipantsSchema
})

// Event definitions and timing tracks

/** Rulesets competition event lookup codes look like e.ijru.sp.sr.srss.1.30 */
export const eventLookupCodeSchema = z.string().trim()
  .regex(/^e\.[a-z0-9-]+\.(fs|sp|oa)\.(sr|dd|wh|ts|xd)\.[a-z0-9-]+\.\d+\.(\d+x)?\d+$/, 'A lookup code looks like e.ijru.sp.sr.srss.1.30')

const eventDefinitionNameSchema = z.string().trim().min(1, 'A name is required').max(120)
const eventDefinitionDurationSchema = z.number().int().min(0).max(3_600)

const timingCueSchema = z.object({
  type: z.enum(TimingCueType),
  // an hour of audio, same cap as an event
  offset: z.number().int().min(0).max(3_600_000),
  label: z.string().trim().max(40).nullish()
})

export const timingTrackInputSchema = z.object({
  /** Absent for an event whose cues are known but which has no audio to play */
  audioUrl: z.url().nullish(),
  cues: z.array(timingCueSchema).max(50)
    .refine(cues => cues.filter(cue => cue.type === TimingCueType.Start).length <= 1, 'A track can only have one start cue')
    .refine(cues => cues.filter(cue => cue.type === TimingCueType.End).length <= 1, 'A track can only have one end cue')
    .refine(cues => {
      const start = cues.find(cue => cue.type === TimingCueType.Start)?.offset ?? -Infinity
      const end = cues.find(cue => cue.type === TimingCueType.End)?.offset ?? Infinity
      return start < end && cues.every(cue => cue.type !== TimingCueType.Switch || (cue.offset > start && cue.offset < end))
    }, 'Switch cues must lie between the start and end cues')
    .transform(cues => [...cues]
      .sort((a, b) => a.offset - b.offset)
      .map(cue => ({
        type: cue.type,
        offset: cue.offset,
        ...(cue.label ? { label: cue.label } : {})
      }))
    )
})
  // Without audio the offsets are measured from the go signal rather than
  // into a recording, the same clock a custom event's cues run on, so the
  // same rules apply
  .refine(
    track => track.audioUrl != null || track.cues.every(cue => cue.type !== TimingCueType.End),
    'A track without audio runs to the total duration of the event, so it has no end cue'
  )
  .refine(
    track => track.audioUrl != null || track.cues.every(cue => cue.type !== TimingCueType.Start || cue.offset === 0),
    'A track without audio starts at zero, so its start cue can only sit there to name the opening stretch'
  )
  .refine(
    track => track.audioUrl != null || track.cues.every(cue => cue.type !== TimingCueType.Switch || cue.offset >= 1),
    'A switch cannot happen before the event starts'
  )
  .transform(track => ({
    ...(track.audioUrl ? { audioUrl: track.audioUrl } : {}),
    cues: track.cues
  }))

/** A track is uploaded against an existing definition, so it can only be attached on update */
export const eventDefinitionCreateSchema = z.object({
  name: eventDefinitionNameSchema,
  totalDuration: eventDefinitionDurationSchema,
  lookupCode: eventLookupCodeSchema.nullish()
})

export const eventDefinitionUpdateSchema = z.object({
  name: eventDefinitionNameSchema.optional(),
  totalDuration: eventDefinitionDurationSchema.optional(),
  lookupCode: eventLookupCodeSchema.nullish(),
  timingTrack: timingTrackInputSchema.nullish()
})

// Notices

const noticeUrlSchema = z.union([
  z.string().trim().max(2000).regex(/^\/(?!\/)\S*$/),
  z.url({ protocol: /^(https?|mailto)$/ }).max(2000)
], 'A link must be a path such as `/tricks`, an absolute http(s) URL or a mailto: address')

const noticeTextSchema = z.object({
  lang: langSchema,
  body: z.string().trim().min(1, 'A body is required').max(1000, 'A body can be at most 1000 characters'),
  linkLabels: z.array(z.string().trim().min(1, 'A label is required').max(100, 'A label can be at most 100 characters'))
})

export const noticeSchema = z.object({
  from: z.instanceof(Timestamp).nullish(),
  until: z.instanceof(Timestamp).nullish(),
  linkUrls: z.array(noticeUrlSchema).max(5, 'A notice can have at most 5 links'),
  texts: z.array(noticeTextSchema)
    .refine(texts => new Set(texts.map(text => text.lang)).size === texts.length, 'Each language may only be specified once')
    .refine(texts => texts.some(text => text.lang === 'en'), 'An english (`en`) text is required')
})
  .refine(
    notice => notice.from == null || notice.until == null || notice.until.toMillis() > notice.from.toMillis(),
    'A notice cannot stop showing before it starts'
  )
  .refine(
    notice => notice.texts.every(text => text.linkLabels.length === notice.linkUrls.length),
    'Every language needs one label per link'
  )

// Users

/** A profile's handle, e.g. `jane.doe`, lowercased */
export const usernameSchema = z.string().trim().toLowerCase()
  .regex(/^[a-z0-9][a-z0-9._-]{1,28}[a-z0-9]$/, 'A username is 3 to 30 characters of lowercase letters, digits, dots, dashes or underscores, and starts and ends with a letter or digit')

export const userNameSchema = z.string().trim()
  .min(1, 'A name is required')
  .max(120, 'A name can be at most 120 characters')

export const notificationOptionsSchema = z.object({
  adminDigest: z.boolean()
})

export const profileOptionsSchema = z.object({
  public: z.boolean(),
  checklist: z.boolean(),
  speed: z.boolean()
}).transform(options => ({
  public: options.public,
  // a private profile shows nothing, so its details are stored off
  checklist: options.public && options.checklist,
  speed: options.public && options.speed
}))

/** Sets every field, a missing username means none */
export const userProfileInputSchema = z.object({
  name: userNameSchema,
  username: usernameSchema.nullish().transform(username => username ?? null)
})

// Groups

export const groupNameSchema = z.string().trim()
  .min(1, 'A name is required')
  .max(60, 'A name can be at most 60 characters')

/** The name of an athlete a group manages, who has no account to carry one */
export const groupAthleteNameSchema = z.string().trim()
  .min(1, 'A name is required')
  .max(80, 'A name can be at most 80 characters')

/**
 * A join code as somebody types it back in: case and any spaces or dashes they
 * added to make it readable are forgiven, the alphabet is not.
 */
export const joinCodeSchema = z.string()
  .transform(code => code.replace(/[\s-]/g, '').toUpperCase())
  .refine(code => /^[A-HJKMNP-Z2-9]{8}$/.test(code), 'A join code is 8 letters and digits')

export const groupMemberInputSchema = z.object({
  name: groupAthleteNameSchema.nullish(),
  role: z.enum(GroupRole),
  observer: z.boolean()
})

// Booklets

export const PAPERS = ['a4', 'letter'] as const
export type Paper = typeof PAPERS[number]

export const LAYOUTS = ['pages', 'booklet', 'print'] as const
export type Layout = typeof LAYOUTS[number]

/** The digits of an ISBN-13, or null when it isn't one: 13 digits, a 978 or 979 prefix and a correct check digit */
export function isbnDigits (isbn: string): string | null {
  const digits = isbn.replace(/[-\s]/g, '')
  if (!/^97[89]\d{10}$/.test(digits)) return null
  const sum = Array.from(digits, Number).reduce((acc, digit, idx) => acc + digit * (idx % 2 === 0 ? 1 : 3), 0)
  return sum % 10 === 0 ? digits : null
}

/** The query string of `GET /booklets/tricks.pdf` */
export const bookletOptionsSchema = z.object({
  discipline: z.enum(DISCIPLINE_SLUGS).transform(disciplineFromSlug),
  paper: z.enum(PAPERS).default('a4'),
  /** The language of the booklet, English fills in for anything not translated */
  lang: langSchema.default('en'),
  /** Whether to include trick descriptions, names are always included */
  detailed: z.stringbool().default(false),
  /** A ruleset whose level each trick is labelled with, with a mark when verified */
  rulesId: rulesIdSchema.optional().transform(rulesId => rulesId ?? null),
  /**
   * `pages` typesets on the full sheet, `booklet` on half sheets that are then
   * laid out two per side for folding down the middle, `print` on half sheets
   * with bleed, a cover and a trick map, for a print shop
   */
  layout: z.enum(LAYOUTS).default('booklet'),
  /** The ISBN of the `print` layout, shown in the colophon and as a barcode on the back */
  isbn: z.string().trim()
    .refine(isbn => isbnDigits(isbn) != null, 'An ISBN is 13 digits starting with 978 or 979, optionally with dashes, and its check digit has to add up')
    .optional().transform(isbn => isbn ?? null),
  /** Who prints the `print` layout, named in its colophon */
  printedBy: z.string().trim().max(200).optional().transform(printedBy => printedBy === undefined || printedBy === '' ? null : printedBy)
})

/** An `api-clients` document. Signing users in and the admin are for the Tricktionary's own apps only. */
export const apiClientDocSchema = z.object({
  name: z.string().trim().min(1),
  contact: z.string().optional(),
  scopes: z.array(z.enum([Scope.Public, Scope.Site, Scope.Profiles])),
  origins: z.array(z.string().refine(source => {
    try {
      originPattern(source)
      return true
    } catch {
      return false
    }
  }, 'An origin has to be a regular expression')).default([]),
  disabled: z.boolean().optional()
})
