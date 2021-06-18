import { createCheckoutSession, getPrices, getProducts } from '../services/stripe'

import type { Product, Currency, Resolvers } from '../generated/graphql'

export const productResolvers: Resolvers = {
  Query: {
    async products (_, args, { dataSources, user }) {
      return (await getProducts()).map(p => ({
        id: p.id,
        name: p.name,
        description: p.description,
        image: p.images[0]
      })) as Product[]
    }
  },
  Mutation: {
    async createCheckoutSession (_, { products, currency }, { dataSources, user, allowUser, logger }) {
      allowUser.makePurchase.assert()
      return createCheckoutSession({ products, user, currency })
    }
  },
  Product: {
    async prices (product, _, { dataSources, allowUser }) {
      return (await getPrices(product.id)).map(p => ({
        id: p.id,
        currency: p.currency as Currency,
        unitAmount: p.unit_amount,
        unitAmountDecimal: p.unit_amount_decimal
      }))
    }
  }
}
