import { Timestamp } from '@google-cloud/firestore'
import { servedLang } from './localised.js'

import type { NoticeDoc } from '../store/schema.js'

/** A notice's text in one language, as the API serves it */
export interface NoticeTextModel {
  lang: string
  body: string
  links: Array<{ label: string, url: string }>
}

export function noticeText (notice: NoticeDoc, lang: string): NoticeTextModel {
  const served = servedLang(notice.texts, lang)
  const text = notice.texts[served]
  return {
    lang: served,
    body: text.body,
    links: notice.linkUrls.map((url, idx) => ({ label: text.linkLabels[idx], url }))
  }
}

export function noticeIsLive (notice: NoticeDoc, now = Timestamp.now()) {
  const millis = now.toMillis()
  return (notice.from == null || notice.from.toMillis() <= millis) &&
    (notice.until == null || notice.until.toMillis() > millis)
}
