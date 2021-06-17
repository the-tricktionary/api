import type { Resolvers } from '../generated/graphql'
import { getPrices, getProducts } from '../services/stripe'

export const productResolvers: Resolvers = {
  Query: {
    async products (_, args, { dataSources, user }) {
      return (await getProducts()).map(p => ({
        id: p.id,
        name: p.name,
        description: p.description,
        image: p.images[0]
      }))
    }
  },
  Product: {
    async prices (product, _, { dataSources, allowUser }) {
      return (await getPrices(product.id)).map(p => ({
        id: p.id,
        currency: p.currency,
        unitAmount: p.unit_amount,
        unitAmountDecimal: p.unit_amount_decimal
      }))
    }
  }
}
