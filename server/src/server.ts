import express from 'express'
import bodyParser from 'body-parser'
import basicAuth from 'express-basic-auth'
import cors from 'cors'
import requestIp from 'request-ip'

import chalk from 'chalk'

import http from 'http'
import net from 'net'
import path from 'path'
import socketio from 'socket.io'
import InputRegistry from './inputs'
import { MessageHandlers, ServerConfig } from './types'


// File path to UI app build artifacts (static JS/CSS/HTML)
const UI_BUILD_PATH = process.env.LOGIO_SERVER_UI_BUILD_PATH
  || path.resolve(__dirname, 'ui')

/**
 * Broadcast an inbound message to socket.io channels
 */
async function handleNewMessage(
  config: ServerConfig,
  inputs: InputRegistry,
  io: SocketIO.Server,
  msgParts: Array<string>,
): Promise<void> {
  const [mtype, stream, source] = msgParts.slice(0, 3)
  const msg = msgParts.slice(3).join('|')
  const inputName = inputs.add(stream, source)
  // Broadcast message to input channel
  io.to(inputName).emit(mtype, {
    inputName,
    msg,
    stream,
    source,
  })
  // Broadcast ping to all browsers
  io.emit('+ping', { inputName, stream, source })
  if (config.debug) {
    // eslint-disable-next-line no-console
    console.log(msgParts.join('|'))
  }
}

/**
 * Broadcast a new input coming online to all browsers
 */
async function handleRegisterInput(
  config: ServerConfig,
  inputs: InputRegistry,
  io: SocketIO.Server,
  msgParts: Array<string>,
): Promise<void> {
  const [mtype, stream, source] = msgParts.slice(0, 3)
  const inputName = inputs.add(stream, source)
  io.emit(mtype, { stream, source, inputName })
}

/**
 * Broadcast an input going offline to all browsers
 */
async function handleDeregisterInput(
  config: ServerConfig,
  inputs: InputRegistry,
  io: SocketIO.Server,
  msgParts: Array<string>,
): Promise<void> {
  const [mtype, stream, source] = msgParts.slice(0, 3)
  const inputName = inputs.remove(stream, source)
  io.emit(mtype, { stream, source, inputName })
}

// Maps TCP message prefix to handler function
const messageHandlers: MessageHandlers = {
  '+msg': handleNewMessage,
  '+input': handleRegisterInput,
  '-input': handleDeregisterInput,
}

/**
 * Broadcast an inbound message to socket.io channels
 */
async function broadcastMessage(
  config: ServerConfig,
  inputs: InputRegistry,
  io: SocketIO.Server,
  data: Buffer,
): Promise<void> {
  // Parse raw message into parts
  // NOTE: After split on null termination character, last item will always
  // be either an empty string or a partial/incomplete message
  const msgs = data.toString()
    .split('\0')
    .slice(0, -1)
    .filter((msg) => !!msg.trim())
  msgs.forEach(async (msg) => {
    const msgParts = msg.split('|')
    const messageHandler = messageHandlers[msgParts[0]]
    if (messageHandler) {
      await messageHandler(config, inputs, io, msgParts)
    } else {
      // eslint-disable-next-line no-console
      console.error(`Unknown message type: ${msgParts[0]}`)
    }
  })
}

/**
 * Start message & web servers
 */
async function main(config: ServerConfig): Promise<void> {

  console.log('start...')

  // Create HTTP server w/ static file serving, socket.io bindings & basic auth
  const server = express()


  server.use(bodyParser.urlencoded({ extended: true, limit: '15mb' }));
  server.use(bodyParser.json({ limit: '15mb' }));

  server.use(cors())
  server.use(requestIp.mw())

  server.post('/logger', async (req, res) => {

    let logs = req.body.logs ? req.body.logs : []

    const ip = req.clientIp;

    for (let log of logs) {

      console.log(log)

      let logstashMsg = {

        level: log.level,
        count: log.count,
        mobile: log.mobile,
        child: log.logger,
        '@timestamp': new Date().toISOString(),
        'application': 'driver-office',
        'tags': ['logio'],
        'message': log.msg,
        'ts': log.ts,
        'stacktrace': log.stacktrace
      }

      pushToLogstash(logstashMsg)

      let bufStr = `+msg|${(log.mobile?log.mobile.replace('+','')+'_':'')+ip}|${log.logger ? log.logger : '_'}|${log.count} [ ${log.level}  ]  - ${chalk.white(log.msg)}\0`

      await broadcastMessage(config, inputs, io, Buffer.from(bufStr, 'utf8'))

      if (log.stacktrace) {
        bufStr = `+msg|${(log.mobile?log.mobile.replace('+','')+'_':'')+ip}|${log.logger ? log.logger : '_'}|${log.stacktrace}\0`
        await broadcastMessage(config, inputs, io, Buffer.from(bufStr, 'utf8'))
      }
    }

    res.end();
  });

  let logstashConnection: any = {
    socket: null,
    isConnected: false,
    lastCreateConnectionDate: null,
    createConnectionInProgress: false,
    waitAfterError: 1,
    buffer: []
  }

  function pushToLogstash(message: any) {

    logstashConnection.buffer.push(message)
    sendBufferToLogstash()


  }

  function sendBufferToLogstash() {
    if (logstashConnection.isConnected === true) {
      if (logstashConnection.buffer.length > 0) {

        try {
          let msg = logstashConnection.buffer.shift()
          if (config.debug) {
            console.log('emit tcp packet', msg)
          }
          logstashConnection.socket.write(JSON.stringify(msg) + '\n');
        } catch (error) {
          console.log('logstash :fail to write', error)
        }
      }

      if (logstashConnection.buffer.length > 0) {
        sendBufferToLogstash()
      }
    }
    else {
      connectToLogstash()
    }
  }

  function connectToLogstash() {
    const logHost: any = process.env.LOGSTASH_URL ?  process.env.LOGSTASH_URL : config.logstash.host
      , logPort = 9998

    console.log('Try to connect to logstash')

    if (logstashConnection.lastCreateConnectionDate) {
      let now = new Date()
      var seconds = (now.getTime() - logstashConnection.lastCreateConnectionDate.getTime()) / 1000

      if (seconds > 30) {
        console.log('Retry logstash connection')
        logstashConnection.createConnectionInProgress = false
      }
    }

    if (logstashConnection.createConnectionInProgress === false) {

      logstashConnection.createConnectionInProgress = true

      logstashConnection.socket = net.createConnection({ host: logHost, port: logPort }, function () {

        console.log('Connect to logstash : done')

        var message = {
          '@timestamp': new Date().toISOString(),
          'tags': ['logio'],
          'message': 'LOGIO : new logstash connection'
        }


        logstashConnection.createConnectionInProgress = false
        logstashConnection.isConnected = true
        logstashConnection.lastCreateConnectionDate = new Date()
        logstashConnection.waitAfterError = 1

        pushToLogstash(message)

      })

      function restartLogstashConnection() {

        logstashConnection.createConnectionInProgress = false
        logstashConnection.isConnected = false

        setTimeout(() => {

          logstashConnection.waitAfterError = logstashConnection.waitAfterError * 3

          console.log(`next retry in ${logstashConnection.waitAfterError} ms`)

          if (logstashConnection.waitAfterError > 300000) {
            logstashConnection.waitAfterError = 300000
          }

          connectToLogstash()
        }, logstashConnection.waitAfterError)
      }

      logstashConnection.socket.on('close', function () {
        restartLogstashConnection()
      }
      )

      logstashConnection.socket.on('error', function (err: any) {

        console.log(err)
        restartLogstashConnection()
      });
    }
  }

  connectToLogstash()

  const httpServer = new http.Server(server)
  const io = socketio(httpServer)
  const inputs = new InputRegistry()
  if (config.basicAuth) {
    if (config.basicAuth.users && config.basicAuth.realm) {
      server.use(basicAuth({
        ...config.basicAuth,
        challenge: true,
      }))
    } else {
      // eslint-disable-next-line no-console
      console.warn(`
WARNING: Unable to enable basic authentication.

Basic auth configuration requires the following keys: 'users', 'realm'.

See README for more examples.
      `)
    }
  }
  server.use('/', express.static(UI_BUILD_PATH))

  // Create TCP message server
  const messageServer = net.createServer(async (socket: net.Socket) => {
    socket.on('data', async (data: Buffer) => {

      console.log('data=', data.toString())

      await broadcastMessage(config, inputs, io, data)
    })
  })

  // When a new browser connects, register stream activation events
  io.on('connection', async (socket: SocketIO.Socket) => {
    // Send existing inputs to browser
    inputs.getInputs().forEach((input) => {
      socket.emit('+input', input)
    })
    // Register input activation events
    socket.on('+activate', (inputName) => {
      socket.join(inputName)
    })
    socket.on('-activate', (inputName) => {
      socket.leave(inputName)
    })
  })

  // Start listening for requests
  messageServer.listen(config.messageServer.port, config.messageServer.host, () => {
    // eslint-disable-next-line no-console
    console.log(`TCP message server listening on port ${config.messageServer.port}`)
  })
  httpServer.listen(config.httpServer.port, config.httpServer.host, () => {
    // eslint-disable-next-line no-console
    console.log(`HTTP server listening on port ${config.httpServer.port}`)
  })
}

export default main
