import z from 'zod'
import { NotFoundError } from '../errors.js'
import { Discipline, TrickType } from '../generated/graphql.js'
import { DISCIPLINE_SLUGS, disciplineFromSlug, disciplineSlug } from '../helpers/disciplines.js'
import { localised } from '../helpers/localised.js'
import { trickTypeOf } from '../helpers/tags.js'
import { uiMessageValues } from '../helpers/uiMessages.js'
import { TRICK_TYPE_TAG_ID, TRICKTIONARY_RULES_ID, trickLocalisationId } from '../store/schema.js'
import { langSchema, rulesIdSchema } from '../validation.js'
import { compileTypst } from './typst.js'
import { renderDotToSvg } from './graphviz.js'
import { imposeBooklet } from './imposition.js'
import { siteEnglishMessages } from './siteMessages.js'

import type Pino from 'pino'
import type { DataSources } from '../store/firestoreDataSource.js'
import type { RulesetDoc, TagDoc, TrickDoc, TrickLevelDoc, TrickLocalisationDoc, TrickPrereqDoc } from '../store/schema.js'
import type { FlatMessages } from './siteMessages.js'

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

export type BookletOptions = z.output<typeof bookletOptionsSchema>

/** Sheet sizes in mm */
const PAPER_SIZES: Record<Paper, { width: number, height: number }> = {
  a4: { width: 210, height: 297 },
  letter: { width: 215.9, height: 279.4 }
}

/** What print shops ask for, in mm, on every side of the `print` layout's pages */
const BLEED_MM = 3

const SPEED_PAGES = 4
/** The height of a speed-log table row in the template, in mm */
const SPEED_ROW_MM = 6.5
/** What the speed-log heading and the table's header row take above the rows, in mm */
const SPEED_HEADING_MM = 26

/** The colours the trick map draws each type in, the brand red for the basics */
const TRICK_TYPE_COLOURS: Record<TrickType, string> = {
  [TrickType.Basic]: '#fe3500',
  [TrickType.Manipulation]: '#1f77b4',
  [TrickType.Multiple]: '#2ca02c',
  [TrickType.Power]: '#9467bd',
  [TrickType.Release]: '#ff7f0e',
  [TrickType.Impossible]: '#7f7f7f'
}

/** Everything a booklet is typeset from, as loaded from Firestore and the site */
export interface BookletSources {
  tricks: Array<Pick<TrickDoc, 'id' | 'slug' | 'discipline' | 'trickType'>>
  /** The English localisations and, for another language, its localisations */
  localisations: Array<Pick<TrickLocalisationDoc, 'id' | 'trickId' | 'name' | 'alternativeNames' | 'description'>>
  /** The Tricktionary levels and, when a ruleset was asked for, its levels */
  levels: Array<Pick<TrickLevelDoc, 'trickId' | 'rulesId' | 'level' | 'verificationLevel'>>
  ruleset: Pick<RulesetDoc, 'id' | 'names'> | null
  /** The prerequisite edges between the tricks, `parentId` builds on `childId`. Only loaded for the trick map. */
  prerequisites: Array<Pick<TrickPrereqDoc, 'parentId' | 'childId'>>
  /** Its value names label the trick types */
  trickTypeTag: Pick<TagDoc, 'values'> | null
  /**
   * The site's English messages with the language's translations laid over
   * them, keyed like the site's `en.json`; a key that neither has is shown as
   * is, so a missing string is easy to spot
   */
  messages: FlatMessages
}

/** What the template reads from `data.json` */
export interface BookletData {
  lang: string
  region: string | null
  title: string
  discipline: string
  /**
   * The page as typeset. For the `print` layout the bleed is part of it: the
   * page is the trim size plus the bleed on every side, and the margins are
   * that much wider, so the trimmed page comes out as intended
   */
  page: {
    /** mm */
    width: number
    /** mm */
    height: number
    /** mm */
    margin: number
    /** mm, how much of the width, height and margin is bleed */
    bleed: number
    columns: number
    /** pt */
    fontSize: number
  }
  /** The template adds speed-log pages until the page count is a multiple of this */
  padToMultipleOf: number
  /** How many pages follow the speed log: the trick map and the back cover */
  trailingPages: number
  speed: { pages: number, rows: number }
  strings: {
    info: string
    generated: string
    speedEvent: string
    date: string
    count: string
    /** Which ruleset the levels follow and what the verified mark means, null when no ruleset's levels are shown */
    levels: string | null
  }
  /** The cover, colophon and back cover of the `print` layout */
  print: {
    copyright: string
    website: string
    contact: string
    /** As it should be shown, with dashes */
    isbn: string | null
    /** The 13 digits the barcode encodes */
    isbnDigits: string | null
    isbnLabel: string | null
    printedBy: string | null
  } | null
  /**
   * The trick map of the `print` layout, on the inside of the back cover,
   * null when there are no prerequisites to draw. The graph itself reaches
   * the template as `map.svg`.
   */
  map: {
    title: string
    explanation: string
    /** Graphviz DOT source, laid out and drawn to `map.svg` for the template */
    dot: string
    /** The drawn graph's size in pt, set once it has been drawn, so the template can fit it without measuring */
    size: { width: number, height: number } | null
    legend: Array<{ label: string, colour: string }>
  } | null
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
  const { lang, rulesId, discipline, layout } = options

  const [language, ruleset, tricks, siteMessages, translations, prerequisites, trickTypeTag] = await Promise.all([
    dataSources.languages.findOneById(lang, { ttl: 3600 }),
    rulesId == null ? null : dataSources.rulesets.findOneById(rulesId, { ttl: 3600 }),
    dataSources.tricks.findManyByDiscipline(discipline, { ttl: 3600 }),
    siteEnglishMessages({ webUrl, logger }),
    lang === 'en' ? null : dataSources.uiMessages.findOneById(lang, { ttl: 3600 }),
    layout === 'print' ? dataSources.trickPrerequisites.findAll({ ttl: 3600 }) : [],
    dataSources.tags.findOneById(TRICK_TYPE_TAG_ID, { ttl: 3600 })
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
    tricks: tricks.map(trick => ({ id: trick.id, slug: trick.slug, discipline: trick.discipline, trickType: trickTypeOf(trick) })),
    trickTypeTag: trickTypeTag ?? null,
    localisations: localisations.filter(localisation => localisation != null),
    levels: [...tricktionaryLevels, ...rulesetLevels].filter(level => inDiscipline.has(level.trickId)),
    ruleset: ruleset ?? null,
    prerequisites: prerequisites.filter(edge => inDiscipline.has(edge.parentId) && inDiscipline.has(edge.childId)),
    messages: {
      ...siteMessages,
      ...uiMessageValues(translations?.messages)
    }
  }
}

/** `{name}` placeholders, the way vue-i18n writes them in the site's messages */
function interpolate (message: string, values: Record<string, string>) {
  return message.replace(/\{(\w+)\}/g, (match, key: string) => values[key] ?? match)
}

/** The message key of a discipline's label, e.g. `enums.discipline.SingleRope` */
function disciplineKey (discipline: Discipline) {
  const member = Object.entries(Discipline).find(([, value]) => value === discipline)?.[0]
  return `enums.discipline.${member ?? discipline}`
}

function splitLang (tag: string): { lang: string, region: string | null } {
  const [lang, region] = tag.split('-')
  return { lang, region: region ? region.toUpperCase() : null }
}

/** A DOT string literal */
function dotString (value: string) {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

interface MapNode {
  id: string
  name: string
  trickType: TrickType
}

/**
 * The trick map as Graphviz DOT for the `dot` engine: every trick a dot
 * coloured by its type and sized by how many tricks build on it, an arrow
 * from each prerequisite to the trick that builds on it. `dot` ranks the
 * tricks bottom to top by how far up the prerequisite chain they are. The
 * labels name the booklet's font, so Typst draws them in it.
 */
export function trickMapDot (nodes: MapNode[], edges: Array<Pick<TrickPrereqDoc, 'parentId' | 'childId'>>) {
  const dependents = new Map<string, number>()
  for (const edge of edges) dependents.set(edge.childId, (dependents.get(edge.childId) ?? 0) + 1)

  const lines = [
    'digraph tricks {',
    '  graph [rankdir=BT, ranksep=0.35, nodesep=0.08, splines=true, outputorder=edgesfirst];',
    '  node [shape=circle, style=filled, fixedsize=true, label="", color="#ffffff00", fontname="PT Sans", fontsize=5];',
    '  edge [color="#999999", arrowsize=0.4, penwidth=0.5];'
  ]
  for (const node of nodes) {
    const width = (0.12 + 0.06 * Math.sqrt(dependents.get(node.id) ?? 0)).toFixed(2)
    lines.push(`  ${dotString(node.id)} [width=${width}, fillcolor=${dotString(TRICK_TYPE_COLOURS[node.trickType])}, xlabel=${dotString(node.name)}];`)
  }
  // the arrow points from the prerequisite to the trick that builds on it
  for (const edge of edges) lines.push(`  ${dotString(edge.childId)} -> ${dotString(edge.parentId)};`)
  lines.push('}')
  return lines.join('\n')
}

/** Assembles what the template typesets, a pure function of its sources */
export function bookletData (options: BookletOptions, sources: BookletSources, { now = new Date() }: { now?: Date } = {}): BookletData {
  const { lang, detailed, rulesId, layout, paper } = options
  const { messages } = sources
  const t = (key: string, values: Record<string, string> = {}) => interpolate(messages[key] ?? key, values)

  const collator = new Intl.Collator(lang)
  const listFormat = new Intl.ListFormat(lang, { style: 'long', type: 'disjunction' })
  const typeLabel = (type: TrickType) => localised(sources.trickTypeTag?.values?.[type]?.names ?? {}, lang) || type

  const localisations = new Map(sources.localisations.map(localisation => [localisation.id, localisation]))
  const tricktionaryLevels = new Map<string, string>()
  const rulesetLevels = new Map<string, BookletSources['levels'][number]>()
  for (const level of sources.levels) {
    if (level.rulesId === TRICKTIONARY_RULES_ID) tricktionaryLevels.set(level.trickId, level.level)
    else if (level.rulesId === rulesId) rulesetLevels.set(level.trickId, level)
  }
  const rulesetName = sources.ruleset ? (localised(sources.ruleset.names, lang) || sources.ruleset.id) : null

  // levels in numerical order, tricks without one last
  const groups = new Map<string | null, Map<TrickType, BookletTrick[]>>()
  const mapNodes: MapNode[] = []
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
    const name = (names?.name.trim() ?? '') !== '' ? names!.name.trim() : trick.slug

    const rulesetLevel = rulesetLevels.get(trick.id)

    tricks.push({
      name,
      nameLang,
      alternativeNames: alternativeNames.length > 0 ? t('trick.alternativeNames', { names: listFormat.format(alternativeNames) }) : null,
      description: detailed && description !== '' ? description : null,
      descriptionLang,
      level: rulesetLevel && rulesetName != null
        ? { label: t('home.level', { level: rulesetLevel.level }), verified: rulesetLevel.verificationLevel != null }
        : null
    })
    mapNodes.push({ id: trick.id, name, trickType: trick.trickType })
  }

  const typeOrder = Object.values(TrickType).sort((a, b) => collator.compare(typeLabel(a), typeLabel(b)))
  const levelOrder = [...groups.keys()].sort((a, b) => {
    if (a === null) return 1
    if (b === null) return -1
    return parseFloat(a) - parseFloat(b) || collator.compare(a, b)
  })

  const sheet = PAPER_SIZES[paper]
  const bleed = layout === 'print' ? BLEED_MM : 0
  const page = layout === 'pages'
    ? { width: sheet.width, height: sheet.height, margin: 18, bleed, columns: 2, fontSize: 10 }
    // half a landscape sheet, so that two fit on one side exactly
    : { width: sheet.height / 2 + 2 * bleed, height: sheet.width + 2 * bleed, margin: 14 + bleed, bleed, columns: 1, fontSize: 10 }

  const { lang: baseLang, region } = splitLang(lang)
  const year = String(now.getFullYear())

  const print = layout === 'print'
    ? {
        copyright: t('booklet.copyright', { year }),
        website: 'the-tricktionary.com',
        contact: 'contact@the-tricktionary.com',
        isbn: options.isbn,
        isbnDigits: options.isbn == null ? null : isbnDigits(options.isbn),
        isbnLabel: options.isbn == null ? null : t('booklet.isbn', { isbn: options.isbn }),
        printedBy: options.printedBy == null ? null : t('booklet.printedBy', { printer: options.printedBy, year })
      }
    : null

  const map = layout === 'print' && sources.prerequisites.length > 0
    ? {
        title: t('booklet.map'),
        explanation: t('booklet.mapExplanation'),
        dot: trickMapDot(mapNodes, sources.prerequisites),
        size: null,
        legend: typeOrder
          .filter(type => mapNodes.some(node => node.trickType === type))
          .map(type => ({ label: typeLabel(type), colour: TRICK_TYPE_COLOURS[type] }))
      }
    : null

  return {
    lang: baseLang,
    region,
    title: 'the Tricktionary',
    discipline: t(disciplineKey(options.discipline)),
    page,
    padToMultipleOf: layout === 'pages' ? 1 : 4,
    // the map is the inside of the back cover, the back cover the very last page
    trailingPages: (map ? 1 : 0) + (print ? 1 : 0),
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
      levels: rulesetName == null ? null : t('booklet.levels', { ruleset: rulesetName })
    },
    print,
    map,
    groups: levelOrder.map(level => ({
      title: level === null ? t('booklet.unrated') : t('home.level', { level }),
      types: typeOrder.flatMap(type => {
        const tricks = groups.get(level)?.get(type) ?? []
        if (tricks.length === 0) return []
        return [{
          title: typeLabel(type),
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
  if (options.layout !== 'pages') parts.push(options.layout)
  return `${parts.join('-')}.pdf`
}

interface RenderContext {
  /** The Typst binary, `TYPST_BIN` in the configuration */
  bin: string
  now?: Date
}

/** The size Graphviz gave an SVG, from its root element, in pt */
function svgSize (svg: string) {
  const width = /<svg[^>]*\swidth="([\d.]+)pt"/.exec(svg)?.[1]
  const height = /<svg[^>]*\sheight="([\d.]+)pt"/.exec(svg)?.[1]
  if (width == null || height == null) throw new Error('Graphviz drew an SVG without a size in pt')
  return { width: parseFloat(width), height: parseFloat(height) }
}

/** Typesets already assembled data, one page per page of the data, drawing the trick map first */
export async function typesetBooklet (data: BookletData, { bin, now = new Date() }: RenderContext): Promise<Uint8Array> {
  const files: Record<string, string> = {}
  if (data.map) {
    const svg = await renderDotToSvg(data.map.dot, { engine: 'dot' })
    files['map.svg'] = svg
    data = { ...data, map: { ...data.map, size: svgSize(svg) } }
  }
  return await compileTypst({ template: 'booklet', data, files, bin, creationDate: now })
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
