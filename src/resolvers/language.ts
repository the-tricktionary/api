import { CollisionError, NotFoundError, ValidationError } from '../errors.js'
import { langSchema } from '../validation.js'

import type { Resolvers } from '../generated/graphql.js'
import type { LanguageDoc } from '../store/schema.js'

export const languageResolvers: Resolvers = {
  Query: {
    async languages (_, args, { dataSources }) {
      const languages = await dataSources.languages.findAll({ ttl: 3600 })
      return languages.sort((a, b) => a.id.localeCompare(b.id))
    }
  },
  Mutation: {
    async createLanguage (_, { lang }, { dataSources, allowUser }) {
      allowUser.createLanguage.assert()
      const id = langSchema.parse(lang)

      const existing = await dataSources.languages.findOneById(id)
      if (existing) throw new CollisionError(`The language ${id} already exists`, { extensions: { entity: 'language', id } })

      return await (dataSources.languages.createOne({
        id,
        enabled: false
      }) as Promise<LanguageDoc>)
    },
    async setLanguageEnabled (_, { lang, enabled }, { dataSources, allowUser }) {
      allowUser.setLanguageEnabled.assert()
      const id = langSchema.parse(lang)
      // the source language, which everything falls back to
      if (id === 'en' && !enabled) throw new ValidationError('English cannot be disabled')

      const existing = await dataSources.languages.findOneById(id)
      if (!existing) throw new NotFoundError(`Language ${id} not found`, { extensions: { entity: 'language', id } })

      return await (dataSources.languages.updateOnePartial(id, { enabled }) as Promise<LanguageDoc>)
    }
  }
}
