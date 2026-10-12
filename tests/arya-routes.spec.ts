/** Arya release requests through real HTTP parsing and profile files. */
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { mountMarketRoutes } from '../src/routes.ts'
import type { PluginCommandRuntime } from '../src/dsh-cli.ts'
import { stageAryaRelease } from '../src/arya.ts'
import { forgetCatalog } from '../src/registry.ts'

const versions = ['0.2.0', '0.1.0']
const target = (version: string) => `https://github.com/KonnectSuite/dsh-market/releases/download/plugin-dsh-example-v${version}/dsh-example-${version}.tgz`
vi.mock('../src/registry.ts', async importOriginal => {
  const original = await importOriginal<typeof import('../src/registry.ts')>()
  return { ...original, loadRegistry: async (_region?: unknown, catalogUrl?: string) => catalogUrl === undefined ? ({ updated: '', count: 1, categories: { tools: { en: 'Tools' } }, plugins: [{ name: 'community-example', owner: 'Community', url: 'https://github.com/example/community-example', category: 'tools', description: {}, install: 'npm:community-example', npm: 'community-example', added: '' }] }) : ({ updated: '', count: 1, categories: {}, plugins: [{ name: 'dsh-example', owner: 'KonnectSuite', url: 'https://github.com/KonnectSuite/dsh-example', arya: true, category: 'arya', description: {}, install: '', added: '', releases: versions.map(version => ({ version, sha256: '0'.repeat(64), tarball: target(version) })) }] }) }
})
vi.mock('../src/arya.ts', async importOriginal => {
  const original = await importOriginal<typeof import('../src/arya.ts')>()
  return { ...original, stageAryaRelease: vi.fn(async (_plugin: unknown, version: string) => target(version)) }
})
let directory: string
let server: Server
let base: string
let dispose: () => void | Promise<void>
const runPlugin = vi.fn<PluginCommandRuntime['runPlugin']>(async () => ({ exitCode: 1, stdout: '', stderr: 'fixture install refused', timedOut: false, cancelled: false }))
beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), 'arya-market-routes-'))
  const profile = join(directory, 'profile'); mkdirSync(profile)
  writeFileSync(join(profile, 'package.json'), JSON.stringify({ dependencies: { 'dsh-example': 'file:./checkout' }, dsh: { profile: { bundles: ['dsh-example'] } } }))
  const bundled = join(directory, 'node_modules', 'dsh-example'); mkdirSync(bundled, { recursive: true })
  writeFileSync(join(bundled, 'package.json'), JSON.stringify({ name: 'dsh-example', version: '0.1.0' }))
  const routes = new Map<string, (request: IncomingMessage, response: ServerResponse) => void | Promise<void>>()
  dispose = mountMarketRoutes({ webServer: { register(route) { routes.set(route.path, route.handler); return () => { routes.delete(route.path) } } }, loader: { entries: () => [] }, plugin: () => ({ await: async () => undefined, dispose: () => {} }) },
    { profile: 'web', profileDirectory: profile, dshInstallDir: directory, catalogUrl: 'https://example.com/arya.json' },
    { runPlugin, probePnpm: async () => true, provisionPnpm: async () => ({ ok: true }), cancelActive: () => false, acceptsMarketPnpmFlags: false })
  server = createServer((request, response) => { const handler = routes.get(new URL(request.url ?? '/', 'http://localhost').pathname); if (handler) void handler(request, response); else { response.writeHead(404); response.end() } })
  await new Promise<void>(resolve => { server.listen(0, '127.0.0.1', resolve) })
  const address = server.address(); if (address === null || typeof address === 'string') throw new Error('No fixture address')
  base = `http://127.0.0.1:${address.port}`
})
afterEach(async () => {
  await dispose?.()
  if (server) await new Promise<void>((resolve, reject) => { server.close(error => error ? reject(error) : resolve()); server.closeAllConnections() })
  rmSync(directory, { recursive: true, force: true }); runPlugin.mockClear(); forgetCatalog()
})
const post = (body: unknown, origin = base) => fetch(`${base}/dsh-market/update`, { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify(body) })

it('lists released versions and the installer-owned restoration version', async () => {
  const response = await fetch(`${base}/dsh-market/arya-versions?name=dsh-example`)
  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({ name: 'dsh-example', releases: [{ version: '0.2.0' }, { version: '0.1.0' }], bundled: '0.1.0' })
})
it('rejects unknown packages and unlisted versions before running an installer', async () => {
  expect((await fetch(`${base}/dsh-market/arya-versions?name=missing`)).status).toBe(404)
  expect((await post({ name: 'dsh-example', releaseVersion: 'main' })).status).toBe(400)
  expect(runPlugin).not.toHaveBeenCalled()
})
it('keeps an ordinary update from replacing a local checkout', async () => {
  expect((await post({ name: 'dsh-example' })).status).toBe(400)
  expect(runPlugin).not.toHaveBeenCalled()
})
it.each([{ releaseVersion: '0.1.0' }, { bundled: true }])('sends the exact chosen archive to the existing installer: %j', async choice => {
  const response = await post({ name: 'dsh-example', ...choice })
  expect(runPlugin).toHaveBeenCalledWith('web', ['add', target('0.1.0')])
  expect(response.ok).toBe(false)
  expect(JSON.parse(readFileSync(join(directory, 'profile', 'package.json'), 'utf8')).dependencies['dsh-example']).toBe('file:./checkout')
})
it('rejects a cross-origin release change', async () => {
  expect((await post({ name: 'dsh-example', releaseVersion: '0.1.0' }, 'https://untrusted.example')).status).toBe(403)
  expect(runPlugin).not.toHaveBeenCalled()
})

it('cancels release preparation before any package command starts', async () => {
  let started!: () => void
  const ready = new Promise<void>(resolve => { started = resolve })
  vi.mocked(stageAryaRelease).mockImplementationOnce(async (_plugin, _version, _directory, _limits, signal) => new Promise<string>((_resolve, reject) => {
    signal!.addEventListener('abort', () => reject(signal!.reason), { once: true })
    started()
  }))
  const updating = post({ name: 'dsh-example', releaseVersion: '0.1.0' })
  await ready
  const cancelled = await fetch(`${base}/dsh-market/cancel`, { method: 'POST', headers: { origin: base, 'content-type': 'application/json' }, body: '{}' })
  expect(cancelled.status).toBe(200)
  expect(await (await updating).json()).toMatchObject({ ok: false, cancelled: true })
  expect(runPlugin).not.toHaveBeenCalled()
})

it('lists community plugins alongside Arya releases without granting release controls', async () => {
  const response = await fetch(`${base}/dsh-market/registry`)
  expect(response.status).toBe(200)
  const body = await response.json()
  expect(body.registry.count).toBe(2)
  expect(body.registry.plugins.map((p: { name: string }) => p.name)).toEqual(['community-example', 'dsh-example'])
  expect((await fetch(`${base}/dsh-market/arya-versions?name=community-example`)).status).toBe(404)
})
