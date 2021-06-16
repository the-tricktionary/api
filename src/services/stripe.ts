import Stripe from 'stripe'
import { STRIPE_SK } from '../config'

const stripe = new Stripe(STRIPE_SK as string, { apiVersion: '2020-08-27' })

// TODO: caching

export async function getProducts () {
  const products = await stripe.products.list()

  return products.data.filter(p => p.active && p.metadata.shop === 'the-tricktionary')
}

export async function getPrices (productId: string) {
  const prices = await stripe.prices.list({
    product: productId
  })

  return prices.data.filter(p => p.active)
}
