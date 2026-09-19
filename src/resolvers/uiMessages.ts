import { FieldValue, Timestamp } from '@google-cloud/firestore'
import { AuthorizationError, NotFoundError, ValidationError } from '../errors.js'
import { uiMessageEntries, uiMessageValues } from '../services/uiMessages.js'
import { langSchema, uiMessagesSchema } from '../validation.js'

import type { Resolvers } from '../generated/graphql.js'
import type { UiMessagesDoc } from '../store/schema.js'

export const uiMessageResolvers: Resolvers = {
  Query: {
    async uiMessages (_, { lang }, { dataSources }) {
      const parsedLang = langSchema.parse(lang)

      const uiMessages = await dataSources.uiMessages.findOneById(parsedLang, { ttl: 3600 })
      return uiMessageValues(uiMessages?.messages)
    },
    async uiMessageEntries (_, { lang }, { dataSources, allowUser }) {
      const parsedLang = langSchema.parse(lang)
      allowUser.uiMessages(parsedLang).edit.assert()

      const uiMessages = await dataSources.uiMessages.findOneById(parsedLang)
      return uiMessageEntries(uiMessages?.messages)
    }
  },
  Mutation: {
    async setUiMessages (_, { lang, entries }, { dataSources, allowUser, user }) {
      const parsedLang = langSchema.parse(lang)
      if (parsedLang === 'en') throw new ValidationError('English is the source language of the interface, its messages live in the site\'s repository')
      allowUser.uiMessages(parsedLang).edit.assert()
      if (!user) throw new AuthorizationError()
      const parsedEntries = uiMessagesSchema.parse(entries)

      const language = await dataSources.languages.findOneById(parsedLang)
      if (!language) throw new NotFoundError(`Language ${parsedLang} not found`, { extensions: { entity: 'language', id: parsedLang } })

      // one merging set of only the keys sent, so keys nobody touched are kept
      // and two translators saving different keys at the same time don't
      // overwrite each other
      const updatedAt = Timestamp.now()
      const patch = Object.fromEntries(parsedEntries.map(entry => [
        entry.key,
        entry.value ? { value: entry.value, updatedBy: user.id, updatedAt } : FieldValue.delete()
      ]))

      const uiMessages = await (dataSources.uiMessages.updateOnePartial(parsedLang, { messages: patch }) as Promise<UiMessagesDoc>)
      return uiMessageEntries(uiMessages.messages)
    }
  },
  UiMessageEntry: {
    value (entry) {
      return entry.leaf.value
    },
    updatedAt (entry) {
      return entry.leaf.updatedAt
    },
    async updatedBy (entry, _, { dataSources }) {
      return (await dataSources.users.findOneById(entry.leaf.updatedBy, { ttl: 3600 })) ?? null
    }
  }
}
