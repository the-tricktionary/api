import MailjetModule from 'node-mailjet'
import { getSecret } from './secrets.js'
import { UpstreamError } from '../errors.js'

import type { SendEmailV3_1 as SendEmail } from 'node-mailjet'

// The package is CommonJS with ESM-style declarations: node hands an ES module
// the client class itself as the default export, TypeScript types that default
// as the whole module and puts the class on its `default`
const Mailjet = MailjetModule as unknown as typeof MailjetModule.default

const [apiKey, apiSecret] = await Promise.all([getSecret('tricktionary-api-mailjet-api-key'), getSecret('tricktionary-api-mailjet-secret-key')])

const mailjet = Mailjet.apiConnect(apiKey, apiSecret)

/** Nobody reads replies to this address, they go to `REPLY_TO` */
const FROM: SendEmail.EmailAddressTo = { Email: 'noreply@the-tricktionary.com', Name: 'the Tricktionary' }
const REPLY_TO: SendEmail.EmailAddressTo = { Email: 'contact@the-tricktionary.com', Name: 'the Tricktionary' }

export interface Email {
  to: { email: string, name?: string }
  subject: string
  html: string
  text: string
  /** Shows up on the message in Mailjet, to find what sent it */
  customId: string
}

/** Sends one email through Mailjet's Send API v3.1, throws when Mailjet did not accept it */
export async function sendEmail (email: Email) {
  const body: SendEmail.Body = {
    Messages: [{
      From: FROM,
      ReplyTo: REPLY_TO,
      To: [{ Email: email.to.email, ...(email.to.name ? { Name: email.to.name } : {}) }],
      Subject: email.subject,
      TextPart: email.text,
      HTMLPart: email.html,
      CustomID: email.customId,
      // the links are to the admin interface, rewriting them to track clicks
      // only makes them harder to trust
      TrackClicks: 'disabled' as SendEmail.TrackClicks,
      TrackOpens: 'disabled' as SendEmail.TrackOpens
    }]
  }

  let response
  try {
    response = await mailjet.post('send', { version: 'v3.1' }).request<SendEmail.Response>(body)
  } catch (err) {
    // the SDK's error carries its request config, and with it the API key and
    // secret, so it is never logged or passed on as is
    const { statusCode, response: errorResponse } = err as { statusCode?: number, response?: { data?: unknown } }
    throw new UpstreamError(`Mailjet refused ${email.customId}${statusCode != null ? ` with ${statusCode}` : ''}`, {
      extensions: { upstream: 'mailjet', statusCode, body: errorResponse?.data }
    })
  }
  const message = response.body.Messages[0]
  // the declarations have the status as an ambient enum, which isn't there at runtime
  const status: string | undefined = message?.Status
  if (status !== 'success') {
    throw new UpstreamError(`Mailjet did not accept ${email.customId}`, { extensions: { upstream: 'mailjet', errors: message?.Errors ?? [] } })
  }
}
