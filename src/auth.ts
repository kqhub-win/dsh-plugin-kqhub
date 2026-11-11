#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { fileURLToPath } from 'node:url'
import { Config, createConnectionConfig } from './index.js'

try {
  const config = createConnectionConfig(Config({ url: process.argv[2] }))
  const client = fileURLToPath(import.meta.resolve('mcp-remote/dist/client.js'))
  const args = config.args.slice(1).filter(arg => arg !== '--silent')
  const child = spawn(config.command, [client, ...args], { stdio: 'inherit', shell: false })
  const [code] = await once(child, 'exit')
  process.exitCode = code ?? 1
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
}
