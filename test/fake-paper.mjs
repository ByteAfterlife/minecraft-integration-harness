import net from 'node:net'
import readline from 'node:readline'

const portIndex = process.argv.indexOf('--port')
const port = Number(process.argv[portIndex + 1])

if (!Number.isInteger(port) || port < 1) {
  process.stderr.write('missing --port\n')
  process.exit(2)
}

let operator = false

const server = net.createServer((socket) => {
  socket.destroy()
})

server.listen(port, '127.0.0.1', () => {
  console.log('Done (0.42s)! For help, type "help"')
})

const input = readline.createInterface({
  input: process.stdin,
})

input.on('line', (line) => {
  const command = line.trim()

  if (command === 'stop') {
    input.close()
    server.close(() => process.exit(0))
    return
  }

  const match = /^op ([A-Za-z0-9_]{1,16})$/.exec(command)

  if (match) {
    const player = match[1]

    if (operator) {
      console.log(`${player} is already an operator`)
    } else {
      operator = true
      console.log(`Made ${player} a server operator`)
    }
  }
})
