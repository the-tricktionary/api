import z from 'zod'

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
