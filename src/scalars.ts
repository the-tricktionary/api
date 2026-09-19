import { Timestamp } from '@google-cloud/firestore'
import { GraphQLScalarType, Kind, valueFromASTUntyped } from 'graphql'
import { ValidationError } from './errors.js'

export const TimestampScalar = new GraphQLScalarType<Timestamp | null, number>({
  name: 'Timestamp',
  description: 'The `Timestamp` scalar represents a UNIX epoch timestamp in milliseconds',
  serialize (value) {
    // Mark streams store their timestamps as plain millisecond numbers
    if (typeof value === 'number') return value
    return Timestamp.prototype.toMillis.call(value)
  },
  parseValue (value) {
    if (typeof value !== 'number') return null
    return Timestamp.fromMillis(value)
  },
  parseLiteral (ast) {
    if (ast.kind === Kind.INT) {
      return Timestamp.fromMillis(parseInt(ast.value, 10))
    }
    return null
  }
})

function asPlainObject (value: unknown) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ValidationError('The `JSONObject` scalar only accepts objects')
  }
  return value as Record<string, unknown>
}

export const JSONObjectScalar = new GraphQLScalarType<Record<string, unknown>, Record<string, unknown>>({
  name: 'JSONObject',
  description: 'The `JSONObject` scalar represents an arbitrarily nested JSON object',
  serialize (value) {
    return asPlainObject(value)
  },
  parseValue (value) {
    return asPlainObject(value)
  },
  parseLiteral (ast) {
    if (ast.kind !== Kind.OBJECT) throw new ValidationError('The `JSONObject` scalar only accepts objects')
    return valueFromASTUntyped(ast) as Record<string, unknown>
  }
})
