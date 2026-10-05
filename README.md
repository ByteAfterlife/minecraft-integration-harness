# Minecraft Integration Harness

Reusable infrastructure for running a Minecraft/Paper server during automated integration tests. It does not require the server to actually be Paper, but Paper is the primary target.

The package has two parts:

- `minecraft-test-controller` starts and owns one Paper JVM, exposes the TCP control endpoint, handles restarts, and shuts the server down.
- `MinecraftTestClient` is the test-side API for restarting the server, granting operator status, sending console commands, and checking readiness.

## Usage

Install the package from GitHub Packages, then use the client helpers from your integration tests:

```ts
import {
  opPlayer,
  restartServer,
  sendConsoleCommand,
  waitForServer,
} from '@byteafterlife/minecraft-integration-harness'

await waitForServer()
await restartServer()
await opPlayer('PlzOp')
await sendConsoleCommand('time set day')
```

The default client reads these environment variables:

```text
TEST_CONTROL_HOST=127.0.0.1
TEST_CONTROL_PORT=25575
TEST_CONTROL_TIMEOUT_MS=120000
```

For explicit configuration:

```ts
import { createMinecraftTestClient } from '@byteafterlife/minecraft-integration-harness'

const minecraft = createMinecraftTestClient({
  host: '127.0.0.1',
  port: 25575,
  timeoutMs: 120_000,
})

await minecraft.restart()
await minecraft.opPlayer('PlzOp')
```

See [API.md](API.md) for the exported classes and functions.

## Controller

The controller is independent of the calling repository, build system, Minecraft world layout, and current working directory. Give it the server directory explicitly:

```bash
minecraft-test-controller --server-dir /path/to/test-server
```

A typical invocation looks like this:

```bash
minecraft-test-controller \
  --server-dir /absolute/path/to/.ed-minecraft-dev \
  --server-port 25565 \
  --control-host 127.0.0.1 \
  --control-port 25575 \
  --server-host 127.0.0.1
```

Java and Paper arguments can be repeated:

```bash
minecraft-test-controller \
  --server-dir /absolute/path/to/server \
  --java java \
  --java-arg -Xms1G \
  --java-arg -Xmx3G \
  --paper-arg --nogui
```

The controller does not write PID files, lock files, or log files. Runtime ownership and lifecycle state live in memory.

The default control endpoint is loopback-only. Do not expose it on an untrusted network because it can issue arbitrary Paper console commands.

The control port is the controller's process-ownership boundary. It is bound before Paper starts, so another controller cannot race it into starting a second Paper JVM.

Server-affecting operations are serialized. Concurrent `restart` requests share one lifecycle operation. A replacement Paper JVM is not started until the previous JVM has exited and the Minecraft port is closed.

## Control protocol

The canonical wire protocol is one JSON request per line and one JSON response per line.

Supported commands:

```text
ping
restart
console <command>
op <player>
```

Plain-text commands are also accepted for manual debugging:

```text
op PlzOp
restart
console say hello
```

The client library uses JSON internally, so command arguments do not depend on shell quoting.

## `opPlayer()`

`opPlayer('PlzOp')` sends `op PlzOp` to the Paper console and waits for Paper output confirming that the player became an operator. A response saying the player is already an operator is also treated as success, so repeated calls are safe.

## Development

```bash
npm install
npm run check
npm test
npm run build
npm run pack:check
```

The published package contains `dist`, `README.md`, and `LICENSE`.
