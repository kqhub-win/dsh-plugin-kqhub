import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import * as mcpClient from '@deepseek-ai/dsh-mcp-client'

export const name = 'kqhub'
export const inject = ['tools']

const scopes = ['players:read', 'career:read', 'matches:read', 'bindings:read', 'usage:read', 'offline_access'] as const

export interface Config {
  url: string
  scopes: (typeof scopes)[number][]
  authTimeoutSeconds: number
  toolCallTimeoutMs: number
}

export const Config = Schema.object({
  url: Schema.string().default('https://kqhub.win/mcp').description('卡丘HUB MCP 地址。'),
  scopes: Schema.array(Schema.union(scopes.map(scope => Schema.const(scope))))
    .default([...scopes]).description('请求的只读权限；offline_access 用于续期授权。'),
  authTimeoutSeconds: Schema.number().step(1).min(30).max(600).default(180)
    .description('首次浏览器授权等待时间，单位秒。'),
  toolCallTimeoutMs: Schema.number().step(1).min(1000).max(120000).default(60000)
    .description('单次工具调用超时，单位毫秒。'),
})

export function createConnectionConfig(config: Config) {
  const url = new URL(config.url)
  const loopback = ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname)
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback))
    || url.username || url.password || url.search || url.hash || url.pathname !== '/mcp') {
    throw new Error('MCP 地址必须为 HTTPS /mcp；本地回环地址可使用 HTTP，不能包含凭据、查询参数或片段。')
  }
  if (config.scopes.length === 0) throw new Error('至少选择一项 MCP 权限。')

  // Resolve the installed binary directly: no shell, npx download, or PATH dependency.
  const proxy = fileURLToPath(import.meta.resolve('mcp-remote/dist/proxy.js'))
  const args = [proxy, url.href, '--transport', 'http-only', '--auth-timeout', String(config.authTimeoutSeconds),
    '--static-oauth-client-metadata', JSON.stringify({
      client_name: '卡丘HUB 官方 DSH 插件',
      token_endpoint_auth_method: 'none',
      scope: config.scopes.join(' '),
    })]
  if (url.protocol === 'http:') args.push('--allow-http')
  args.push('--silent')

  return {
    transport: 'stdio' as const,
    serverName: 'kqhub',
    command: process.execPath,
    args,
    toolCallTimeoutMs: config.toolCallTimeoutMs,
    failOnStartupError: true,
  }
}

export async function apply(ctx: Context, config: Config): Promise<void> {
  await ctx.plugin(mcpClient, createConnectionConfig(config))
}
