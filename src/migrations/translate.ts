import '../config'
import { Firestore } from '@google-cloud/firestore'
import { Discipline } from '../generated/graphql'
import { TrickDoc, TrickLocalisationDoc } from '../store/schema'
import { writeFileSync } from 'fs'

const firestore = new Firestore()

const tricks: string[][] = []

const discipline = {
  [Discipline.SingleRope]: 'sr',
  [Discipline.DoubleDutch]: 'dd',
  [Discipline.Wheel]: 'wh'
}

firestore.collection('trick-localisations').get().then(async lQSnap => {
  const translations = new Map<string, TrickLocalisationDoc>(lQSnap.docs.map(dSnap => [dSnap.id, dSnap.data() as TrickLocalisationDoc]))

  const qSnap = await firestore.collection('tricks').get()

  for (const dSnap of qSnap.docs) {
    const trick = dSnap.data() as any as TrickDoc
    tricks.push([
      dSnap.id,
      `https://the-tricktionary.com/tricks/${discipline[trick.discipline]}/${trick.slug}`,
      translations.get(`${dSnap.id}-en`)?.name ?? '',
      translations.get(`${dSnap.id}-en`)?.alternativeNames?.join(', ') ?? '',
      translations.get(`${dSnap.id}-en`)?.description ?? ''
    ])
  }

  writeFileSync('./tricks.json', JSON.stringify(tricks), { encoding: 'utf-8' })
})
  .catch(err => {
    console.log(err)
    process.exit(1)
  })
