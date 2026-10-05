import net from 'node:net'
import { afterEach, describe, expect, test } from 'vitest'
import { MinecraftTestClient } from '../src/client.js'
import { encodeError, encodeSuccess } from '../src/protocol.js'

const servers: net.Server[] = []

async function makeServer(
  response: string,
): Promise<{ server: net.Server; port: number }> {
  const server = net.createServer((socket) => {
    socket.setEncoding('utf8')
    socket.on('data', () => {
      socket.write(response)
    })
  })

  servers.push(server)

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve())
  })

  const address = server.address()

  if (!address || typeof address === 'string') {
    throw new Error('Test server did not expose a TCP port.')
  }

  return {
    server,
    port: address.port,
  }
}

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve())
        }),
    ),
  )
})

describe('MinecraftTestClient', () => {
  test('sends a restart request and resolves on ready', async () => {
    const { port } = await makeServer(encodeSuccess('ready'))
    const client = new MinecraftTestClient({
      host: '127.0.0.1',
      port,
      timeoutMs: 2_000,
    })

    await expect(client.restart()).resolves.toBeUndefined()
  })

  test('surfaces controller errors', async () => {
    const { port } = await makeServer(encodeError('boom'))
    const client = new MinecraftTestClient({
      host: '127.0.0.1',
      port,
      timeoutMs: 2_000,
    })

    await expect(client.restart()).rejects.toThrow(/boom/)
  })
})
