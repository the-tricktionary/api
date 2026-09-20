import { randomInt } from 'node:crypto'

/** No `I`, `L`, `O`, `0` or `1`, so a code read aloud is not mistyped */
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'
const LENGTH = 8

export function generateJoinCode (): string {
  let code = ''
  for (let i = 0; i < LENGTH; i++) code += ALPHABET[randomInt(ALPHABET.length)]
  return code
}
