/** Catalog authorization and installer-version selection. */
import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { aryaReleaseTarget, bundledAryaVersion, validateAryaRegistry, validateCatalogUrl, mergeMarketRegistries } from '../src/arya.ts'
import type { Registry } from '../src/registry.ts'

function catalog(): Registry {
  return { updated: '', count: 1, categories: {}, plugins: [{
    name: 'dsh-example', owner: 'KonnectSuite', url: 'https://github.com/KonnectSuite/dsh-example', category: 'tools', description: {}, added: '', install: '', arya: true,
    releases: ['0.2.0', '0.1.0'].map(version => ({ version, sha256: '0'.repeat(64), tarball: `https://github.com/KonnectSuite/dsh-arya-market/releases/download/plugin-dsh-example-v${version}/dsh-example-${version}.tgz` })),
  }] }
}
let directory: string | undefined
afterEach(() => { if (directory !== undefined) { rmSync(directory, { recursive: true, force: true }); directory = undefined } })

describe('Arya release catalog', () => {
  it('selects the latest release or an explicitly requested earlier release', () => {
    const registry = validateAryaRegistry(catalog())
    expect(aryaReleaseTarget(registry.plugins[0])).toContain('v0.2.0/dsh-example-0.2.0.tgz')
    expect(aryaReleaseTarget(registry.plugins[0], '0.1.0')).toContain('v0.1.0/dsh-example-0.1.0.tgz')
    expect(() => aryaReleaseTarget(registry.plugins[0], 'main')).toThrow('not in the Arya release catalog')
    expect(() => aryaReleaseTarget(registry.plugins[0], null)).toThrow('not in the Arya release catalog')
  })
  it.each([
    'https://evil.example/plugin.tgz',
    'https://github.com/other/dsh-market/releases/download/plugin-dsh-example-v0.2.0/dsh-example-0.2.0.tgz',
    'https://github.com/KonnectSuite/dsh-arya-market/releases/download/plugin-dsh-example-v0.2.0/dsh-other-0.2.0.tgz',
    'https://github.com/KonnectSuite/dsh-arya-market/releases/download/plugin-dsh-example-v0.2.0/dsh-example-0.2.0.tgz?redirect=1',
  ])('rejects an archive outside the named published release: %s', target => {
    const registry = catalog(); registry.plugins[0].releases![0].tarball = target
    expect(() => validateAryaRegistry(registry)).toThrow()
  })
  it('rejects duplicate packages, duplicate versions, and unmarked entries', () => {
    const duplicate = catalog(); duplicate.plugins.push(duplicate.plugins[0]); expect(() => validateAryaRegistry(duplicate)).toThrow('duplicate package')
    const versions = catalog(); versions.plugins[0].releases!.push(versions.plugins[0].releases![0]); expect(() => validateAryaRegistry(versions)).toThrow('duplicate release')
    const unmarked = catalog(); delete unmarked.plugins[0].arya; expect(() => validateAryaRegistry(unmarked)).toThrow('unmarked')
  })
  it('rejects remote plaintext or embedded catalog credentials', () => {
    expect(() => validateCatalogUrl('https://example.com/catalog.json')).not.toThrow()
    expect(() => validateCatalogUrl('http://example.com/catalog.json')).toThrow()
    expect(() => validateCatalogUrl('https://secret@example.com/catalog.json')).toThrow()
  })
  it('reads the installer version from the hoisted sibling layout', () => {
    directory = mkdtempSync(join(tmpdir(), 'arya-market-hoisted-'))
    const dshDir = join(directory, 'node_modules', '@deepseek-ai', 'dsh'); mkdirSync(dshDir, { recursive: true })
    const bundleDir = join(directory, 'node_modules', 'dsh-example'); mkdirSync(bundleDir, { recursive: true })
    writeFileSync(join(bundleDir, 'package.json'), JSON.stringify({ name: 'dsh-example', version: '0.3.0' }))
    expect(bundledAryaVersion(dshDir, 'dsh-example')).toBe('0.3.0')
  })
  it('reads the installer version without consulting the profile override', () => {
    directory = mkdtempSync(join(tmpdir(), 'arya-market-version-'))
    const path = join(directory, 'node_modules', 'dsh-example'); mkdirSync(path, { recursive: true })
    writeFileSync(join(path, 'package.json'), JSON.stringify({ name: 'dsh-example', version: '0.1.0' }))
    expect(bundledAryaVersion(directory, 'dsh-example')).toBe('0.1.0')
    expect(bundledAryaVersion(directory, '../escape')).toBeNull()
    expect(bundledAryaVersion(directory, 'absent')).toBeNull()
    expect(bundledAryaVersion(undefined, 'dsh-example')).toBeNull()
    writeFileSync(join(path, 'package.json'), JSON.stringify({ name: 'other', version: '0.1.0' }))
    expect(bundledAryaVersion(directory, 'dsh-example')).toBeNull()
  })
})

describe('Combined Arya and community market', () => {
  it('keeps community packages and categories while Arya owns duplicate package releases', () => {
    const arya = catalog(); arya.categories = { arya: { en: 'Arya' } }
    const community: Registry = { updated: '2026-10-10', count: 2, categories: { tools: { en: 'Tools' } }, plugins: [
      { ...arya.plugins[0], owner: 'Community', arya: false, releases: undefined },
      { ...arya.plugins[0], name: 'community-example', owner: 'Community', arya: false, releases: undefined },
    ] }
    const merged = mergeMarketRegistries(community, arya)
    expect(merged.count).toBe(2)
    expect(merged.plugins.find(p => p.name === 'dsh-example')).toEqual(arya.plugins[0])
    expect(merged.plugins.find(p => p.name === 'community-example')?.arya).toBe(false)
    expect(merged.categories).toEqual({ tools: { en: 'Tools' }, arya: { en: 'Arya' } })
    expect(community.plugins[0].owner).toBe('Community')
  })
  it('does not grant Arya release authority to community records and rejects invalid Arya releases', () => {
    const community = catalog(); community.plugins[0].name = 'community-example'
    const entry = mergeMarketRegistries(community, catalog()).plugins.find(p => p.name === 'community-example')!
    expect(entry.arya).toBe(false); expect(entry.releases).toBeUndefined()
    const invalid = catalog(); invalid.plugins[0].releases![0].sha256 = 'invalid'
    expect(() => mergeMarketRegistries(community, invalid)).toThrow('checksum')
  })
})

it('preserves community entries from different publishers that share a display name', () => {
  const community = catalog(); community.plugins = [
    { ...community.plugins[0], name: 'shared-name', owner: 'first' },
    { ...community.plugins[0], name: 'shared-name', owner: 'second' },
  ]
  expect(mergeMarketRegistries(community, catalog()).plugins.filter(p => p.name === 'shared-name')).toHaveLength(2)
})
