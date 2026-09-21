import { NotFoundError } from '../errors.js'
import { Discipline, TrickType } from '../generated/graphql.js'
import { disciplineSlug } from '../helpers/disciplines.js'
import { uiMessageValues } from '../helpers/uiMessages.js'
import { TRICKTIONARY_RULES_ID, trickLocalisationId } from '../store/schema.js'
import { compileTypst } from './typst.js'
import { imposeBooklet } from './imposition.js'
import { siteEnglishMessages } from './siteMessages.js'

import type Pino from 'pino'
import type { DataSources } from '../store/firestoreDataSource.js'
import type { RulesetDoc, TrickDoc, TrickLevelDoc, TrickLocalisationDoc } from '../store/schema.js'
import type { FlatMessages } from './siteMessages.js'

export const PAPERS = ['a4', 'letter'] as const
export type Paper = typeof PAPERS[number]

export const LAYOUTS = ['pages', 'booklet'] as const
export type Layout = typeof LAYOUTS[number]

export interface BookletOptions {
  discipline: Discipline
  paper: Paper
  /** The language of the booklet, English fills in for anything not translated */
  lang: string
  /** Whether to include trick descriptions, names are always included */
  detailed: boolean
  /** A ruleset whose level each trick is labelled with, or null for none */
  rulesId: string | null
  /**
   * `pages` typesets on the full sheet, `booklet` on half sheets that are then
   * laid out two per side for folding down the middle
   */
  layout: Layout
}

/** Sheet sizes in mm */
const PAPER_SIZES: Record<Paper, { width: number, height: number }> = {
  a4: { width: 210, height: 297 },
  letter: { width: 215.9, height: 279.4 }
}

const SPEED_PAGES = 4
/** The height of a speed-log table row in the template, in mm */
const SPEED_ROW_MM = 6.5
/** What the speed-log heading and the table's header row take above the rows, in mm */
const SPEED_HEADING_MM = 26

/**
 * The booklet's own labels in English, keyed like the site's `en.json`. The
 * site's copy of the same keys is what translators work from, so the wording
 * there wins whenever the site can be reached, these are the fallback.
 */
export const BOOKLET_MESSAGE_DEFAULTS: FlatMessages = {
  'booklet.info': 'Detailed information and videos of the tricks are available on the-tricktionary.com or in the Tricktionary\'s Android app.',
  'booklet.generated': 'Generated {date}',
  'booklet.speedEvent': 'Speed event',
  'booklet.date': 'Date',
  'booklet.count': 'Count',
  'booklet.unrated': 'Unrated',
  'booklet.verified': 'Verified level',
  'home.level': 'Level {level}',
  'trick.alternativeNames': 'Alternative names: {names}',
  'trick.level': '{ruleset} Level {level}',
  'enums.discipline.DoubleDutch': 'Double Dutch',
  'enums.discipline.SingleRope': 'Single Rope',
  'enums.discipline.Wheel': 'Wheel',
  'enums.trickType.Basic': 'Basic',
  'enums.trickType.Impossible': 'Impossible',
  'enums.trickType.Manipulation': 'Manipulation',
  'enums.trickType.Multiple': 'Multiple',
  'enums.trickType.Power': 'Power',
  'enums.trickType.Release': 'Release'
}

/** Everything a booklet is typeset from, as loaded from Firestore and the site */
export interface BookletSources {
  tricks: Array<Pick<TrickDoc, 'id' | 'slug' | 'discipline' | 'trickType'>>
  /** The English localisations and, for another language, its localisations */
  localisations: Array<Pick<TrickLocalisationDoc, 'id' | 'trickId' | 'name' | 'alternativeNames' | 'description'>>
  /** The Tricktionary levels and, when a ruleset was asked for, its levels */
  levels: Array<Pick<TrickLevelDoc, 'trickId' | 'rulesId' | 'level' | 'verificationLevel'>>
  ruleset: Pick<RulesetDoc, 'id' | 'names'> | null
  /** The defaults above, the site's English and the language's translations, later ones winning */
  messages: FlatMessages
}

/** What the template reads from `data.json` */
export interface BookletData {
  lang: string
  region: string | null
  title: string
  discipline: string
  page: {
    /** mm */
    width: number
    /** mm */
    height: number
    /** mm */
    margin: number
    columns: number
    /** pt */
    fontSize: number
  }
  /** The template adds speed-log pages until the page count is a multiple of this */
  padToMultipleOf: number
  speed: { pages: number, rows: number }
  strings: {
    info: string
    generated: string
    speedEvent: string
    date: string
    count: string
    /** The legend for the verified mark, null when no ruleset's levels are shown */
    verified: string | null
  }
  groups: BookletGroup[]
}

export interface BookletGroup {
  title: string
  types: Array<{
    title: string
    tricks: BookletTrick[]
  }>
}

export interface BookletTrick {
  name: string
  nameLang: string
  /** Already joined into a sentence, null when there are none */
  alternativeNames: string | null
  description: string | null
  descriptionLang: string
  /** The level in the requested ruleset, null when not set or no ruleset was requested */
  level: { label: string, verified: boolean } | null
}

interface LoadContext {
  dataSources: DataSources
  logger: Pino.Logger
  /** The public site, whose English messages label the booklet, `WEB_URL` in the configuration */
  webUrl: string
}

export async function loadBookletSources (options: BookletOptions, { dataSources, logger, webUrl }: LoadContext): Promise<BookletSources> {
  const { lang, rulesId, discipline } = options

  const [language, ruleset, tricks, siteMessages, translations] = await Promise.all([
    dataSources.languages.findOneById(lang, { ttl: 3600 }),
    rulesId == null ? null : dataSources.rulesets.findOneById(rulesId, { ttl: 3600 }),
    dataSources.tricks.findManyByDiscipline(discipline, { ttl: 3600 }),
    siteEnglishMessages({ webUrl, logger }),
    lang === 'en' ? null : dataSources.uiMessages.findOneById(lang, { ttl: 3600 })
  ])
  if (!language?.enabled) throw new NotFoundError(`Language ${lang} not found`, { extensions: { entity: 'language', id: lang } })
  if (rulesId != null && !ruleset) throw new NotFoundError(`Ruleset ${rulesId} not found`, { extensions: { entity: 'ruleset', id: rulesId } })

  const trickIds = tricks.map(trick => trick.id)
  const localisationIds = trickIds.map(id => trickLocalisationId(id, 'en'))
  if (lang !== 'en') localisationIds.push(...trickIds.map(id => trickLocalisationId(id, lang)))

  const [localisations, tricktionaryLevels, rulesetLevels] = await Promise.all([
    dataSources.trickLocalisations.findManyByIds(localisationIds, { ttl: 3600 }),
    dataSources.trickLevels.findManyByRuleset(TRICKTIONARY_RULES_ID, { ttl: 3600 }),
    rulesId == null ? [] : dataSources.trickLevels.findManyByRuleset(rulesId, { ttl: 3600 })
  ])

  const inDiscipline = new Set(trickIds)

  return {
    tricks,
    localisations: localisations.filter(localisation => localisation != null),
    levels: [...tricktionaryLevels, ...rulesetLevels].filter(level => inDiscipline.has(level.trickId)),
    ruleset: ruleset ?? null,
    messages: {
      ...BOOKLET_MESSAGE_DEFAULTS,
      ...siteMessages,
      ...uiMessageValues(translations?.messages)
    }
  }
}

/** `{name}` placeholders, the way vue-i18n writes them in the site's messages */
function interpolate (message: string, values: Record<string, string>) {
  return message.replace(/\{(\w+)\}/g, (match, key: string) => values[key] ?? match)
}

/** The message key of an enum member's label, e.g. `enums.trickType.Basic` for `basic` */
function enumKey (name: 'discipline' | 'trickType', value: string) {
  const members: Record<string, string> = name === 'discipline' ? Discipline : TrickType
  const member = Object.entries(members).find(([, enumValue]) => enumValue === value)?.[0]
  return `enums.${name}.${member ?? value}`
}

function splitLang (tag: string): { lang: string, region: string | null } {
  const [lang, region] = tag.split('-')
  return { lang, region: region ? region.toUpperCase() : null }
}

/** Assembles what the template typesets, a pure function of its sources */
export function bookletData (options: BookletOptions, sources: BookletSources, { now = new Date() }: { now?: Date } = {}): BookletData {
  const { lang, detailed, rulesId, layout, paper } = options
  const { messages } = sources
  const t = (key: string, values: Record<string, string> = {}) => interpolate(messages[key] ?? BOOKLET_MESSAGE_DEFAULTS[key] ?? key, values)

  const collator = new Intl.Collator(lang)
  const listFormat = new Intl.ListFormat(lang, { style: 'long', type: 'disjunction' })

  const localisations = new Map(sources.localisations.map(localisation => [localisation.id, localisation]))
  const tricktionaryLevels = new Map<string, string>()
  const rulesetLevels = new Map<string, BookletSources['levels'][number]>()
  for (const level of sources.levels) {
    if (level.rulesId === TRICKTIONARY_RULES_ID) tricktionaryLevels.set(level.trickId, level.level)
    else if (level.rulesId === rulesId) rulesetLevels.set(level.trickId, level)
  }
  const rulesetName = sources.ruleset ? (sources.ruleset.names[lang] ?? sources.ruleset.names.en ?? sources.ruleset.id) : null

  // levels in numerical order, tricks without one last
  const groups = new Map<string | null, Map<TrickType, BookletTrick[]>>()
  for (const trick of sources.tricks) {
    const level = tricktionaryLevels.get(trick.id) ?? null
    let byType = groups.get(level)
    if (!byType) {
      byType = new Map()
      groups.set(level, byType)
    }
    let tricks = byType.get(trick.trickType)
    if (!tricks) {
      tricks = []
      byType.set(trick.trickType, tricks)
    }

    // the name and alternative names come from one localisation, so that a
    // name isn't shown next to alternative names in another language
    const en = localisations.get(trickLocalisationId(trick.id, 'en'))
    const localised = lang === 'en' ? undefined : localisations.get(trickLocalisationId(trick.id, lang))
    const names = (localised?.name.trim() ?? '') !== '' ? localised : en
    const nameLang = names === localised ? lang : 'en'
    const localisedDescription = localised?.description.trim() ?? ''
    const description = localisedDescription !== '' ? localisedDescription : (en?.description.trim() ?? '')
    const descriptionLang = localisedDescription !== '' ? lang : 'en'
    const alternativeNames = (names?.alternativeNames ?? []).map(name => name.trim()).filter(name => name !== '')

    const rulesetLevel = rulesetLevels.get(trick.id)

    tricks.push({
      name: (names?.name.trim() ?? '') !== '' ? names!.name.trim() : trick.slug,
      nameLang,
      alternativeNames: alternativeNames.length > 0 ? t('trick.alternativeNames', { names: listFormat.format(alternativeNames) }) : null,
      description: detailed && description !== '' ? description : null,
      descriptionLang,
      level: rulesetLevel && rulesetName != null
        ? { label: t('trick.level', { ruleset: rulesetName, level: rulesetLevel.level }), verified: rulesetLevel.verificationLevel != null }
        : null
    })
  }

  const typeOrder = Object.values(TrickType).sort((a, b) => collator.compare(t(enumKey('trickType', a)), t(enumKey('trickType', b))))
  const levelOrder = [...groups.keys()].sort((a, b) => {
    if (a === null) return 1
    if (b === null) return -1
    return parseFloat(a) - parseFloat(b) || collator.compare(a, b)
  })

  const sheet = PAPER_SIZES[paper]
  const page = layout === 'booklet'
    // half a landscape sheet, so that two fit on one side exactly
    ? { width: sheet.height / 2, height: sheet.width, margin: 14, columns: 1, fontSize: 10 }
    : { width: sheet.width, height: sheet.height, margin: 18, columns: 2, fontSize: 10 }

  const { lang: baseLang, region } = splitLang(lang)

  return {
    lang: baseLang,
    region,
    title: 'the Tricktionary',
    discipline: t(enumKey('discipline', options.discipline)),
    page,
    padToMultipleOf: layout === 'booklet' ? 4 : 1,
    speed: {
      pages: SPEED_PAGES,
      rows: Math.floor((page.height - 2 * page.margin - SPEED_HEADING_MM) / SPEED_ROW_MM)
    },
    strings: {
      info: t('booklet.info'),
      generated: t('booklet.generated', { date: new Intl.DateTimeFormat(lang, { dateStyle: 'long' }).format(now) }),
      speedEvent: t('booklet.speedEvent'),
      date: t('booklet.date'),
      count: t('booklet.count'),
      verified: rulesId == null ? null : t('booklet.verified')
    },
    groups: levelOrder.map(level => ({
      title: level === null ? t('booklet.unrated') : t('home.level', { level }),
      types: typeOrder.flatMap(type => {
        const tricks = groups.get(level)?.get(type) ?? []
        if (tricks.length === 0) return []
        return [{
          title: t(enumKey('trickType', type)),
          tricks: tricks.sort((a, b) => collator.compare(a.name, b.name))
        }]
      })
    }))
  }
}

export function bookletFilename (options: BookletOptions) {
  const parts = ['tricktionary', disciplineSlug(options.discipline) ?? 'tricks', options.lang, options.paper]
  if (options.detailed) parts.push('detailed')
  if (options.rulesId != null) parts.push(options.rulesId.replace(/[^a-z0-9.-]+/gi, '-'))
  if (options.layout === 'booklet') parts.push('booklet')
  return `${parts.join('-')}.pdf`
}

interface RenderContext {
  /** The Typst binary, `TYPST_BIN` in the configuration */
  bin: string
  now?: Date
}

/** Typesets already assembled data, one page per page of the data */
export async function typesetBooklet (data: BookletData, { bin, now = new Date() }: RenderContext): Promise<Uint8Array> {
  return await compileTypst({ template: 'booklet', data, bin, creationDate: now })
}

/** Lays a typeset `booklet` layout out two pages per side of its paper */
export async function imposeBookletPdf (pdf: Uint8Array, paper: Paper): Promise<Uint8Array> {
  const sheet = PAPER_SIZES[paper]
  return await imposeBooklet(pdf, { width: sheet.height, height: sheet.width })
}

/** Typesets already assembled data, and imposes it when the layout asks for it */
export async function renderBookletData (data: BookletData, options: Pick<BookletOptions, 'layout' | 'paper'>, context: RenderContext): Promise<Uint8Array> {
  const pdf = await typesetBooklet(data, context)
  return options.layout === 'booklet' ? await imposeBookletPdf(pdf, options.paper) : pdf
}

export async function renderBooklet (options: BookletOptions, { dataSources, logger, webUrl, bin }: LoadContext & RenderContext): Promise<{ pdf: Uint8Array, filename: string }> {
  const now = new Date()
  const sources = await loadBookletSources(options, { dataSources, logger, webUrl })
  const data = bookletData(options, sources, { now })
  const pdf = await renderBookletData(data, options, { bin, now })
  return { pdf, filename: bookletFilename(options) }
}
