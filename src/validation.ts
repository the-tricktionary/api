import { Timestamp } from '@google-cloud/firestore'
import z from 'zod'
import { GrantType, GroupRole, TimingCueType, VerificationLevel } from './generated/graphql.js'

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

const grantInputSchema = z.discriminatedUnion('type', [
  superAdminGrantSchema,
  trickEditorGrantSchema,
  translatorGrantSchema,
  levelEditorGrantSchema,
  speedEditorGrantSchema
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

export const speedResultCreateSchema = z.object({
  name: speedResultNameSchema.nullish(),
  count: speedResultCountSchema.nullish(),
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
}).transform(track => ({
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

// Users

/** A profile's handle, e.g. `jane.doe`, lowercased */
export const usernameSchema = z.string().trim().toLowerCase()
  .regex(/^[a-z0-9][a-z0-9._-]{1,28}[a-z0-9]$/, 'A username is 3 to 30 characters of lowercase letters, digits, dots, dashes or underscores, and starts and ends with a letter or digit')

export const userNameSchema = z.string().trim()
  .min(1, 'A name is required')
  .max(120, 'A name can be at most 120 characters')

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
