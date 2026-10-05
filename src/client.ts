import net from 'node:net'
import {
  PROTOCOL_VERSION,
  type ControlResponse,
  encodeRequest,
} from './protocol.js'

export interface MinecraftTestClientOptions {
  host?: string
  port?: number
  timeoutMs?: number
}

const DEFAULT_HOST = '127.0.0.1'
const DEFAULT_PORT = 25575
const DEFAULT_TIMEOUT_MS = 120_000

export class MinecraftTestClient {
  private readonly host: string
  private readonly port: number
  private readonly timeoutMs: number
  private restartPromise: Promise<void> | undefined

  public constructor(options: MinecraftTestClientOptions = {}) {
    this.host = options.host ?? DEFAULT_HOST
    this.port = options.port ?? DEFAULT_PORT
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS

    validatePort(this.port, 'control port')

    if (!this.host) {
      throw new Error('Minecraft control host must not be empty.')
    }

    if (!Number.isFinite(this.timeoutMs) || this.timeoutMs <= 0) {
      throw new Error(`Invalid control timeout: ${this.timeoutMs}`)
    }
  }

  public ping(): Promise<'pong' | 'starting'> {
    return this.request('ping').then((response) => {
      if (response.message === 'pong') {
        return 'pong'
      }

      if (response.message === 'starting') {
        return 'starting'
      }

      throw new Error(
        `Unexpected ping response: ${response.message ?? '<empty>'}`,
      )
    })
  }

  public async waitForServer(timeoutMs = this.timeoutMs): Promise<void> {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      throw new Error(`Invalid wait timeout: ${timeoutMs}`)
    }

    const deadline = Date.now() + timeoutMs
    let lastError: unknown

    while (Date.now() < deadline) {
      try {
        if ((await this.ping()) === 'pong') {
          return
        }
      } catch (error) {
        lastError = error
      }

      await sleep(Math.min(250, Math.max(1, deadline - Date.now())))
    }

    throw new Error(
      `Timed out waiting for the Minecraft controller/server to become ready.${
        lastError ? ` Last error: ${formatError(lastError)}` : ''
      }`,
    )
  }

  public restart(): Promise<void> {
    if (this.restartPromise) {
      return this.restartPromise
    }

    const promise = this.request('restart').then(() => undefined)
    this.restartPromise = promise

    void promise.then(
      () => {
        if (this.restartPromise === promise) {
          this.restartPromise = undefined
        }
      },
      () => {
        if (this.restartPromise === promise) {
          this.restartPromise = undefined
        }
      },
    )

    return promise
  }

  public sendConsoleCommand(command: string): Promise<void> {
    const normalized = command.trim()

    if (!normalized) {
      return Promise.reject(
        new Error('Minecraft console command must not be empty.'),
      )
    }

    return this.request('console', [normalized]).then(() => undefined)
  }

  public opPlayer(playerName: string): Promise<void> {
    validatePlayerName(playerName)

    return this.request('op', [playerName]).then(() => undefined)
  }

  public async request(
    command: string,
    args: readonly string[] = [],
  ): Promise<ControlResponse> {
    const payload = encodeRequest(command, args)

    return new Promise<ControlResponse>((resolve, reject) => {
      const socket = net.createConnection({
        host: this.host,
        port: this.port,
      })

      socket.setEncoding('utf8')
      socket.setNoDelay(true)

      let buffer = ''
      let settled = false
      const timeout = setTimeout(() => {
        finish(
          new Error(
            `Timed out waiting for Minecraft control command "${command}" ` +
              `after ${this.timeoutMs}ms.`,
          ),
        )
      }, this.timeoutMs)

      const cleanup = () => {
        clearTimeout(timeout)
        socket.removeAllListeners()
        socket.destroy()
      }

      const finish = (error?: Error, response?: ControlResponse) => {
        if (settled) {
          return
        }

        settled = true
        cleanup()

        if (error) {
          reject(error)
        } else if (response) {
          resolve(response)
        } else {
          reject(new Error('Control server returned no response.'))
        }
      }

      socket.once('connect', () => {
        socket.write(payload, (error) => {
          if (error) {
            finish(
              new Error(
                `Failed to send Minecraft control command "${command}": ${error.message}`,
              ),
            )
          }
        })
      })

      socket.on('data', (data) => {
        buffer += data

        while (true) {
          const newline = buffer.indexOf('\n')

          if (newline === -1) {
            break
          }

          const line = buffer.slice(0, newline).trim()
          buffer = buffer.slice(newline + 1)

          if (!line) {
            continue
          }

          let parsed: unknown

          try {
            parsed = JSON.parse(line)
          } catch (error) {
            finish(
              new Error(
                `Minecraft control server returned invalid JSON: ${String(error)}`,
              ),
            )
            return
          }

          if (!isControlResponse(parsed)) {
            finish(
              new Error('Minecraft control server returned an invalid response.'),
            )
            return
          }

          if (parsed.version !== PROTOCOL_VERSION) {
            finish(
              new Error(
                `Unsupported Minecraft control protocol version: ${parsed.version}`,
              ),
            )
            return
          }

          if (!parsed.ok) {
            finish(
              new Error(
                `Minecraft control command "${command}" failed: ${
                  parsed.message ?? 'unknown error'
                }`,
              ),
            )
            return
          }

          finish(undefined, parsed)
          return
        }
      })

      socket.once('error', (error) => {
        finish(
          new Error(
            [
              'Could not connect to the Minecraft test controller.',
              '',
              error.message,
              '',
              `Controller: ${this.host}:${this.port}`,
            ].join('\n'),
          ),
        )
      })

      socket.once('close', () => {
        if (!settled) {
          finish(
            new Error(
              `Minecraft control server disconnected before "${command}" completed.`,
            ),
          )
        }
      })
    })
  }
}

export function createMinecraftTestClient(
  options?: MinecraftTestClientOptions,
): MinecraftTestClient {
  return new MinecraftTestClient(options)
}

let defaultClient: MinecraftTestClient | undefined

function resolveDefaultClient(): MinecraftTestClient {
  if (!defaultClient) {
    defaultClient = createMinecraftTestClient({
      host: process.env.TEST_CONTROL_HOST ?? DEFAULT_HOST,
      port: parseOptionalPort(
        process.env.TEST_CONTROL_PORT,
        DEFAULT_PORT,
      ),
      timeoutMs: parseOptionalTimeout(
        process.env.TEST_CONTROL_TIMEOUT_MS,
        DEFAULT_TIMEOUT_MS,
      ),
    })
  }

  return defaultClient
}

export function restartServer(): Promise<void> {
  return resolveDefaultClient().restart()
}

export function sendConsoleCommand(command: string): Promise<void> {
  return resolveDefaultClient().sendConsoleCommand(command)
}

export function opPlayer(playerName: string): Promise<void> {
  return resolveDefaultClient().opPlayer(playerName)
}

export function pingServer(): Promise<'pong' | 'starting'> {
  return resolveDefaultClient().ping()
}

export function waitForServer(timeoutMs?: number): Promise<void> {
  return resolveDefaultClient().waitForServer(timeoutMs)
}

export function getDefaultClient(): MinecraftTestClient {
  return resolveDefaultClient()
}


function parseOptionalPort(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === '') {
    return fallback
  }

  return Number(value)
}

function parseOptionalTimeout(
  value: string | undefined,
  fallback: number,
): number {
  if (value === undefined || value.trim() === '') {
    return fallback
  }

  return Number(value)
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function validatePort(port: number, label: string): void {
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`Invalid ${label}: ${port}`)
  }
}

function validatePlayerName(playerName: string): void {
  if (!/^[A-Za-z0-9_]{1,16}$/.test(playerName)) {
    throw new Error(
      'Invalid Minecraft player name. Expected 1-16 letters, numbers, or underscores.',
    )
  }
}

function isControlResponse(value: unknown): value is ControlResponse {
  if (typeof value !== 'object' || value === null) {
    return false
  }

  const record = value as Record<string, unknown>

  return (
    record.version === PROTOCOL_VERSION &&
    typeof record.ok === 'boolean' &&
    (record.message === undefined || typeof record.message === 'string')
  )
}
