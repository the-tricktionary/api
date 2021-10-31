import { Timestamp } from '@google-cloud/firestore'
import { GraphQLScalarType, Kind } from 'graphql'

export const TimestampScalar = new GraphQLScalarType<Timestamp | null, number>({
  name: 'Timestamp',
  description: 'The `Timestamp` scalar represents a UNIX epoch timestamp in milliseconds',
  serialize (value) {
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
