import type { Resolvers } from '../generated/graphql'

/** Rulesets competition event lookup codes look like e.ijru.sp.sr.srss.1.30 */
const lookupCodePattern = /^e\.[a-z0-9-]+\.(fs|sp|oa)\.(sr|dd|wh|ts|xd)\.[a-z0-9-]+\.\d+\.(\d+x)?\d+$/

export const eventDefinitionResolvers: Resolvers = {
  Query: {
    async eventDefinitions (_, args, { dataSources }) {
      const eventDefinitions = await dataSources.eventDefinitions.findManyByQuery(c => c, { ttl: 3600 })
      return eventDefinitions.sort((a, b) => a.totalDuration - b.totalDuration || a.name.localeCompare(b.name))
    }
  },
  EventDefinition: {
    eventDefinitionLookupCode (eventDefinition) {
      if (eventDefinition.lookupCode) return eventDefinition.lookupCode
      // The seeded competition events use their lookup code as document id
      return lookupCodePattern.test(eventDefinition.id) ? eventDefinition.id : null
    }
  }
}
