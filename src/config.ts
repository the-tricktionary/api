import dotenv from 'dotenv'
import { initializeApp, applicationDefault } from 'firebase-admin/app'
dotenv.config()

initializeApp({
  credential: applicationDefault(),
  databaseURL: 'https://project-5641153190345267944.firebaseio.com'
})

export const {
  SENTRY_DSN,
  GITHUB_SHA,
  GITHUB_REF,
  GCP_PROJECT,
  STRIPE_SK,
  ALGOLIA_APP_ID,
  ALGOLIA_API_KEY,
  PORT = 3000
} = process.env
