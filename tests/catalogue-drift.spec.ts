/**
 * The Arya catalog is both the offer and the bytes for every package it
 * lists. Recording a release on npm and not in the catalog therefore used to
 * HIDE it: `latest` came from `releases[0]`, so a package whose npm `latest`
 * is newer than its catalog entry answered "up to date" — forever, on every
 * machine, with no warning anywhere.
 *
 * These specs pin the three answers that fix distinguishes:
 *
 *   catalog behind npm, registry install   → the npm release is offered, and
 *                                            the update installs it
 *   catalog behind npm, catalog archive    → still the catalog answer (this
 *                                            route cannot swap a staged
 *                                            archive for a registry install),
 *                                            but the drift is named
 *   catalog agrees with npm               → the catalog answer, unchanged
 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { mountMarketRoutes } from '../src/routes.ts'
import type { PluginCommandRuntime } from '../src/dsh-cli.ts'
import { forgetCatalog } from '../src/registry.ts'

const FIRST = '@aryacode/dsh-example'
const THIRD = 'example-tool'

/** Read at call time, so one fixture serves every case. */
let activeName = FIRST
let catalogVersions: string[] = ['0.2.0', '0.1.0']
let npmLatest: string | null = '0.3.0'
let installedSpec = '0.1.0'

const tarballOf = (name: string, version: string) =>
  `https://registry.npmjs.org/${name}/-/${name.slice(name.lastIndexOf('/') + 1)}-${version}.tgz`

vi.mock('../src/registry.ts', async importOriginal => {
  const original = await importOriginal<typeof import('../src/registry.ts')>()
  return {
    ...original,
    loadRegistry: async () => ({
      updated: '',
      count: 1,
      categories: {},
      plugins: [{
        name: activeName,
        owner: 'KonnectSuite',
        url: `https://github.com/KonnectSuite/${activeName.slice(activeName.lastIndexOf('/') + 1)}`,
        arya: true,
        category: 'arya',
        description: {},
        install: '',
        added: '',
        releases: catalogVersions.map(version => ({ version, sha256: '0'.repeat(64), tarball: tarballOf(activeName, version) })),
      }],
    }),
  }
})

// Only the two answers that would reach the network are replaced: the real
// `catalogueDrift`, `isUpgrade` and `isFirstPartyRelease` are what is under
// test, and stubbing them would make every assertion below tautological.
vi.mock('../src/updates.ts', async importOriginal => {
  const original = await importOriginal<typeof import('../src/updates.ts')>()
  return {
    ...original,
    checkUpdates: async () => ({}),
    fetchNpmLatest: async () => npmLatest,
  }
})

let directory: string
let server: Server
let base: string
let dispose: () => void | Promise<void>
const runPlugin = vi.fn<PluginCommandRuntime['runPlugin']>(async () => ({ exitCode: 1, stdout: '', stderr: 'fixture install refused', timedOut: false, cancelled: false }))

beforeEach(async () => {
  activeName = FIRST
  catalogVersions = ['0.2.0', '0.1.0']
  npmLatest = '0.3.0'
  installedSpec = '0.1.0'
  directory = mkdtempSync(join(tmpdir(), 'arya-catalogue-drift-'))
  const profile = join(directory, 'profile')
  mkdirSync(profile)
  writeFileSync(join(profile, 'package.json'), JSON.stringify({ dependencies: { [FIRST]: installedSpec, [THIRD]: '0.1.0' }, dsh: { profile: { bundles: [FIRST, THIRD] } } }))
  for (const name of [FIRST, THIRD]) {
    const installed = join(directory, 'profile', 'node_modules', name)
    mkdirSync(installed, { recursive: true })
    writeFileSync(join(installed, 'package.json'), JSON.stringify({ name, version: '0.1.0', dsh: { bundle: { patch: './cordis.patch.yml' } } }))
  }
  const routes = new Map<string, (request: IncomingMessage, response: ServerResponse) => void | Promise<void>>()
  dispose = mountMarketRoutes({ webServer: { register(route) { routes.set(route.path, route.handler); return () => { routes.delete(route.path) } } }, loader: { entries: () => [] }, plugin: () => ({ await: async () => undefined, dispose: () => {} }) },
    { profile: 'web', profileDirectory: join(directory, 'profile'), dshInstallDir: directory, catalogUrl: 'https://example.com/arya.json' },
    { runPlugin, probePnpm: async () => true, provisionPnpm: async () => ({ ok: true }), cancelActive: () => false, acceptsMarketPnpmFlags: false })
  server = createServer((request, response) => {
    const handler = routes.get(new URL(request.url ?? '/', 'http://localhost').pathname)
    if (handler) void handler(request, response)
    else { response.writeHead(404); response.end() }
  })
  await new Promise<void>(resolve => { server.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('No fixture address')
  base = `http://127.0.0.1:${String(address.port)}`
})

afterEach(async () => {
  await dispose?.()
  if (server) await new Promise<void>((resolve, reject) => { server.close(error => error ? reject(error) : resolve()); server.closeAllConnections() })
  rmSync(directory, { recursive: true, force: true })
  runPlugin.mockClear()
  forgetCatalog()
})

type UpdatesBody = { updates: Record<string, { latest: string | null, updateAvailable: boolean, kind: string, catalogueDrift?: { npm: string, catalog: string } }> }
const updatesOf = async (): Promise<UpdatesBody['updates']> =>
  ((await (await fetch(`${base}/dsh-market/updates?force=1`)).json()) as UpdatesBody).updates

it('does not hide a newer npm release behind an older catalog entry', async () => {
  const updates = await updatesOf()
  expect(updates[FIRST]).toMatchObject({ latest: '0.3.0', updateAvailable: true, catalogueDrift: { npm: '0.3.0', catalog: '0.2.0' } })
})

it('updates a registry install from npm when the catalog is behind', async () => {
  await fetch(`${base}/dsh-market/updates?force=1`)
  const response = await fetch(`${base}/dsh-market/update`, {
    method: 'POST',
    headers: { origin: base, 'content-type': 'application/json' },
    body: JSON.stringify({ name: FIRST }),
  })
  // The fixture installer refuses, and the route reports that honestly; what
  // matters is WHICH target reached it.
  expect(response.ok).toBe(false)
  expect(runPlugin).toHaveBeenCalledWith('web', ['add', `${FIRST}@0.3.0`])
})

it('keeps the catalog answer when npm agrees with it', async () => {
  npmLatest = '0.2.0'
  const updates = await updatesOf()
  expect(updates[FIRST]).toMatchObject({ latest: '0.2.0', updateAvailable: true })
  expect(updates[FIRST]!.catalogueDrift).toBeUndefined()
})

it('leaves a third-party catalog entry to the catalog', async () => {
  activeName = THIRD
  const updates = await updatesOf()
  // Curated: a newer package under the same name on npm is not this market's
  // decision to install, so the entry still answers 0.2.0 and carries no drift.
  expect(updates[THIRD]).toMatchObject({ latest: '0.2.0', updateAvailable: true })
  expect(updates[THIRD]!.catalogueDrift).toBeUndefined()
})

it('names the drift without offering a swap when the install is a catalog archive', async () => {
  // A market-staged archive: exactly the shape `isAryaReleaseSpec` recognises.
  const archive = `file:C:/profiles/web/.dsh-market/releases/aryacode-dsh-example-0.2.0-${'0'.repeat(64)}.tgz`
  installedSpec = archive
  writeFileSync(join(directory, 'profile', 'package.json'), JSON.stringify({ dependencies: { [FIRST]: archive, [THIRD]: '0.1.0' }, dsh: { profile: { bundles: [FIRST, THIRD] } } }))
  const updates = await updatesOf()
  // The catalog's own answer stands (0.2.0 IS newer than the installed 0.1.0),
  // and the newer npm release is named rather than silently dropped.
  expect(updates[FIRST]).toMatchObject({ latest: '0.2.0', updateAvailable: true, catalogueDrift: { npm: '0.3.0', catalog: '0.2.0' } })
})

it('keeps a catalog install from being turned into a registry one it cannot roll back', async () => {
  const archive = `file:C:/profiles/web/.dsh-market/releases/aryacode-dsh-example-0.2.0-${'0'.repeat(64)}.tgz`
  installedSpec = archive
  writeFileSync(join(directory, 'profile', 'package.json'), JSON.stringify({ dependencies: { [FIRST]: archive, [THIRD]: '0.1.0' }, dsh: { profile: { bundles: [FIRST, THIRD] } } }))
  const response = await fetch(`${base}/dsh-market/update`, {
    method: 'POST',
    headers: { origin: base, 'content-type': 'application/json' },
    body: JSON.stringify({ name: FIRST }),
  })
  expect(response.status).toBe(400)
  expect(runPlugin).not.toHaveBeenCalled()
  expect(JSON.parse(readFileSync(join(directory, 'profile', 'package.json'), 'utf8')).dependencies[FIRST]).toBe(archive)
})
