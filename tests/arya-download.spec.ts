/** Published bytes are verified before a profile package operation starts. */
import { afterEach, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { stageAryaRelease, resolveAryaDownloadLimits } from '../src/arya.ts'
import { isAryaReleaseSpec } from '../src/arya-release-spec.ts'
import { isPluginTarget } from '../src/dsh-cli.ts'
import type { RegistryPlugin } from '../src/registry.ts'

const bytes = Buffer.from('published package bytes')
const plugin: RegistryPlugin = {
  name: 'dsh-example', owner: 'KonnectSuite', url: '', category: '', description: {}, added: '', install: '', arya: true,
  releases: [{ version: '0.1.0', tarball: 'https://github.com/KonnectSuite/dsh-arya-market/releases/download/plugin-dsh-example-v0.1.0/dsh-example-0.1.0.tgz', sha256: createHash('sha256').update(bytes).digest('hex') }],
}
let directory: string | undefined
afterEach(async () => {
  vi.unstubAllGlobals()
  if (directory !== undefined) await rm(directory, { recursive: true, force: true })
  directory = undefined
})

it('verifies downloaded and cached bytes in profiles with spaces and Unicode', async () => {
  directory = await mkdtemp(join(tmpdir(), 'Arya 用户 '))
  const fetch = vi.fn().mockResolvedValue(new Response(bytes))
  vi.stubGlobal('fetch', fetch)
  const target = await stageAryaRelease(plugin, '0.1.0', directory, resolveAryaDownloadLimits({}))
  expect(isPluginTarget(target)).toBe(true)
  expect(isAryaReleaseSpec(plugin, target)).toBe(true)
  expect(isAryaReleaseSpec(plugin, target.replace(plugin.releases![0].sha256, '0'.repeat(64)))).toBe(false)
  expect(await readFile(target.slice(5))).toEqual(bytes)
  expect(await stageAryaRelease(plugin, '0.1.0', directory, resolveAryaDownloadLimits({}))).toBe(target)
  expect(fetch).toHaveBeenCalledTimes(1)
  await writeFile(target.slice(5), 'tampered')
  await expect(stageAryaRelease(plugin, '0.1.0', directory, resolveAryaDownloadLimits({}))).rejects.toThrow('Cached Arya package checksum')
  expect(fetch).toHaveBeenCalledTimes(1)
})

it.each([
  [Buffer.from('wrong bytes'), 1024, 'checksum'],
  [bytes, 1, 'download limit'],
])('rejects unverified release bytes before caching them', async (body, maxBytes, message) => {
  directory = await mkdtemp(join(tmpdir(), 'arya-invalid-release-'))
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(body)))
  await expect(stageAryaRelease(plugin, '0.1.0', directory, { maxBytes, timeoutMs: 1000 })).rejects.toThrow(message)
})

it('cancels an in-flight download without creating an installation target', async () => {
  directory = await mkdtemp(join(tmpdir(), 'arya-cancel-release-'))
  let started!: () => void
  const ready = new Promise<void>(resolve => { started = resolve })
  vi.stubGlobal('fetch', vi.fn((_url: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
    init.signal!.addEventListener('abort', () => reject(init.signal!.reason), { once: true })
    started()
  })))
  const owner = new AbortController()
  const download = stageAryaRelease(plugin, '0.1.0', directory, resolveAryaDownloadLimits({}), owner.signal)
  const rejection = expect(download).rejects.toThrow('owner stopped')
  await ready
  owner.abort(new Error('owner stopped'))
  await rejection
})

it('rejects invalid deployment limits and unsafe package targets', () => {
  expect(() => resolveAryaDownloadLimits({ maxReleaseBytes: 0 })).toThrow()
  expect(() => resolveAryaDownloadLimits({ releaseDownloadTimeoutMs: Number.NaN })).toThrow()
  for (const target of ['file:relative path.tgz', 'file:C:/a\n/b.tgz', 'file:C:/a%20b.tgz', 'file:C:/a&b.tgz', 'dsh-example bad', 'file:C:/a"b.tgz']) expect(isPluginTarget(target)).toBe(false)
  expect(isPluginTarget('file:C:/Arya 用户/plugin.tgz')).toBe(true)
  expect(isAryaReleaseSpec(plugin, 'file:C:/development/dsh-example')).toBe(false)
})
