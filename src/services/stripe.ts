import Stripe from 'stripe'
import { STRIPE_SK } from '../config'
import { logger } from './logger'

const stripe = new Stripe(STRIPE_SK as string, { apiVersion: '2020-08-27' })

// TODO: caching

export async function getProducts () {
  const products = await stripe.products.list()

  logger.debug(products.data)

  return products.data.filter(p => p.active && p.metadata.store === 'the-tricktionary')
}

export async function getPrices (productId: string) {
  const prices = await stripe.prices.list({
    product: productId
  })

  return prices.data.filter(p => p.active)
}
