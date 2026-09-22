import type { Timestamp } from '@google-cloud/firestore'
import type { Discipline } from '../generated/graphql.js'
import type { FlatMessages } from '../services/siteMessages.js'
import type { AdminDigest } from './adminDigest.js'

interface RenderOptions {
  adminUrl: string
  name?: string
  from: Timestamp
  until: Timestamp
  /** The site's English messages, for labels */
  messages: FlatMessages
}

interface Line {
  text: string
  /** Shown in brackets after the text */
  detail?: string
  href: string
}

interface Section {
  heading: string
  intro: string
  lines: Line[]
}

export interface RenderedEmail {
  subject: string
  html: string
  text: string
}

const dateFormat = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' })

/** `until` is exclusive */
function period (from: Timestamp, until: Timestamp) {
  const lastDay = new Date(until.toMillis() - 1)
  return `${dateFormat.format(from.toDate())} to ${dateFormat.format(lastDay)}`
}

function plural (count: number, one: string, many: string) {
  return `${count} ${count === 1 ? one : many}`
}

function sections (digest: AdminDigest, adminUrl: string, messages: FlatMessages): Section[] {
  const url = (path: string) => new URL(path, adminUrl).href
  const discipline = (value: Discipline) => messages[`enums.discipline.${value}`] ?? value
  const result: Section[] = []

  if (digest.submissions.length > 0) {
    result.push({
      heading: 'Submissions to review',
      intro: `${plural(digest.submissions.length, 'trick was', 'tricks were')} submitted and ${digest.submissions.length === 1 ? 'is' : 'are'} waiting for a review.`,
      lines: digest.submissions.map(submission => ({
        text: submission.name,
        detail: `${discipline(submission.discipline)}, by ${submission.attributionName}`,
        href: url('/submissions')
      }))
    })
  }

  if (digest.toTranslate.length > 0) {
    result.push({
      heading: 'New tricks to translate',
      intro: `${plural(digest.toTranslate.length, 'new trick is', 'new tricks are')} missing a translation in your languages.`,
      lines: digest.toTranslate.map(({ trick, langs }) => ({
        text: trick.name,
        detail: `${discipline(trick.discipline)}, ${langs.join(', ')}`,
        href: url(`/trick/${encodeURIComponent(trick.id)}`)
      }))
    })
  }

  if (digest.toLevel.length > 0) {
    result.push({
      heading: 'New tricks to level',
      intro: `${plural(digest.toLevel.length, 'new trick has', 'new tricks have')} no level yet in your rulesets.`,
      lines: digest.toLevel.map(({ trick, rulesets }) => ({
        text: trick.name,
        detail: `${discipline(trick.discipline)}, ${rulesets.join(', ')}`,
        href: url(`/trick/${encodeURIComponent(trick.id)}`)
      }))
    })
  }

  if (digest.siteMessagesChanged) {
    result.push({
      heading: 'Interface texts changed',
      intro: 'The site\'s English interface texts have changed since your last digest, some may need translating.',
      lines: [{ text: 'Open the interface translations', href: url('/translations') }]
    })
  }

  return result
}

function subject (digest: AdminDigest) {
  const parts = [
    digest.submissions.length > 0 ? plural(digest.submissions.length, 'submission', 'submissions') : null,
    digest.toTranslate.length > 0 ? `${digest.toTranslate.length} to translate` : null,
    digest.toLevel.length > 0 ? `${digest.toLevel.length} to level` : null,
    digest.siteMessagesChanged ? 'interface texts changed' : null
  ].filter(part => part != null)
  return `Tricktionary admin digest: ${parts.join(', ')}`
}

function escapeHtml (value: string) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll('\'', '&#39;')
}

/** Inline styles only, for mail clients that strip the rest */
function renderHtml (title: string, greeting: string, summary: string, body: Section[], footer: { text: string, href: string, link: string }) {
  const sectionsHtml = body.map(section => `
<h2 style="font-size:18px;margin:24px 0 8px">${escapeHtml(section.heading)}</h2>
<p style="margin:0 0 8px">${escapeHtml(section.intro)}</p>
<ul style="margin:0;padding-left:20px">
${section.lines.map(line => `<li style="margin:4px 0"><a href="${escapeHtml(line.href)}" style="color:#c42b00">${escapeHtml(line.text)}</a>${line.detail ? ` <span style="color:#555">(${escapeHtml(line.detail)})</span>` : ''}</li>`).join('\n')}
</ul>`).join('\n')

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
</head>
<body style="margin:0;padding:16px;background:#ffffff;color:#111111;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:15px;line-height:1.5">
<div style="max-width:600px;margin:0 auto">
<p style="margin:0 0 8px">${escapeHtml(greeting)}</p>
<p style="margin:0">${escapeHtml(summary)}</p>
${sectionsHtml}
<hr style="border:none;border-top:1px solid #dddddd;margin:32px 0 16px">
<p style="margin:0;color:#555555;font-size:13px">${escapeHtml(footer.text)} <a href="${escapeHtml(footer.href)}" style="color:#555555">${escapeHtml(footer.link)}</a></p>
</div>
</body>
</html>
`
}

function renderText (greeting: string, summary: string, body: Section[], footer: { text: string, href: string, link: string }) {
  const sectionsText = body.map(section => [
    section.heading,
    '-'.repeat(section.heading.length),
    section.intro,
    '',
    ...section.lines.map(line => `- ${line.text}${line.detail ? ` (${line.detail})` : ''}\n  ${line.href}`)
  ].join('\n'))

  return [
    greeting,
    summary,
    '',
    sectionsText.join('\n\n'),
    '',
    '--',
    `${footer.text} ${footer.link}: ${footer.href}`,
    ''
  ].join('\n')
}

export function renderAdminDigest (digest: AdminDigest, { adminUrl, name, from, until, messages }: RenderOptions): RenderedEmail {
  const body = sections(digest, adminUrl, messages)
  const greeting = name ? `Hi ${name},` : 'Hi,'
  const summary = `Here is what happened in the Tricktionary from ${period(from, until)} that needs your attention.`
  const footer = {
    text: 'You get this weekly digest because you have access to the Tricktionary admin.',
    link: 'Turn it off in your settings',
    href: new URL('/settings', adminUrl).href
  }
  const title = subject(digest)

  return {
    subject: title,
    html: renderHtml(title, greeting, summary, body, footer),
    text: renderText(greeting, summary, body, footer)
  }
}
