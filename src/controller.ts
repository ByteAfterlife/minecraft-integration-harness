import net from 'node:net'
import { spawn, type ChildProcess } from 'node:child_process'
import path from 'node:path'
import { createInterface } from 'node:readline'
import {
  decodeRequest,
  encodeError,
  encodeSuccess,
  PROTOCOL_VERSION,
  type ControlRequest,
} from './protocol.js'

export interface MinecraftControllerOptions {
  serverDirectory: string
  paperJar?: string
  javaCommand?: string
  javaArgs?: readonly string[]
  paperArgs?: readonly string[]
  controlHost?: string
  controlPort?: number
  serverHost?: string
  serverPort?: number
  startTimeoutMs?: number
  gracefulStopTimeoutMs?: number
  forceStopTimeoutMs?: number
  portProbeTimeoutMs?: number
  portWaitTimeoutMs?: number
  opTimeoutMs?: number
  readyPattern?: RegExp
}

type MinecraftState = 'stopped' | 'starting' | 'running' | 'stopping'

interface MinecraftInstance {
  child: ChildProcess
  pid: number
  state: MinecraftState
  exited: boolean
  exitPromise: Promise<void>
  resolveExit: () => void
}

interface ConsoleWaiter {
  pattern: RegExp
  resolve: () => void
  reject: (error: Error) => void
  timeout: NodeJS.Timeout
  buffer: string
}

const DEFAULT_CONTROL_HOST = '127.0.0.1'
const DEFAULT_CONTROL_PORT = 25575
const DEFAULT_SERVER_PORT = 25565
const DEFAULT_START_TIMEOUT_MS = 120_000
const DEFAULT_GRACEFUL_STOP_TIMEOUT_MS = 15_000
const DEFAULT_FORCE_STOP_TIMEOUT_MS = 5_000
const DEFAULT_PORT_PROBE_TIMEOUT_MS = 750
const DEFAULT_PORT_WAIT_TIMEOUT_MS = 15_000
const DEFAULT_OP_TIMEOUT_MS = 15_000
const DEFAULT_READY_PATTERN = /Done \([0-9.]+s\)! For help, type "help"/
const MAX_CAPTURED_OUTPUT = 100_000

export class MinecraftController {
  private readonly serverDirectory: string
  private readonly paperJar: string
  private readonly javaCommand: string
  private readonly javaArgs: readonly string[]
  private readonly paperArgs: readonly string[]
  private readonly controlHost: string
  private readonly controlPort: number
  private readonly serverHost: string
  private readonly serverPort: number
  private readonly startTimeoutMs: number
  private readonly gracefulStopTimeoutMs: number
  private readonly forceStopTimeoutMs: number
  private readonly portProbeTimeoutMs: number
  private readonly portWaitTimeoutMs: number
  private readonly opTimeoutMs: number
  private readonly readyPattern: RegExp

  private minecraft: MinecraftInstance | undefined
  private minecraftState: MinecraftState = 'stopped'

  private startupPromise: Promise<void> | undefined
  private lifecyclePromise: Promise<void> | undefined
  private operationTail: Promise<void> = Promise.resolve()
  private shutdownPromise: Promise<void> | undefined

  private controlServer: net.Server | undefined
  private shuttingDown = false

  private readonly sockets = new Set<net.Socket>()
  private readonly consoleWaiters = new Set<ConsoleWaiter>()

  public constructor(options: MinecraftControllerOptions) {
    if (!options.serverDirectory) {
      throw new Error('serverDirectory is required.')
    }

    this.serverDirectory = path.resolve(options.serverDirectory)
    this.paperJar = path.resolve(
      this.serverDirectory,
      options.paperJar ?? 'paper.jar',
    )
    this.javaCommand = options.javaCommand ?? 'java'
    this.javaArgs = options.javaArgs ?? ['-Xms1G', '-Xmx3G']
    this.paperArgs = options.paperArgs ?? ['--nogui']
    this.controlHost = options.controlHost ?? DEFAULT_CONTROL_HOST
    this.controlPort = options.controlPort ?? DEFAULT_CONTROL_PORT
    this.serverHost = options.serverHost ?? '127.0.0.1'
    this.serverPort = options.serverPort ?? DEFAULT_SERVER_PORT
    this.startTimeoutMs = options.startTimeoutMs ?? DEFAULT_START_TIMEOUT_MS
    this.gracefulStopTimeoutMs =
      options.gracefulStopTimeoutMs ?? DEFAULT_GRACEFUL_STOP_TIMEOUT_MS
    this.forceStopTimeoutMs =
      options.forceStopTimeoutMs ?? DEFAULT_FORCE_STOP_TIMEOUT_MS
    this.portProbeTimeoutMs =
      options.portProbeTimeoutMs ?? DEFAULT_PORT_PROBE_TIMEOUT_MS
    this.portWaitTimeoutMs =
      options.portWaitTimeoutMs ?? DEFAULT_PORT_WAIT_TIMEOUT_MS
    this.opTimeoutMs = options.opTimeoutMs ?? DEFAULT_OP_TIMEOUT_MS
    this.readyPattern = options.readyPattern ?? DEFAULT_READY_PATTERN

    this.validateOptions()
  }

  public get state(): MinecraftState {
    return this.minecraftState
  }

  public get isListening(): boolean {
    return this.controlServer?.listening ?? false
  }

  public async start(): Promise<void> {
    if (this.shuttingDown) {
      throw new Error('Minecraft controller is shutting down.')
    }

    if (this.lifecyclePromise) {
      return this.lifecyclePromise
    }

    if (!this.controlServer) {
      await this.listenForControlConnections()
    }

    return this.runStartupOperation()
  }

  public restart(): Promise<void> {
    if (this.shuttingDown) {
      return Promise.reject(
        new Error('Minecraft controller is shutting down.'),
      )
    }

    if (this.lifecyclePromise) {
      return this.lifecyclePromise
    }

    const operation = this.enqueueOperation(async () => {
      if (this.startupPromise) {
        await this.startupPromise
      }

      if (this.shuttingDown) {
        throw new Error('Minecraft controller is shutting down.')
      }

      if (this.minecraft || this.minecraftState !== 'stopped') {
        await this.stopMinecraft()
      }

      if (this.shuttingDown) {
        return
      }

      await this.startMinecraft()
    })

    const promise = operation.finally(() => {
      if (this.lifecyclePromise === promise) {
        this.lifecyclePromise = undefined
      }
    })

    this.lifecyclePromise = promise
    return promise
  }

  public sendConsoleCommand(command: string): Promise<void> {
    const normalized = command.trim()

    if (!normalized) {
      return Promise.reject(
        new Error('Minecraft console command must not be empty.'),
      )
    }

    return this.enqueueOperation(async () => {
      await this.waitForRunning()

      const instance = this.requireRunningInstance()
      await this.writeConsoleCommand(instance, normalized)
    })
  }

  public opPlayer(playerName: string): Promise<void> {
    if (!/^[A-Za-z0-9_]{1,16}$/.test(playerName)) {
      return Promise.reject(
        new Error(
          'Invalid Minecraft player name. Expected 1-16 letters, numbers, or underscores.',
        ),
      )
    }

    return this.enqueueOperation(async () => {
      await this.waitForRunning()

      const instance = this.requireRunningInstance()
      const confirmation = new RegExp(
        [
          `Made\\s+${escapeRegExp(playerName)}\\s+a\\s+server\\s+operator`,
          `${escapeRegExp(playerName)}.*already.*server\\s+operator`,
          `${escapeRegExp(playerName)}.*already.*operator`,
        ].join('|'),
        'i',
      )

      const waiter = this.waitForConsoleOutput(
        confirmation,
        this.opTimeoutMs,
      )

      try {
        await this.writeConsoleCommand(instance, `op ${playerName}`)
        await waiter.promise
      } catch (error) {
        waiter.cancel(
          error instanceof Error ? error : new Error(String(error)),
        )

        throw error
      }
    })
  }

  public async stop(): Promise<void> {
    if (this.shutdownPromise) {
      return this.shutdownPromise
    }

    this.shutdownPromise = (async () => {
      this.shuttingDown = true

      this.rejectConsoleWaiters(
        new Error('Minecraft controller is shutting down.'),
      )

      for (const socket of this.sockets) {
        socket.destroy()
      }

      this.sockets.clear()

      await this.closeControlServer()

      if (this.startupPromise) {
        try {
          await this.startupPromise
        } catch {
        }
      }

      try {
        await this.operationTail
      } catch {
      }

      if (this.minecraft) {
        await this.stopMinecraft()
      }

      this.minecraftState = 'stopped'
    })()

    return this.shutdownPromise
  }

  private validateOptions(): void {
    if (!this.controlHost) {
      throw new Error('controlHost must not be empty.')
    }

    if (!this.serverHost) {
      throw new Error('serverHost must not be empty.')
    }

    validatePort(this.controlPort, 'control port')
    validatePort(this.serverPort, 'server port')

    for (const [name, value] of [
      ['startTimeoutMs', this.startTimeoutMs],
      ['gracefulStopTimeoutMs', this.gracefulStopTimeoutMs],
      ['forceStopTimeoutMs', this.forceStopTimeoutMs],
      ['portProbeTimeoutMs', this.portProbeTimeoutMs],
      ['portWaitTimeoutMs', this.portWaitTimeoutMs],
      ['opTimeoutMs', this.opTimeoutMs],
    ] as const) {
      if (!Number.isFinite(value) || value <= 0) {
        throw new Error(`Invalid ${name}: ${value}`)
      }
    }

    if (!this.javaCommand) {
      throw new Error('javaCommand must not be empty.')
    }
  }

  private enqueueOperation<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.operationTail

    const current = previous
      .catch(() => undefined)
      .then(operation)

    this.operationTail = current.then(
      () => undefined,
      () => undefined,
    )

    return current
  }

  private runStartupOperation(): Promise<void> {
    if (this.startupPromise) {
      return this.startupPromise
    }

    if (this.minecraftState === 'running' && this.minecraft) {
      return Promise.resolve()
    }

    const promise = this.startMinecraft().finally(() => {
      if (this.startupPromise === promise) {
        this.startupPromise = undefined
      }
    })

    this.startupPromise = promise
    return promise
  }

  private async listenForControlConnections(): Promise<void> {
    if (this.controlServer) {
      return
    }

    const server = net.createServer((socket) => {
      this.handleSocket(socket)
    })

    this.controlServer = server

    try {
      await new Promise<void>((resolve, reject) => {
        const onListening = () => {
          server.off('error', onError)
          console.log(
            `Minecraft test controller listening on ${this.controlHost}:${this.controlPort}`,
          )
          resolve()
        }

        const onError = (error: Error) => {
          server.off('listening', onListening)
          reject(error)
        }

        server.once('listening', onListening)
        server.once('error', onError)
        server.listen(this.controlPort, this.controlHost)
      })
    } catch (error) {
      this.controlServer = undefined
      throw error
    }
  }

  private handleSocket(socket: net.Socket): void {
    this.sockets.add(socket)
    socket.setEncoding('utf8')
    socket.setNoDelay(true)

    const readline = createInterface({
      input: socket,
      crlfDelay: Infinity,
    })

    let requestTail: Promise<void> = Promise.resolve()

    const send = (data: string) => {
      if (!socket.destroyed && !socket.writableEnded) {
        socket.write(data)
      }
    }

    readline.on('line', (line) => {
      requestTail = requestTail
        .catch(() => undefined)
        .then(async () => {
          try {
            const request = decodeRequest(line)
            await this.handleRequest(request, send)
          } catch (error) {
            send(encodeError(formatError(error)))
          }
        })
    })

    const cleanup = () => {
      this.sockets.delete(socket)
      readline.close()
    }

    socket.once('close', cleanup)
    socket.on('error', (error) => {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'ECONNRESET' && code !== 'EPIPE') {
        console.error(`Control connection error: ${error.message}`)
      }
    })
  }

  private async handleRequest(
    request: ControlRequest,
    send: (data: string) => void,
  ): Promise<void> {
    if (request.version !== PROTOCOL_VERSION) {
      send(encodeError(`Unsupported protocol version: ${request.version}`))
      return
    }

    switch (request.command) {
      case 'ping':
        if (request.args.length !== 0) {
          send(encodeError('usage: ping'))
          return
        }

        send(
          encodeSuccess(
            this.minecraftState === 'running' ? 'pong' : 'starting',
          ),
        )
        return

      case 'restart':
        if (request.args.length !== 0) {
          send(encodeError('usage: restart'))
          return
        }

        try {
          await this.restart()
          send(encodeSuccess('ready'))
        } catch (error) {
          send(encodeError(formatError(error)))
        }
        return

      case 'console':
        if (request.args.length < 1) {
          send(encodeError('usage: console <command>'))
          return
        }

        try {
          await this.sendConsoleCommand(request.args.join(' '))
          send(encodeSuccess('ok'))
        } catch (error) {
          send(encodeError(formatError(error)))
        }
        return

      case 'op':
        if (request.args.length !== 1) {
          send(encodeError('usage: op <player>'))
          return
        }

        try {
          await this.opPlayer(request.args[0]!)
          send(encodeSuccess('ok'))
        } catch (error) {
          send(encodeError(formatError(error)))
        }
        return

      default:
        send(
          encodeError(
            `Unknown control command "${request.command}". Supported commands: ping, restart, console, op.`,
          ),
        )
    }
  }

  private async startMinecraft(): Promise<void> {
    if (this.minecraft || this.minecraftState !== 'stopped') {
      throw new Error(
        `Minecraft cannot start while lifecycle state is '${this.minecraftState}'.`,
      )
    }

    if (await this.portIsOpen(this.serverPort)) {
      throw new Error(
        `Minecraft port ${this.serverPort} is already in use. Refusing to start a second Paper process.`,
      )
    }

    console.log(`Starting Minecraft server from ${this.serverDirectory}...`)

    let child: ChildProcess

    try {
      child = spawn(
        this.javaCommand,
        [
          ...this.javaArgs,
          '-jar',
          this.paperJar,
          ...this.paperArgs,
        ],
        {
          cwd: this.serverDirectory,
          stdio: ['pipe', 'pipe', 'pipe'],
          windowsHide: true,
        },
      )
    } catch (error) {
      throw new Error(`Failed to spawn Minecraft: ${formatError(error)}`)
    }

    const instance = this.makeMinecraftInstance(child)

    this.minecraft = instance
    this.minecraftState = 'starting'

    let output = ''
    let settled = false
    let timeoutHandle: NodeJS.Timeout | undefined

    const appendOutput = (data: Buffer | string) => {
      const text = data.toString()
      process.stdout.write(text)
      this.notifyConsoleOutput(text)

      output += text
      if (output.length > MAX_CAPTURED_OUTPUT) {
        output = output.slice(-MAX_CAPTURED_OUTPUT / 2)
      }
    }

    child.stdout?.on('data', appendOutput)
    child.stderr?.on('data', appendOutput)

    try {
      instance.pid = await this.waitForChildSpawn(child)
      console.log(`Minecraft Paper PID ${instance.pid}`)

      await new Promise<void>((resolve, reject) => {
        const finish = (error?: Error) => {
          if (settled) return
          settled = true

          if (timeoutHandle) {
            clearTimeout(timeoutHandle)
            timeoutHandle = undefined
          }

          if (error) reject(error)
          else resolve()
        }

        const checkReady = async () => {
          if (settled || !this.readyPattern.test(output)) {
            return
          }

          const portReady = await this.waitForPort(
            this.serverPort,
            true,
            this.portWaitTimeoutMs,
          )

          if (!portReady) {
            finish(
              new Error(
                [
                  `Minecraft reported ready, but port ${this.serverPort} never became reachable.`,
                  `Paper PID: ${instance.pid}`,
                  '',
                  'Minecraft output:',
                  output,
                ].join('\n'),
              ),
            )
            return
          }

          if (this.shuttingDown) {
            finish(new Error('Minecraft controller is shutting down.'))
            return
          }

          instance.state = 'running'
          this.minecraftState = 'running'
          console.log(
            `Minecraft server is ready on ${this.serverHost}:${this.serverPort}.`,
          )
          finish()
        }

        child.once('error', (error) => {
          finish(
            new Error(
              [
                `Failed to start Minecraft server: ${error.message}`,
                `Paper PID: ${instance.pid}`,
                '',
                'Minecraft output:',
                output,
              ].join('\n'),
            ),
          )
        })

        child.once('exit', (code, signal) => {
          if (settled) return

          finish(
            new Error(
              [
                'Minecraft server exited before becoming ready.',
                `Exit code: ${code ?? 'null'}`,
                `Signal: ${signal ?? 'none'}`,
                `Paper PID: ${instance.pid}`,
                '',
                'Minecraft output:',
                output,
              ].join('\n'),
            ),
          )
        })

        timeoutHandle = setTimeout(() => {
          finish(
            new Error(
              [
                `Timed out waiting for Minecraft server to start after ${this.startTimeoutMs / 1000} seconds.`,
                `Paper PID: ${instance.pid}`,
                '',
                'Minecraft output:',
                output,
              ].join('\n'),
            ),
          )
        }, this.startTimeoutMs)

        child.stdout?.on('data', () => {
          void checkReady()
        })

        child.stderr?.on('data', () => {
          void checkReady()
        })

        void checkReady()
      })
    } catch (error) {
      if (!instance.exited) {
        await this.terminateMinecraft(instance, 'startup failed')
      }

      if (this.minecraft === instance) {
        this.minecraft = undefined
        this.minecraftState = 'stopped'
      }

      throw error
    }
  }

  private makeMinecraftInstance(child: ChildProcess): MinecraftInstance {
    let resolveExit!: () => void

    const exitPromise = new Promise<void>((resolve) => {
      resolveExit = resolve
    })

    const instance: MinecraftInstance = {
      child,
      pid: child.pid ?? 0,
      state: 'starting',
      exited: false,
      exitPromise,
      resolveExit,
    }

    child.once('exit', (code, signal) => {
      instance.exited = true
      instance.resolveExit()

      this.rejectConsoleWaiters(
        new Error(
          `Minecraft process exited while a console operation was pending ` +
            `(code=${code ?? 'null'}, signal=${signal ?? 'none'}).`,
        ),
      )

      if (this.minecraft === instance) {
        this.minecraft = undefined
        this.minecraftState = 'stopped'
      }

      console.log(
        `Minecraft Paper PID ${instance.pid || 'unknown'} exited ` +
          `(code=${code ?? 'null'}, signal=${signal ?? 'none'}).`,
      )
    })

    return instance
  }

  private async stopMinecraft(): Promise<void> {
    const instance = this.minecraft

    if (!instance) {
      this.minecraftState = 'stopped'

      if (
        !(await this.waitForPort(
          this.serverPort,
          false,
          this.portWaitTimeoutMs,
        ))
      ) {
        throw new Error(
          `Minecraft port ${this.serverPort} is still in use even though the controller has no Paper child. Refusing to start another Paper process.`,
        )
      }

      return
    }

    this.minecraftState = 'stopping'
    instance.state = 'stopping'

    console.log(`Stopping Minecraft server (PID ${instance.pid})...`)

    const stdin = instance.child.stdin

    if (stdin && !stdin.destroyed && !stdin.writableEnded) {
      await new Promise<void>((resolve) => {
        stdin.write('stop\n', (error) => {
          if (error) {
            void this.terminateMinecraft(
              instance,
              `failed to send the stop command: ${error.message}`,
            ).finally(resolve)
            return
          }

          resolve()
        })
      })
    } else {
      await this.terminateMinecraft(instance, 'stdin is unavailable')
    }

    if (!(await this.waitForChildExit(instance, this.gracefulStopTimeoutMs))) {
      await this.terminateMinecraft(
        instance,
        `graceful stop did not complete within ${this.gracefulStopTimeoutMs / 1000}s`,
      )
    }

    if (!instance.exited && instance.child.exitCode === null) {
      throw new Error(
        `Minecraft PID ${instance.pid} could not be stopped. Refusing to start another Paper process.`,
      )
    }

    if (this.minecraft === instance) {
      this.minecraft = undefined
    }

    this.minecraftState = 'stopped'

    if (
      !(await this.waitForPort(
        this.serverPort,
        false,
        this.portWaitTimeoutMs,
      ))
    ) {
      throw new Error(
        `Minecraft PID ${instance.pid} exited, but port ${this.serverPort} is still in use. Refusing to start a replacement Paper process.`,
      )
    }

    console.log('Minecraft process has exited and its port is closed.')
  }

  private async waitForRunning(): Promise<void> {
    if (this.minecraftState === 'running' && this.minecraft) {
      return
    }

    if (this.lifecyclePromise) {
      await this.lifecyclePromise
    } else if (this.startupPromise) {
      await this.startupPromise
    }

    if (this.shuttingDown) {
      throw new Error('Minecraft controller is shutting down.')
    }

    if (this.minecraftState !== 'running' || !this.minecraft) {
      throw new Error(
        `Minecraft is not running (state=${this.minecraftState}).`,
      )
    }
  }

  private requireRunningInstance(): MinecraftInstance {
    const instance = this.minecraft

    if (!instance || instance.exited || this.minecraftState !== 'running') {
      throw new Error('Minecraft is not currently running.')
    }

    return instance
  }

  private async writeConsoleCommand(
    instance: MinecraftInstance,
    command: string,
  ): Promise<void> {
    if (this.minecraft !== instance || instance.exited) {
      throw new Error('Minecraft instance is no longer active.')
    }

    const stdin = instance.child.stdin

    if (!stdin || stdin.destroyed || stdin.writableEnded) {
      throw new Error('Minecraft console stdin is unavailable.')
    }

    await new Promise<void>((resolve, reject) => {
      stdin.write(`${command}\n`, (error) => {
        if (error) reject(error)
        else resolve()
      })
    })
  }

  private waitForConsoleOutput(
    pattern: RegExp,
    timeoutMs: number,
  ): {
    promise: Promise<void>
    cancel: (error: Error) => void
  } {
    let waiter!: ConsoleWaiter

    const promise = new Promise<void>((resolve, reject) => {
      waiter = {
        pattern,
        resolve: () => {
          clearTimeout(waiter.timeout)
          this.consoleWaiters.delete(waiter)
          resolve()
        },
        reject: (error) => {
          clearTimeout(waiter.timeout)
          this.consoleWaiters.delete(waiter)
          reject(error)
        },
        timeout: setTimeout(() => {
          this.consoleWaiters.delete(waiter)
          reject(
            new Error(
              `Timed out waiting for Minecraft console confirmation matching ${pattern}.`,
            ),
          )
        }, timeoutMs),
        buffer: '',
      }

      this.consoleWaiters.add(waiter)
    })

    return {
      promise,
      cancel: (error) => {
        if (this.consoleWaiters.has(waiter)) {
          waiter.reject(error)
        }
      },
    }
  }

  private notifyConsoleOutput(text: string): void {
    for (const waiter of this.consoleWaiters) {
      waiter.buffer += text

      if (waiter.buffer.length > 20_000) {
        waiter.buffer = waiter.buffer.slice(-10_000)
      }

      if (waiter.pattern.test(waiter.buffer)) {
        waiter.resolve()
      }
    }
  }

  private rejectConsoleWaiters(error: Error): void {
    for (const waiter of [...this.consoleWaiters]) {
      waiter.reject(error)
    }
  }

  private async terminateMinecraft(
    instance: MinecraftInstance,
    reason: string,
  ): Promise<void> {
    if (instance.exited) return

    console.warn(`Stopping Minecraft PID ${instance.pid}: ${reason}`)

    try {
      instance.child.kill('SIGTERM')
    } catch {
    }

    if (await this.waitForChildExit(instance, this.forceStopTimeoutMs)) {
      return
    }

    console.warn(
      `Minecraft PID ${instance.pid} ignored SIGTERM; sending SIGKILL.`,
    )

    try {
      instance.child.kill('SIGKILL')
    } catch {
    }

    await this.waitForChildExit(instance, this.forceStopTimeoutMs)
  }

  private async waitForChildExit(
    instance: MinecraftInstance,
    timeoutMs: number,
  ): Promise<boolean> {
    if (instance.exited || instance.child.exitCode !== null) {
      return true
    }

    let timeoutHandle: NodeJS.Timeout | undefined

    const timeout = new Promise<boolean>((resolve) => {
      timeoutHandle = setTimeout(() => resolve(false), timeoutMs)
    })

    const exited = instance.exitPromise.then(() => true)
    const result = await Promise.race([exited, timeout])

    if (timeoutHandle) {
      clearTimeout(timeoutHandle)
    }

    return result
  }

  private async waitForChildSpawn(child: ChildProcess): Promise<number> {
    if (child.pid && child.pid > 0) {
      return child.pid
    }

    return new Promise<number>((resolve, reject) => {
      const onSpawn = () => {
        cleanup()
        resolve(child.pid ?? 0)
      }

      const onError = (error: Error) => {
        cleanup()
        reject(error)
      }

      const cleanup = () => {
        child.off('spawn', onSpawn)
        child.off('error', onError)
      }

      child.once('spawn', onSpawn)
      child.once('error', onError)
    })
  }

  private async portIsOpen(port: number): Promise<boolean> {
    return new Promise((resolve) => {
      const socket = net.createConnection({
        host: this.serverHost,
        port,
      })

      let settled = false

      const finish = (value: boolean) => {
        if (settled) return
        settled = true
        socket.destroy()
        resolve(value)
      }

      socket.setTimeout(this.portProbeTimeoutMs)
      socket.once('connect', () => finish(true))
      socket.once('timeout', () => finish(false))
      socket.once('error', () => finish(false))
    })
  }

  private async waitForPort(
    port: number,
    open: boolean,
    timeoutMs: number,
  ): Promise<boolean> {
    const deadline = Date.now() + timeoutMs

    while (Date.now() < deadline) {
      if ((await this.portIsOpen(port)) === open) {
        return true
      }

      await sleep(250)
    }

    return (await this.portIsOpen(port)) === open
  }

  private async closeControlServer(): Promise<void> {
    const server = this.controlServer

    if (!server) {
      return
    }

    if (server.listening) {
      await new Promise<void>((resolve) => {
        server.close(() => resolve())
      })
    }

    this.controlServer = undefined
  }
}

function validatePort(port: number, label: string): void {
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`Invalid ${label}: ${port}`)
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
