#!/usr/bin/env node

import path from 'node:path'
import {
  MinecraftController,
  type MinecraftControllerOptions,
} from './controller.js'

interface CliOptions {
  serverDirectory: string
  paperJar?: string
  javaCommand?: string
  javaArgs: string[]
  paperArgs: string[]
  controlHost?: string
  controlPort?: number
  serverHost?: string
  serverPort?: number
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2))
  const controller = new MinecraftController(
    optionsToControllerOptions(options),
  )

  let exitPromise: Promise<void> | undefined

  const exit = (code: number): Promise<void> => {
    if (exitPromise) {
      return exitPromise
    }

    exitPromise = (async () => {
      try {
        await controller.stop()
      } catch (error) {
        console.error(
          `Failed to stop Minecraft controller: ${formatError(error)}`,
        )
        code = 1
      }

      process.exit(code)
    })()

    return exitPromise
  }

  process.once('SIGINT', () => {
    void exit(130)
  })

  process.once('SIGTERM', () => {
    void exit(143)
  })

  process.once('SIGHUP', () => {
    void exit(129)
  })

  try {
    await controller.start()
    console.log('Minecraft test controller is ready.')
  } catch (error) {
    try {
      await controller.stop()
    } catch (stopError) {
      console.error(
        `Minecraft controller cleanup failed: ${formatError(stopError)}`,
      )
    }

    throw error
  }
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    serverDirectory: '',
    javaArgs: ['-Xms1G', '-Xmx3G'],
    paperArgs: ['--nogui'],
  }

  const takeValue = (index: number, name: string): [string, number] => {
    const argument = argv[index]

    if (argument === undefined) {
      throw new Error(`Missing value for ${name}.`)
    }

    return [argument, index + 1]
  }

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]

    switch (argument) {
      case '--server-dir': {
        const [value, next] = takeValue(index + 1, argument)
        options.serverDirectory = path.resolve(value)
        index = next - 1
        break
      }

      case '--paper-jar': {
        const [value, next] = takeValue(index + 1, argument)
        options.paperJar = value
        index = next - 1
        break
      }

      case '--java': {
        const [value, next] = takeValue(index + 1, argument)
        options.javaCommand = value
        index = next - 1
        break
      }

      case '--java-arg': {
        const [value, next] = takeValue(index + 1, argument)
        options.javaArgs.push(value)
        index = next - 1
        break
      }

      case '--paper-arg': {
        const [value, next] = takeValue(index + 1, argument)
        options.paperArgs.push(value)
        index = next - 1
        break
      }

      case '--control-host': {
        const [value, next] = takeValue(index + 1, argument)
        options.controlHost = value
        index = next - 1
        break
      }

      case '--control-port': {
        const [value, next] = takeValue(index + 1, argument)
        options.controlPort = parsePort(value, argument)
        index = next - 1
        break
      }

      case '--server-host': {
        const [value, next] = takeValue(index + 1, argument)
        options.serverHost = value
        index = next - 1
        break
      }

      case '--server-port': {
        const [value, next] = takeValue(index + 1, argument)
        options.serverPort = parsePort(value, argument)
        index = next - 1
        break
      }

      case '--help':
      case '-h':
        printHelp()
        process.exit(0)

      default:
        throw new Error(`Unknown argument: ${argument}`)
    }
  }

  if (!options.serverDirectory) {
    throw new Error(
      'Missing required --server-dir. The controller never assumes a working directory.',
    )
  }

  return options
}

function optionsToControllerOptions(
  options: CliOptions,
): MinecraftControllerOptions {
  return {
    serverDirectory: options.serverDirectory,
    ...(options.paperJar !== undefined
      ? { paperJar: options.paperJar }
      : {}),
    ...(options.javaCommand !== undefined
      ? { javaCommand: options.javaCommand }
      : {}),
    javaArgs: options.javaArgs,
    paperArgs: options.paperArgs,
    ...(options.controlHost !== undefined
      ? { controlHost: options.controlHost }
      : {}),
    ...(options.controlPort !== undefined
      ? { controlPort: options.controlPort }
      : {}),
    ...(options.serverHost !== undefined
      ? { serverHost: options.serverHost }
      : {}),
    ...(options.serverPort !== undefined
      ? { serverPort: options.serverPort }
      : {}),
  }
}

function parsePort(value: string, argument: string): number {
  const port = Number(value)

  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`Invalid port for ${argument}: ${value}`)
  }

  return port
}

function printHelp(): void {
  console.log(`Minecraft integration test controller

Required:
  --server-dir <path>       Paper server directory

Optional:
  --paper-jar <path>        Paper JAR path, relative to server dir when relative
  --java <command>          Java executable (default: java)
  --java-arg <arg>          Additional JVM argument; repeatable
  --paper-arg <arg>         Additional Paper argument; repeatable
  --control-host <host>     Control host (default: 127.0.0.1)
  --control-port <port>     Control port (default: 25575)
  --server-host <host>      Minecraft host used for port checks (default: 127.0.0.1)
  --server-port <port>      Minecraft port (default: 25565)
  -h, --help                Show this help

The controller keeps all runtime lifecycle state in memory and writes no
PID, lock, or log files.`)
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

void main().catch((error) => {
  console.error(`Minecraft test controller failed: ${formatError(error)}`)
  process.exit(1)
})
