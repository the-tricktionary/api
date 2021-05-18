import { Discipline, ProfileOptions, TrickType } from '../generated/graphql'

export interface DocBase {
  readonly id: string
  readonly collection: string
}

export const $$lang = Symbol.for('lang')

export interface TrickDoc extends DocBase {
  readonly collection: 'tricks'
  slug: string
  discipline: Discipline
  trickType: TrickType

  // videos: Array<Omit<Video, '__typename'>>

  [$$lang]: string // ONLY USE THIS LOCALLY
}

export interface TrickLocalisationDoc extends DocBase {
  readonly collection: ''

  name: string
  alternativeNames?: string[]
  description: string
}

export interface UserDoc extends DocBase {
  readonly collection: 'users'
  username?: string
  name?: string
  lang?: string
  photo?: string
  profile: Omit<ProfileOptions, '__typename'>
}
