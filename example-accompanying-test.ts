import { describe, expect, test } from 'vitest'
import mineflayer, { type Bot } from 'mineflayer'
import { opPlayer } from '../test-server'

const HOST = 'localhost'
const PORT = Number(process.env.TEST_SERVER_PORT ?? 25565)

const PLAYER_NAME = 'PlzOp'
const JOIN_TIMEOUT = 30_000
const CHAT_TIMEOUT = 15_000

if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65_535) {
  throw new Error(`Invalid TEST_SERVER_PORT: ${PORT}`)
}

function waitForPlayerJoin(bot: Bot): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let settled = false

    const timeout = setTimeout(() => {
      finish(
        new Error(
          `Timed out after ${JOIN_TIMEOUT / 1000}s waiting for ${PLAYER_NAME} to join.`,
        ),
      )
    }, JOIN_TIMEOUT)

    const cleanup = () => {
      clearTimeout(timeout)
      bot.off('spawn', onSpawn)
      bot.off('error', onError)
      bot.off('kicked', onKicked)
    }

    const finish = (error?: Error) => {
      if (settled) return

      settled = true
      cleanup()

      if (error) {
        reject(error)
      } else {
        resolve()
      }
    }

    const onSpawn = () => {
      finish()
    }

    const onError = (error: Error) => {
      finish(
        new Error(
          `Mineflayer failed while joining as ${PLAYER_NAME}: ${error.message}`,
        ),
      )
    }

    const onKicked = (reason: string) => {
      finish(
        new Error(
          `${PLAYER_NAME} was kicked while joining: ${reason}`,
        ),
      )
    }

    bot.once('spawn', onSpawn)
    bot.once('error', onError)
    bot.once('kicked', onKicked)
  })
}

function waitForAlreadyOperatorMessage(bot: Bot): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    let settled = false

    const timeout = setTimeout(() => {
      finish(
        new Error(
          [
            `Timed out after ${CHAT_TIMEOUT / 1000}s waiting for the operator error message.`,
            '',
            'Expected a chat message indicating that PlzOp is already an operator.',
          ].join('\n'),
        ),
      )
    }, CHAT_TIMEOUT)

    const cleanup = () => {
      clearTimeout(timeout)
      bot.off('messagestr', onMessage)
      bot.off('error', onError)
      bot.off('kicked', onKicked)
    }

    const finish = (error?: Error, message?: string) => {
      if (settled) return

      settled = true
      cleanup()

      if (error) {
        reject(error)
      } else {
        resolve(message ?? '')
      }
    }

    const onMessage = (message: string) => {
      console.log(`[${PLAYER_NAME}] ${message}`)

      if (
        /already/i.test(message) &&
        /operator/i.test(message)
      ) {
        finish(undefined, message)
      }
    }

    const onError = (error: Error) => {
      finish(
        new Error(
          `Mineflayer errored while waiting for the operator message: ${error.message}`,
        ),
      )
    }

    const onKicked = (reason: string) => {
      finish(
        new Error(
          `${PLAYER_NAME} was kicked before receiving the operator message: ${reason}`,
        ),
      )
    }

    bot.on('messagestr', onMessage)
    bot.once('error', onError)
    bot.once('kicked', onKicked)
  })
}

function createTestBot(): Bot {
  return mineflayer.createBot({
    host: HOST,
    port: PORT,
    username: PLAYER_NAME,
    auth: 'offline',
  })
}

describe('Minecraft operator handling', () => {
  // This is a demo test and remains skipped. Remove test.skip when implementing it.

  test(
    'can op a player and the player is already an operator',
    async () => {
      const bot = createTestBot()

      try {
        await waitForPlayerJoin(bot)

        // Give PlzOp operator status through the controller.
        await opPlayer(PLAYER_NAME)

        // Start listening before issuing the command so the response
        // cannot be missed.
        const alreadyOperatorMessage =
          waitForAlreadyOperatorMessage(bot)

        // This command is issued by PlzOp itself.
        bot.chat('/op PlzOp')

        const message = await alreadyOperatorMessage

        expect(message).toMatch(/already/i)
        expect(message).toMatch(/operator/i)
      } finally {
        bot.quit('integration test complete')
      }
    },
    60_000,
  )
})
