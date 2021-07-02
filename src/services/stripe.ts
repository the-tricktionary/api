import Stripe from 'stripe'
import { STRIPE_SK } from '../config'
import postCountries from './post.json'

import type { UserDoc } from '../store/schema'
import type { Currency } from '../generated/graphql'

const stripe = new Stripe(STRIPE_SK as string, { apiVersion: '2020-08-27' })

// TODO caching

export async function getProducts () {
  const products = await stripe.products.list()
  return products.data.filter(p => p.active && p.metadata.store === 'the-tricktionary')
}

export async function getShippingRates (currency?: string) {
  const products = await stripe.products.list()
  const product = products.data.find(p => p.active && p.metadata['shipping-store'] === 'the-tricktionary')
  if (!product) throw new Error('No shipping rate found in stripe')
  return getPrices(product.id, currency)
}

export async function getPrices (productId: string, currency?: string) {
  const prices = await stripe.prices.list({
    product: productId,
    currency
  })
  return prices.data.filter(p => p.active)
}

interface CheckoutSessionParams {
  user?: UserDoc
  products: Array<{ productId: string, quantity: number }>
  currency: Currency
}

export async function createCheckoutSession ({ products, user, currency }: CheckoutSessionParams) {
  const lineItems: Stripe.Checkout.SessionCreateParams.LineItem[] = []
  for (const product of products) {
    const prices = await getPrices(product.productId, currency)
    lineItems.push({
      price: prices[0].id,
      quantity: product.quantity,
      adjustable_quantity: {
        enabled: true
      }
    })
  }
  // TODO: temp fix while waiting for shipping rates to get support for tax rates
  const shippingRate = await getShippingRates(currency)
  lineItems.push({ price: shippingRate[0].id, quantity: 1, adjustable_quantity: { enabled: false } })

  return stripe.checkout.sessions.create({
    success_url: 'https://the-tricktionary.com/shop-success?session_id={CHECKOUT_SESSION_ID}',
    cancel_url: 'https://the-tricktionary.com/shop?state=cancelled', // TODO: include products + qty in query parameters?
    mode: 'payment',
    payment_method_types: ['card'],
    // customer: // TODO store stripeCustomerId on UserDoc if they've made a purchase before?
    customer_email: user?.email,
    line_items: lineItems,
    automatic_tax: { enabled: true },
    tax_id_collection: { enabled: true },
    billing_address_collection: 'auto',
    shipping_address_collection: {
      allowed_countries: postCountries as Stripe.Checkout.SessionCreateParams.ShippingAddressCollection.AllowedCountry[]
    },
    // shipping_rates: [], // TODO add shipping rate
    metadata: { store: 'the-tricktionary' }
  })
}
