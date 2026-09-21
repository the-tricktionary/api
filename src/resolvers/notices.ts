import { FieldValue, Timestamp } from '@google-cloud/firestore'

import { AuthorizationError, NotFoundError } from '../errors.js'
import { noticeIsLive, noticeText } from '../helpers/notices.js'
import { langSchema, noticeSchema } from '../validation.js'

import type { ApolloContext } from '../apollo.js'
import type { Resolvers } from '../generated/graphql.js'
import type { NoticeDoc, NoticeTextFields } from '../store/schema.js'

async function existingNotice (noticeId: string, { dataSources }: Pick<ApolloContext, 'dataSources'>) {
  const notice = await dataSources.notices.findOneById(noticeId)
  if (!notice) throw new NotFoundError(`Notice ${noticeId} not found`, { extensions: { entity: 'notice', id: noticeId } })
  return notice
}

async function storedTexts (texts: Array<NoticeTextFields & { lang: string }>, { dataSources }: Pick<ApolloContext, 'dataSources'>) {
  await Promise.all(texts.map(async text => {
    const language = await dataSources.languages.findOneById(text.lang)
    if (!language) throw new NotFoundError(`Language ${text.lang} not found`, { extensions: { entity: 'language', id: text.lang } })
  }))

  return Object.fromEntries(texts.map(text => [text.lang, { body: text.body, linkLabels: text.linkLabels }]))
}

export const noticeResolvers: Resolvers = {
  Query: {
    async notices (_, args, { dataSources }) {
      const notices = await dataSources.notices.findAll({ ttl: 60 })
      const now = Timestamp.now()
      return notices
        .filter(notice => noticeIsLive(notice, now))
        .sort((a, b) => a.createdAt.toMillis() - b.createdAt.toMillis())
    },
    async allNotices (_, args, { dataSources, allowUser }) {
      allowUser.manageNotices.assert()
      const notices = await dataSources.notices.findAll()
      return notices.sort((a, b) => b.createdAt.toMillis() - a.createdAt.toMillis())
    }
  },
  Mutation: {
    async createNotice (_, { data: rawData }, context) {
      const { dataSources, allowUser, user } = context
      allowUser.manageNotices.assert()
      if (!user) throw new AuthorizationError()
      const data = noticeSchema.parse(rawData)

      return await (dataSources.notices.createOne({
        ...(data.from ? { from: data.from } : {}),
        ...(data.until ? { until: data.until } : {}),
        linkUrls: data.linkUrls,
        texts: await storedTexts(data.texts, context),
        updatedBy: user.id
      }) as Promise<NoticeDoc>)
    },
    async updateNotice (_, { noticeId, data: rawData }, context) {
      const { dataSources, allowUser, user } = context
      allowUser.manageNotices.assert()
      if (!user) throw new AuthorizationError()
      const data = noticeSchema.parse(rawData)
      const existing = await existingNotice(noticeId, context)

      // a merging set would leave the languages the notice no longer has in place
      const texts = await storedTexts(data.texts, context)
      const dropped = Object.fromEntries(Object.keys(existing.texts)
        .filter(lang => !(lang in texts))
        .map(lang => [lang, FieldValue.delete()]))

      return await (dataSources.notices.updateOnePartial(existing.id, {
        from: data.from ?? FieldValue.delete(),
        until: data.until ?? FieldValue.delete(),
        linkUrls: data.linkUrls,
        texts: { ...dropped, ...texts },
        updatedBy: user.id
      }) as Promise<NoticeDoc>)
    },
    async deleteNotice (_, { noticeId }, context) {
      const { dataSources, allowUser } = context
      allowUser.manageNotices.assert()
      const existing = await existingNotice(noticeId, context)

      await dataSources.notices.deleteOne(existing.id)
      return existing
    }
  },
  Notice: {
    from (notice) {
      return notice.from ?? null
    },
    until (notice) {
      return notice.until ?? null
    },
    text (notice, { lang }) {
      return noticeText(notice, lang ? langSchema.parse(lang) : 'en')
    },
    texts (notice) {
      const langs = Object.keys(notice.texts).filter(lang => lang !== 'en').sort((a, b) => a.localeCompare(b))
      return ['en', ...langs].map(lang => noticeText(notice, lang))
    },
    async updatedBy (notice, _, { dataSources }) {
      return (await dataSources.users.findOneById(notice.updatedBy, { ttl: 3600 })) ?? null
    }
  }
}
