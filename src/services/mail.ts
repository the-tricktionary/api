import MailjetModule from 'node-mailjet'
import { getSecret } from './secrets.js'
import { UpstreamError } from '../errors.js'

import type { SendEmailV3_1 as SendEmail } from 'node-mailjet'

// the declarations type the default import as the module, node hands us the class
const Mailjet = MailjetModule as unknown as typeof MailjetModule.default

const [apiKey, apiSecret] = await Promise.all([getSecret('tricktionary-api-mailjet-api-key'), getSecret('tricktionary-api-mailjet-secret-key')])

const mailjet = Mailjet.apiConnect(apiKey, apiSecret)

const FROM: SendEmail.EmailAddressTo = { Email: 'noreply@the-tricktionary.com', Name: 'the Tricktionary' }
const REPLY_TO: SendEmail.EmailAddressTo = { Email: 'contact@the-tricktionary.com', Name: 'the Tricktionary' }

export interface Email {
  to: { email: string, name?: string }
  subject: string
  html: string
  text: string
  /** Mailjet's `CustomID` */
  customId: string
}

/** Throws when Mailjet did not accept it */
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
      TrackClicks: 'disabled' as SendEmail.TrackClicks,
      TrackOpens: 'disabled' as SendEmail.TrackOpens
    }]
  }

  let response
  try {
    response = await mailjet.post('send', { version: 'v3.1' }).request<SendEmail.Response>(body)
  } catch (err) {
    // the SDK's error holds the API key and secret, so it never leaves here
    const { statusCode, response: errorResponse } = err as { statusCode?: number, response?: { data?: unknown } }
    throw new UpstreamError(`Mailjet refused ${email.customId}${statusCode != null ? ` with ${statusCode}` : ''}`, {
      extensions: { upstream: 'mailjet', statusCode, body: errorResponse?.data }
    })
  }
  const message = response.body.Messages[0]
  // declared as an ambient enum, which doesn't exist at runtime
  const status: string | undefined = message?.Status
  if (status !== 'success') {
    throw new UpstreamError(`Mailjet did not accept ${email.customId}`, { extensions: { upstream: 'mailjet', errors: message?.Errors ?? [] } })
  }
}
