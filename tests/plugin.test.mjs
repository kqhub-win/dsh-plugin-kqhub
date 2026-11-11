import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { test } from 'node:test'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Tools from '@deepseek-ai/dsh-tools'
import * as nativeExecutor from '@deepseek-ai/dsh-tool-executor-native'
import { parse } from 'yaml'
import * as plugin from '../lib/index.js'
import * as guidance from '../lib/guidance.js'

test('bundle activates the published entry and exports its locale metadata', async () => {
  const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url)))
  const patch = parse(await readFile(new URL(`../${manifest.dsh.bundle.patch}`, import.meta.url), 'utf8'))
  const entries = patch[0].insert
  assert.ok(entries.some(entry => entry.id === 'kqhub' && entry.name === manifest.name))
  assert.ok(entries.some(entry => entry.id === 'kqhub-guidance' && entry.name === `${manifest.name}/guidance`))
  assert.equal(manifest.exports['./guidance'].default, './lib/guidance.js')
  assert.equal(manifest.engines.dsh, manifest.peerDependencies['@deepseek-ai/dsh-mcp-client'])
  for (const language of ['zh', 'en']) {
    const locale = JSON.parse(await readFile(new URL(`../locale/${language}.json`, import.meta.url)))
    assert.ok(locale.meta.title && locale.meta.description)
  }
})

test('rejects unsafe endpoints, unknown scopes and invalid timeouts before mounting', async () => {
  const ctx = { plugin() { assert.fail('invalid configuration must not start a process') } }
  for (const url of ['http://example.com/mcp', 'file:///mcp', 'https://user:secret@example.com/mcp',
    'https://example.com/mcp?token=secret', 'https://example.com/mcp#fragment', 'https://example.com/other']) {
    await assert.rejects(plugin.apply(ctx, plugin.Config({ url })), /MCP 地址/)
  }
  await assert.rejects(plugin.apply(ctx, plugin.Config({ scopes: [] })), /至少选择/)
  assert.throws(() => plugin.Config({ scopes: ['admin:write'] }))
  assert.throws(() => plugin.Config({ authTimeoutSeconds: 0 }))
  assert.throws(() => plugin.Config({ toolCallTimeoutMs: Infinity }))
  await assert.rejects(promisify(execFile)(process.execPath,
    [fileURLToPath(new URL('../lib/auth.js', import.meta.url)), 'http://example.com/mcp']),
    error => error.code === 1 && /MCP 地址/.test(error.stderr))
})

test('discovers, queries and unloads through the real DSH client and installed OAuth proxy', { timeout: 30000 }, async t => {
  const calls = []
  const server = createServer(async (req, res) => {
    if (req.method === 'GET') { res.writeHead(405).end(); return }
    let body = ''
    for await (const chunk of req) body += chunk
    const rpc = JSON.parse(body)
    calls.push(rpc)
    if (!('id' in rpc)) { res.writeHead(202).end(); return }
    let result
    switch (rpc.method) {
      case 'initialize':
        result = { protocolVersion: '2025-11-25', serverInfo: { name: 'local-kqhub', version: '1.0.0' },
          capabilities: { tools: {} }, instructions: 'pending 时使用原 query_handle 续取，不重复查询。' }
        break
      case 'tools/list':
        result = { tools: [{ name: 'get_mcp_usage', description: '查询用量',
          inputSchema: { type: 'object', properties: {} } }] }
        break
      case 'resources/list':
        result = { resources: [] }
        break
      case 'tools/call':
        result = rpc.params.arguments.fail
          ? { isError: true, content: [{ type: 'text', text: 'MCP_INSUFFICIENT_SCOPE' }] }
          : { content: [{ type: 'text', text: '{"status":"complete","data":{"used":7}}' }] }
        break
      default:
        res.writeHead(200, { 'content-type': 'application/json' })
          .end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, error: { code: -32601, message: 'Method not found' } }))
        return
    }
    res.writeHead(200, { 'content-type': 'application/json' })
      .end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result }))
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const ctx = new Context()
  t.after(async () => {
    await ctx.fiber.dispose()
    server.closeAllConnections()
    server.close()
  })
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(Tools)
  await ctx.plugin(nativeExecutor)
  const guidanceFiber = await ctx.plugin(guidance)
  const withoutConnection = await ctx.systemPrompt.assemble()
  assert.equal(withoutConnection.tools.length, 0)
  assert.ok(withoutConnection.sections.some(section => section.name === 'kqhub:query-guidance'),
    'query boundaries must exist even before MCP startup')
  const fiber = await ctx.plugin(plugin, { url: `http://127.0.0.1:${server.address().port}/mcp` })
  const definition = ctx.tools.get('mcp__kqhub__get_mcp_usage')
  assert.ok(definition, 'remote tools must be registered in the DSH namespace')
  const prompt = await ctx.systemPrompt.assemble()
  assert.match(JSON.stringify(prompt), /query_handle/)
  const execution = { signal: new AbortController().signal }
  const result = await definition.execute({}, execution)
  assert.equal(JSON.parse(result.content[0].text).data.used, 7)
  await assert.rejects(definition.execute({ fail: true }, execution), /MCP_INSUFFICIENT_SCOPE/)
  assert.equal(calls.filter(call => call.method === 'tools/call').length, 2)
  const auth = await promisify(execFile)(process.execPath,
    [fileURLToPath(new URL('../lib/auth.js', import.meta.url)),
      `http://127.0.0.1:${server.address().port}/mcp`], { timeout: 10000 })
  assert.match(auth.stderr, /Exiting OK/)
  assert.equal(calls.filter(call => call.method === 'tools/call').length, 2, 'authorization must not consume query quota')
  await fiber.dispose()
  assert.equal(ctx.tools.get('mcp__kqhub__get_mcp_usage'), undefined)
  const disconnected = await ctx.systemPrompt.assemble()
  assert.ok(disconnected.sections.some(section => section.name === 'kqhub:query-guidance'),
    'losing the connection must not remove the query boundaries')
  await guidanceFiber.dispose()
  const unloaded = await ctx.systemPrompt.assemble()
  assert.equal(unloaded.sections.some(section => section.name === 'kqhub:query-guidance'), false)
})

test('query guidance survives a failed connection plugin and carries actionable authorization boundaries', async t => {
  const ctx = new Context()
  t.after(() => ctx.fiber.dispose())
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(Tools)
  await ctx.plugin(nativeExecutor)
  await ctx.plugin(guidance)
  await assert.rejects(async () => { await ctx.plugin(plugin, { url: 'http://example.com/mcp' }) }, /MCP 地址/)
  const assembly = await ctx.systemPrompt.assemble()
  const section = assembly.sections.find(section => section.name === 'kqhub:query-guidance')
  assert.ok(section, 'startup failure must leave the independent guidance installed')
  assert.equal(section.interpolate, false)
  assert.match(section.text, /有可用工具和必要参数时直接调用/)
  assert.match(section.text, /不得执行旧探测脚本/)
  assert.match(section.text, /不得为查询读取或搜索配置文件/)
  assert.match(section.text, /401.*重新授权/)
  assert.match(section.text, /dsh plugin --profile web exec kqhub-auth/)
  assert.match(section.text, /当前缺少所需工具时停止查询/)
})
