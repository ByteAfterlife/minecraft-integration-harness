export const PROTOCOL_VERSION = 1

export interface ControlRequest {
  version: typeof PROTOCOL_VERSION
  command: string
  args: readonly string[]
}

export interface ControlResponse {
  version: typeof PROTOCOL_VERSION
  ok: boolean
  message?: string
}

export function encodeRequest(
  command: string,
  args: readonly string[] = [],
): string {
  return JSON.stringify({
    version: PROTOCOL_VERSION,
    command,
    args,
  } satisfies ControlRequest) + '\n'
}

export function encodeSuccess(message?: string): string {
  const response: ControlResponse = {
    version: PROTOCOL_VERSION,
    ok: true,
  }

  if (message !== undefined) {
    response.message = message
  }

  return JSON.stringify(response) + '\n'
}

export function encodeError(message: string): string {
  return JSON.stringify({
    version: PROTOCOL_VERSION,
    ok: false,
    message,
  } satisfies ControlResponse) + '\n'
}

export function decodeRequest(line: string): ControlRequest {
  const trimmed = line.trim()

  if (!trimmed) {
    throw new Error('Empty control request.')
  }

  if (trimmed.startsWith('{')) {
    let parsed: unknown

    try {
      parsed = JSON.parse(trimmed)
    } catch (error) {
      throw new Error(`Invalid JSON control request: ${String(error)}`)
    }

    if (!isRecord(parsed)) {
      throw new Error('Control request must be a JSON object.')
    }

    const version = parsed.version
    const command = parsed.command
    const args = parsed.args

    if (version !== PROTOCOL_VERSION) {
      throw new Error(`Unsupported control protocol version: ${String(version)}`)
    }

    if (typeof command !== 'string' || command.length === 0) {
      throw new Error('Control request command must be a non-empty string.')
    }

    if (
      !Array.isArray(args) ||
      args.some((value) => typeof value !== 'string')
    ) {
      throw new Error('Control request args must be an array of strings.')
    }

    return {
      version: PROTOCOL_VERSION,
      command,
      args,
    }
  }

  const parts = parseTextCommand(trimmed)
  const [command, ...args] = parts

  if (!command) {
    throw new Error('Empty control command.')
  }

  return {
    version: PROTOCOL_VERSION,
    command,
    args,
  }
}

function parseTextCommand(input: string): string[] {
  const result: string[] = []
  let current = ''
  let quote: '"' | "'" | undefined
  let escaped = false

  for (const char of input) {
    if (escaped) {
      current += char
      escaped = false
      continue
    }

    if (char === '\\') {
      escaped = true
      continue
    }

    if (quote !== undefined) {
      if (char === quote) {
        quote = undefined
      } else {
        current += char
      }

      continue
    }

    if (char === '"' || char === "'") {
      quote = char
      continue
    }

    if (/\s/.test(char)) {
      if (current.length > 0) {
        result.push(current)
        current = ''
      }

      continue
    }

    current += char
  }

  if (escaped) {
    throw new Error('Control command ends with an incomplete escape.')
  }

  if (quote !== undefined) {
    throw new Error('Control command contains an unterminated quote.')
  }

  if (current.length > 0) {
    result.push(current)
  }

  return result
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}
