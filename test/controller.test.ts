import fs from 'node:fs/promises'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, test } from 'vitest'
import { MinecraftController } from '../src/controller.js'

const controllers: MinecraftController[] = []

async function getFreePort(): Promise<number> {
  const server = net.createServer()

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve())
  })

  const address = server.address()

  if (!address || typeof address === 'string') {
    server.close()
    throw new Error('Could not determine a free TCP port.')
  }

  const port = address.port

  await new Promise<void>((resolve) => {
    server.close(() => resolve())
  })

  return port
}

afterEach(async () => {
  await Promise.all(
    controllers.splice(0).map((controller) => controller.stop()),
  )
})

describe('MinecraftController', () => {
  test('keeps restart operations serialized and supports console commands', async () => {
    const serverDirectory = await fs.mkdtemp(
      path.join(os.tmpdir(), 'minecraft-harness-'),
    )
    const serverPort = await getFreePort()
    const controlPort = await getFreePort()

    const controller = new MinecraftController({
      serverDirectory,
      paperJar: path.join(serverDirectory, 'paper.jar'),
      javaCommand: process.execPath,
      javaArgs: [
        fileURLToPath(new URL('./fake-paper.mjs', import.meta.url)),
        '--port',
        String(serverPort),
      ],
      paperArgs: [],
      controlHost: '127.0.0.1',
      controlPort,
      serverHost: '127.0.0.1',
      serverPort,
      startTimeoutMs: 5_000,
      gracefulStopTimeoutMs: 1_000,
      forceStopTimeoutMs: 500,
      portProbeTimeoutMs: 200,
      portWaitTimeoutMs: 2_000,
      opTimeoutMs: 2_000,
    })

    controllers.push(controller)

    await controller.start()

    await Promise.all([
      controller.restart(),
      controller.restart(),
      controller.restart(),
      controller.restart(),
    ])

    expect(controller.state).toBe('running')

    await controller.opPlayer('PlzOp')
    await controller.opPlayer('PlzOp')
  })
})
