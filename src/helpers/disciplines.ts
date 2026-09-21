import { Discipline } from '../generated/graphql.js'

/** The URL segment of a discipline, matches `disciplineToSlug` in the web app */
export function disciplineSlug (discipline: Discipline): string | null {
  switch (discipline) {
    case Discipline.SingleRope:
      return 'sr'
    case Discipline.DoubleDutch:
      return 'dd'
    case Discipline.Wheel:
      return 'wh'
    default:
      return null
  }
}

export const DISCIPLINE_SLUGS = ['sr', 'dd', 'wh'] as const
export type DisciplineSlug = typeof DISCIPLINE_SLUGS[number]

export function disciplineFromSlug (slug: DisciplineSlug): Discipline {
  switch (slug) {
    case 'sr':
      return Discipline.SingleRope
    case 'dd':
      return Discipline.DoubleDutch
    case 'wh':
      return Discipline.Wheel
  }
}
