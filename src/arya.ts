/** Released Arya packages selected from the host-configured catalog. */
import { readFileSync } from 'node:fs'
import { mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { marketFetch } from './net.ts'
import { aryaReleaseFile } from './arya-release-spec.ts'
import { NPM_NAME_RE } from './sources.ts'
import type { Registry, RegistryPlugin } from './registry.ts'

/** One packaged release; targets are approved by the catalog publisher. */
export interface AryaRelease {
  version: string
  tarball: string
  sha256: string
}

/** Catalog shipped and maintained by the Arya fork. */
export const ARYA_CATALOG_URL = 'https://raw.githubusercontent.com/KonnectSuite/dsh-market/codex/arya-plugin-market/data/arya-plugins.json'

/** Validate a configured catalog address before mounting HTTP routes. */
export function validateCatalogUrl(value: string): void {
  const url = new URL(value)
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '') {
    throw new Error('Arya catalog must use HTTPS without URL credentials')
  }
}

/** Reject malformed release records at the external catalog input. */
export function validateAryaRegistry(registry: Registry): Registry {
  const names = new Set<string>()
  for (const plugin of registry.plugins) {
    if (plugin.arya !== true) throw new Error('Arya catalog contains an unmarked entry')
    if (!NPM_NAME_RE.test(plugin.name) || names.has(plugin.name)) {
      throw new Error('Arya catalog contains an invalid or duplicate package name')
    }
    names.add(plugin.name)
    if (!Array.isArray(plugin.releases) || plugin.releases.length === 0) throw new Error(`${plugin.name}: no packaged releases`)
    const versions = new Set<string>()
    for (const release of plugin.releases) {
      if (release === null || typeof release !== 'object'
        || typeof release.version !== 'string' || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(release.version)
        || versions.has(release.version) || typeof release.tarball !== 'string') {
        throw new Error(`${plugin.name}: invalid or duplicate release`)
      }
      if (typeof release.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(release.sha256)) throw new Error(`${plugin.name}: invalid release checksum`)
      versions.add(release.version)
      const url = new URL(release.tarball)
      const fileName = plugin.name.replace(/^@/, '').replaceAll('/', '-')
      const expected = `/KonnectSuite/dsh-market/releases/download/plugin-${fileName}-v${release.version}/${fileName}-${release.version}.tgz`
      if (url.origin !== 'https://github.com' || url.pathname !== expected || url.search !== '' || url.hash !== '' || url.username !== '' || url.password !== '') {
        throw new Error(`${plugin.name}: release archive does not match its package and version`)
      }
    }
  }
  return registry
}

/** Combine community browsing with validated Arya releases; Arya owns duplicate names.
 * @param community - Third-party catalog without Arya release authority.
 * @param arya - Catalog whose packaged releases must pass Arya validation.
 * @returns Community entries and authoritative Arya packages with combined categories.
 */
export function mergeMarketRegistries(community: Registry, arya: Registry): Registry {
  validateAryaRegistry(arya)
  const aryaNames = new Set(arya.plugins.map(plugin => plugin.name))
  const plugins = [
    ...community.plugins.filter(plugin => !aryaNames.has(plugin.name)).map(plugin => ({ ...plugin, arya: false, releases: undefined })),
    ...arya.plugins,
  ]
  return { updated: [community.updated, arya.updated].sort().at(-1) ?? '', count: plugins.length, categories: { ...community.categories, ...arya.categories }, plugins }
}

/** Download limits resolved from the host's validated market configuration. */
export interface AryaDownloadLimits {
  maxBytes: number
  timeoutMs: number
}

/** Cancellation requested before a verified archive reached the installer. */
export class AryaReleaseCancelled extends Error {
  constructor() { super('Arya package download cancelled') }
}

/** Validate deployment limits before accepting package operations. */
export function validateAryaDownloadLimits(limits: AryaDownloadLimits): void {
  if (!Number.isSafeInteger(limits.maxBytes) || limits.maxBytes <= 0
    || !Number.isSafeInteger(limits.timeoutMs) || limits.timeoutMs <= 0 || limits.timeoutMs > 2_147_483_647) {
    throw new Error('Arya download limits must be positive integers; timeoutMs must fit a timer')
  }
}

/** Resolve and validate the host's deployment-specific download limits. */
export function resolveAryaDownloadLimits(config: { maxReleaseBytes?: number; releaseDownloadTimeoutMs?: number }): AryaDownloadLimits {
  const limits = { maxBytes: config.maxReleaseBytes ?? 64 * 1024 * 1024, timeoutMs: config.releaseDownloadTimeoutMs ?? 120_000 }
  validateAryaDownloadLimits(limits)
  return limits
}

/**
 * Stage verified release bytes for pnpm versions that omit remote archive integrity.
 * @param plugin - Validated catalog package.
 * @param version - Listed release version.
 * @param profileDirectory - Profile that owns the persistent content cache.
 * @param limits - Resolved size and elapsed-time limits.
 * @param signal - Optional owner cancellation signal.
 * @returns Absolute file target accepted by the existing installer.
 */
export async function stageAryaRelease(plugin: RegistryPlugin, version: string, profileDirectory: string, limits: AryaDownloadLimits, signal?: AbortSignal): Promise<string> {
  signal?.throwIfAborted()
  const release = plugin.releases?.find(release => release.version === version)
  if (release === undefined) throw new Error('This plugin version is not in the Arya release catalog')
  const directory = join(profileDirectory, '.dsh-market', 'releases')
  const path = join(directory, aryaReleaseFile(plugin.name, release))
  const target = `file:${path.replaceAll('\\', '/')}`
  const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
  try {
    if ((await stat(path)).size > limits.maxBytes) throw new Error('Cached Arya package exceeds the configured download limit')
    const existing = await readFile(path)
    if (digest(existing) !== release.sha256) throw new Error('Cached Arya package checksum differs from the published release')
    signal?.throwIfAborted()
    return target
  } catch (error) {
    if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error
  }
  const response = await marketFetch(release.tarball, { signal: AbortSignal.any([AbortSignal.timeout(limits.timeoutMs), ...signal === undefined ? [] : [signal]]) })
  if (!response.ok) { await response.body?.cancel(); throw new Error(`Arya package download failed: HTTP ${response.status}`) }
  const reader = response.body?.getReader()
  if (reader === undefined) throw new Error('Arya package download returned no data')
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      const chunk = await reader.read()
      if (chunk.done) break
      size += chunk.value.length
      if (size > limits.maxBytes) throw new Error('Arya package exceeds the configured download limit')
      chunks.push(chunk.value)
    }
  } catch (error) {
    await reader.cancel().catch((_closedStream: unknown) => { /* Aborted streams may already be closed. */ })
    throw error
  } finally { reader.releaseLock() }
  const bytes = Buffer.concat(chunks)
  if (digest(bytes) !== release.sha256) throw new Error('Downloaded Arya package checksum differs from the published release')
  signal?.throwIfAborted()
  await mkdir(directory, { recursive: true })
  const temporary = `${path}.${randomUUID()}.tmp`
  try {
    await writeFile(temporary, bytes, { flag: 'wx' })
    signal?.throwIfAborted()
    await rename(temporary, path)
  } finally {
    try { await unlink(temporary) } catch (error) {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error
    }
  }
  return target
}

/** Select only a listed release; omission chooses the publisher's first release. */
export function aryaReleaseTarget(plugin: RegistryPlugin, version?: unknown): string {
  const release = version === undefined ? plugin.releases?.[0] : plugin.releases?.find(candidate => candidate.version === version)
  if (release === undefined) throw new Error('This plugin version is not in the Arya release catalog')
  return release.tarball
}

/** Read the installer-owned package version, independently of the active profile override. */
export function bundledAryaVersion(installDir: string | undefined, name: string): string | null {
  if (installDir === undefined || !NPM_NAME_RE.test(name)) return null
  try {
    const manifest: unknown = JSON.parse(readFileSync(join(installDir, 'node_modules', name, 'package.json'), 'utf8'))
    if (manifest !== null && typeof manifest === 'object' && 'name' in manifest && manifest.name === name
      && 'version' in manifest && typeof manifest.version === 'string') return manifest.version
    return null
  } catch (error) {
    // An optional plugin can be absent from this installer or inaccessible on disk.
    return null
  }
}
