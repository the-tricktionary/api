import { randomInt } from 'node:crypto'

/**
 * No `I`, `L`, `O`, `0` or `1`, so a code survives being read out across a
 * sports hall and typed in by somebody who heard it rather than saw it.
 */
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'
const LENGTH = 8

/** A fresh code. Uniqueness is the caller's problem, see the group resolvers. */
export function generateJoinCode (): string {
  let code = ''
  for (let i = 0; i < LENGTH; i++) code += ALPHABET[randomInt(ALPHABET.length)]
  return code
}
