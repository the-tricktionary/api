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
  PORT = 3000
} = process.env
