import { describe, expect, test } from 'vitest'
import {
  decodeRequest,
  encodeRequest,
  PROTOCOL_VERSION,
} from '../src/protocol.js'

describe('control protocol', () => {
  test('round-trips JSON requests with arguments', () => {
    const line = encodeRequest('op', ['PlzOp'])

    expect(decodeRequest(line)).toEqual({
      version: PROTOCOL_VERSION,
      command: 'op',
      args: ['PlzOp'],
    })
  })

  test('supports human-readable commands for debugging', () => {
    expect(decodeRequest('op PlzOp')).toEqual({
      version: PROTOCOL_VERSION,
      command: 'op',
      args: ['PlzOp'],
    })

    expect(decodeRequest('console "say hello world"')).toEqual({
      version: PROTOCOL_VERSION,
      command: 'console',
      args: ['say hello world'],
    })
  })

  test('supports escaped spaces', () => {
    expect(decodeRequest('console say\\ hello')).toEqual({
      version: PROTOCOL_VERSION,
      command: 'console',
      args: ['say hello'],
    })
  })
})
