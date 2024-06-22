import '../config'
import { FieldValue, Firestore } from '@google-cloud/firestore'

const firestore = new Firestore()

// firestore.collection('event-definitions').get().then(async qSnap => {
//   qSnap.docs.sort((a, b) => a.get('totalDuration') - b.get('totalDuration'))
//   for (const dSnap of qSnap.docs) {
//     const data = dSnap.data()
//     console.log(`${dSnap.id}\t${data.abbr ?? '-'}\t${data.totalDuration}\t${data.name}`)

//     await firestore.runTransaction(async t => {
//       const scores = await t.get(firestore.collection('speed-results').where('eventDefinitionId', '==', dSnap.id))

//       for (const score of scores.docs) {
//         t.update(score.ref, {
//           eventDefinition: {
//             name: data.name,
//             totalDuration: data.totalDuration
//           },
//           eventDefinitionId: FieldValue.delete()
//         })
//       }

//       t.delete(dSnap.ref)
//     })
//   }

//   process.exit(0)
// })
//   .catch(err => {
//     console.error(err)
//     process.exit(1)
//   })

export type CompetitionEvent = `e.${string}.${'fs' | 'sp' | 'oa'}.${'sr' | 'dd' | 'wh' | 'ts' | 'xd'}.${string}.${number}.${`${number}x${number}` | number}`

// const docs: Record<string, {
//   data: { name: string, totalDuration: number, lookupCode?: CompetitionEvent, abbr?: string },
//   replaces?: string[]
// }> = {
//   ibCesvuCxuU22JlKKKTp: {
//     data: { name: 'Single Rope Speed Endurance (3min)', totalDuration: 180, lookupCode: 'e.ijru.sp.sr.srse.1.180', abbr: 'srss' },
//     replaces: ['hPMXnvqt2pJ0id4b5tRx', 'fsgPklSJaWCBE56RxyEK', 'd91TlDTK2lf4F4BV0HRh', 'bBaHw8PFEiyQJoy7qprR', 'X2u8TQqNslxukUAGW3EU', 'SOVPW5RwCphOtRx8A1ib', 'JmiwUwlsf651DqzBAeES', '2ZSZeiQfO5dgeOH9dY2M']
//   },
//   f6cLW4y5oAlhEYXqvZ38: {
//     data: { name: 'Double Dutch Speed Relay (4*45s)', totalDuration: 180, lookupCode: 'e.fisac.sp.dd.ddsr.4.4x45', abbr: 'ddfs' },
//     replaces: ['JIFYZ2XxcBHQUy9bn6v1']
//   },
//   wKd49a98s2vbs7iS6Oro: {
//     data: { name: 'Unknown', totalDuration: 120 },
//     replaces: ['sr2Ay0zV6AgCngyNcPrY', 'cHPrL2WdsTO1R4cdIxIb', 'LNGZ4KU8FF6N7Notvcgr', 'GNlm3Ivd6n8EjJbeZ6Hu', '158FCNE7spVDmxSMqLxv']
//   },
//   jlApyR2MQ7lcQrJxDj1F: {
//     data: { name: 'Single Rope Speed Relay (4*30s)', totalDuration: 120, lookupCode: 'e.ijru.sp.sr.srsr.4.4x30', abbr: 'srfs' },
//   },
//   sHZH6bNbbsJ7OP1DeSxx: {
//     data: { name: 'Single Rope Speed (60s)', totalDuration: 60, abbr: 'srss' },
//     replaces: ['VibYwTADPGfHWL1t8Qhz', 'Gqryymavfd8vn4FqVwYu']
//   },
//   mkEU8t1e07woLx7rObMR: {
//     data: { name: 'Unknown', totalDuration: 30 },
//     replaces: ['LXysnTAOyjz2gsdmFlCq']
//   },
//   CTUy0WFaPCQVGpqT98sP: {
//     data: { name: 'Unknown', totalDuration: 15 },
//     replaces: ['3ZS5pAsBTOmCixQQHzfy']
//   },
//   bmlCtkDBPp3H4MgZiRPV: {
//     data: { name: 'Unknown', totalDuration: 10 },
//     replaces: ['EV4XxuYG1iTnUZspR09K', 'A0LCJVA9nyZ4g28WaOeR', '3wC9sv4Rv4SLepROhjkZ']
//   },
//   mpcXxA4OKPY16RzPknCk: {
//     data: { name: 'Unknown', totalDuration: 8 },
//     replaces: ['OC49kkyPCLVsMdq4gk51']
//   },
//   tTSE2GsE02WDMFYFWcys: {
//     data: { name: 'Unknown', totalDuration: 2 },
//     replaces: ['oggm7KxoyUW9ubjlZ9zm']
//   }
// }

// for (const [id, { data, replaces }] of Object.entries(docs)) {
//   firestore.runTransaction(async transaction => {
//     let otherDocs
//     if (replaces) otherDocs = await transaction.get(firestore.collection('speed-results').where('eventDefinitionId', 'in', replaces))
//     transaction.set(firestore.collection('event-definitions').doc(id), data)

//     if (otherDocs) {
//       for (const dSnap of otherDocs.docs) {
//         transaction.update(dSnap.ref, { eventDefinitionId: id })
//       }
//     }

//     if (replaces) {
//       for (const replace of replaces) transaction.delete(firestore.collection('event-definitions').doc(replace))
//     }
//   })
//     .catch(err => {
//       console.warn(err)
//     })
// }

const knownEvents: Record<string, { name: string, totalDuration: number }> = {
  'e.ijru.sp.sr.srss.1.30': { name: 'Single Rope Speed Sprint', totalDuration: 30 },
  'e.ijru.sp.sr.srse.1.180': { name: 'Single Rope Speed Endurance', totalDuration: 180 },
  'e.ijru.sp.sr.srtu.1.0': { name: 'Single Rope Triple Unders', totalDuration: 0 },
  'e.ijru.sp.sr.srsr.4.4x30': { name: 'Single Rope Speed Relay', totalDuration: 120 },
  'e.ijru.sp.sr.srdr.2.2x30': { name: 'Single Rope Double Unders Relay', totalDuration: 60 },
  'e.ijru.sp.dd.ddsr.4.4x30': { name: 'Double Dutch Speed Relay', totalDuration: 120 },
  'e.ijru.sp.dd.ddss.3.60': { name: 'Double Dutch Speed Sprint', totalDuration: 60 },
  'e.ddc.sp.dd.ddcs.3.30': { name: 'DDC Speed', totalDuration: 30 },
  'e.rsc.sp.sr.srss.1.120': { name: 'Single Rope Speed Endurance (1x120)', totalDuration: 120 },
  'e.rsc.sp.sr.srdu.1.60': { name: 'Non-Consecutive Double Unders', totalDuration: 60 },
  'e.rsc.sp.sr.srdu.1.120': { name: 'Consecutive Double Unders', totalDuration: 120 },
  'e.rsc.sp.sr.srdr.4.4x30': { name: 'Single Rope Double Unders Relay (4 athletes)', totalDuration: 120 },
  'e.amjrf.sp.sr.srdu.1.30': { name: 'Single Rope Double Unders', totalDuration: 30 },
  'e.sau.sp.sr.srse.1.60': { name: 'Single Rope Speed Endurance (1 minute)', totalDuration: 60 },
  'e.sau.sp.sr.srts.1.60': { name: 'Single Rope Triple Under Speed', totalDuration: 60 },
  'e.sau.sp.dd.ddsr.2.2x60': { name: 'Double Dutch Speed Relay (2x60)', totalDuration: 120 },
  'e.sau.sp.sr.srsr.2.2x30': { name: 'Single Rope Speed Relay (2x30)', totalDuration: 60 },
  'e.svgf.sp.dd.ddsr.4.4x45': { name: 'Double Dutch Spped Relay (4x45)', totalDuration: 180 }
}

// firestore.runTransaction(async t => {
//   for (const [id, data] of Object.entries(knownEvents)) {
//     t.set(firestore.collection('event-definitions').doc(id), data)
//   }
// })
//   .then(() => {
//     process.exit(0)
//   })
//   .catch(err => {
//     console.error(err)
//     process.exit(1)
//   })

firestore.runTransaction(async t => {
  const qSnap = await t.get(firestore.collection('speed-results').where('eventDefinition.name', '==', 'Unknown'))

  for (const dSnap of qSnap.docs) {
    t.update(dSnap.ref, { 'eventDefinition.name': 'Unknown Event' })
  }
})
  .then(() => {
    process.exit(0)
  })
  .catch(err => {
    console.error(err)
    process.exit(1)
  })
