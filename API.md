# API

This document covers the exports from the package entry point.

## Client

### `MinecraftTestClient`

Creates a client for the TCP control endpoint exposed by `MinecraftController`.

```ts
new MinecraftTestClient(options?)
```

`options` is a `MinecraftTestClientOptions` object.

Available options:

- `host` — control host. Defaults to `127.0.0.1`.
- `port` — control port. Defaults to `25575`.
- `timeoutMs` — request timeout. Defaults to `120000` ms.

#### `ping()`

Checks the controller state.

Returns:

- `'pong'` when Minecraft is running.
- `'starting'` while the controller is starting the server.

#### `waitForServer(timeoutMs?)`

Polls `ping()` until the controller reports a running server or the timeout expires.

The default timeout is the client's configured `timeoutMs`.

#### `restart()`

Requests a server restart.

Concurrent calls made through the same client share one promise. The controller also serializes restarts across separate clients.

#### `sendConsoleCommand(command)`

Sends a command to the running Paper console.

The command must not be empty.

#### `opPlayer(playerName)`

Grants a player operator status and waits for Paper to confirm the change.

Player names must contain 1–16 letters, numbers, or underscores. An already-operator response is treated as success.

#### `request(command, args?)`

Sends a raw control-protocol request and returns the `ControlResponse`.

This is the low-level client method used by the higher-level helpers.

### `createMinecraftTestClient(options?)`

Creates and returns a new `MinecraftTestClient`.

### `getDefaultClient()`

Returns the process-wide default `MinecraftTestClient`.

The default instance is configured from:

```text
TEST_CONTROL_HOST
TEST_CONTROL_PORT
TEST_CONTROL_TIMEOUT_MS
```

### `restartServer()`

Calls `restart()` on the default client.

### `sendConsoleCommand(command)`

Calls `sendConsoleCommand()` on the default client.

### `opPlayer(playerName)`

Calls `opPlayer()` on the default client.

### `pingServer()`

Calls `ping()` on the default client.

### `waitForServer(timeoutMs?)`

Calls `waitForServer()` on the default client.

### `MinecraftTestClientOptions`

Configuration for `MinecraftTestClient`.

```ts
interface MinecraftTestClientOptions {
  host?: string
  port?: number
  timeoutMs?: number
}
```

## Controller

### `MinecraftController`

Owns one Paper JVM and one control TCP endpoint.

```ts
new MinecraftController(options)
```

`serverDirectory` is required. Other options control the Java command, Paper arguments, control endpoint, Minecraft endpoint, startup/shutdown timeouts, and the readiness pattern.

Available options:

- `serverDirectory` — Paper server directory. Required.
- `paperJar` — Paper JAR path. Defaults to `paper.jar` inside `serverDirectory`.
- `javaCommand` — Java executable. Defaults to `java`.
- `javaArgs` — JVM arguments. Defaults to `-Xms1G -Xmx3G`.
- `paperArgs` — Paper arguments. Defaults to `--nogui`.
- `controlHost` — control endpoint host. Defaults to `127.0.0.1`.
- `controlPort` — control endpoint port. Defaults to `25575`.
- `serverHost` — host used for Minecraft port checks. Defaults to `127.0.0.1`.
- `serverPort` — Minecraft port. Defaults to `25565`.
- `startTimeoutMs` — maximum startup wait. Defaults to `120000` ms.
- `gracefulStopTimeoutMs` — wait for a normal stop before forced termination. Defaults to `15000` ms.
- `forceStopTimeoutMs` — wait after a termination signal before the next step. Defaults to `5000` ms.
- `portProbeTimeoutMs` — timeout for an individual port probe. Defaults to `750` ms.
- `portWaitTimeoutMs` — maximum time to wait for the Minecraft port to reach the expected state. Defaults to `15000` ms.
- `opTimeoutMs` — maximum time to wait for operator confirmation. Defaults to `15000` ms.
- `readyPattern` — regular expression used to detect the server-ready message. Defaults to the standard Paper `Done (...)! For help, type "help"` message.

#### `state`

Returns the current lifecycle state:

```text
stopped
starting
running
stopping
```

#### `isListening`

Returns `true` when the control TCP server is listening.

#### `start()`

Starts the control server if needed and starts Minecraft when it is not already running.

#### `restart()`

Stops the current Minecraft process, waits for its port to close, and starts a replacement.

Concurrent restart calls share the same lifecycle promise.

#### `sendConsoleCommand(command)`

Sends a command to the running Minecraft console.

#### `opPlayer(playerName)`

Sends the `op` command and waits for matching console output confirming the player is an operator.

#### `stop()`

Stops the controller, closes the control endpoint, and stops the Minecraft process if one is running.

Concurrent calls share the same shutdown promise.

### `MinecraftControllerOptions`

Configuration for `MinecraftController`.

## Protocol

### `PROTOCOL_VERSION`

Current control-protocol version. The value is `1`.

### `encodeRequest(command, args?)`

Builds one newline-delimited JSON control request.

### `decodeRequest(line)`

Parses a control request from one line.

JSON is the canonical format. Plain-text commands are also accepted for manual debugging.

### `encodeSuccess(message?)`

Builds a successful newline-delimited JSON control response.

### `encodeError(message)`

Builds an unsuccessful newline-delimited JSON control response.

### `ControlRequest`

The decoded request shape:

```ts
interface ControlRequest {
  version: 1
  command: string
  args: readonly string[]
}
```

### `ControlResponse`

The response shape:

```ts
interface ControlResponse {
  version: 1
  ok: boolean
  message?: string
}
```

## CLI

The package also publishes the `minecraft-test-controller` executable.

See `minecraft-test-controller --help` for the supported command-line options.
