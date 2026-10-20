#!/usr/bin/env node
/**
 * Publish a directory of packed Arya plugin tarballs into the Arya catalog.
 *
 * Every tarball is matched by package name against `data/arya-sources.json`
 * (source repository plus English and Chinese descriptions), so an unknown
 * package is reported instead of being published under a guessed source. The
 * single-tarball publisher owns validation, release creation and the catalog
 * append; this script only sequences it and reports every failure.
 *
 * Usage:
 *   node scripts/publish-arya-batch.mjs --dir <tarball-dir> [--publish]
 */
import { spawnSync } from 'node:child_process'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const { values } = parseArgs({ options: {
  dir: { type: 'string' },
  publish: { type: 'boolean', default: false },
} })
if (values.dir === undefined) throw new Error('Use --dir <tarball-dir> [--publish]')

const directory = resolve(values.dir)
const { plugins } = JSON.parse(readFileSync(join(root, 'data/arya-sources.json'), 'utf8'))
const byName = new Map(plugins.map(plugin => [plugin.name, plugin]))

function identity(tarball) {
  const result = spawnSync('tar', ['-xOf', tarball, 'package/package.json'], { encoding: 'utf8', windowsHide: true })
  if (result.status !== 0) throw new Error(`cannot read ${tarball}: ${result.stderr}`)
  const manifest = JSON.parse(result.stdout)
  return { name: manifest.name, version: manifest.version }
}

const failures = []
let published = 0
for (const file of readdirSync(directory).filter(entry => entry.endsWith('.tgz')).sort()) {
  const tarball = join(directory, file)
  let name
  try { ({ name } = identity(tarball)) } catch (error) { failures.push(`${file}: ${String(error).split('\n')[0]}`); continue }
  const plugin = byName.get(name)
  if (plugin === undefined) { failures.push(`${file}: ${name} has no entry in data/arya-sources.json`); continue }
  const args = [
    'scripts/publish-arya-release.mjs',
    '--tarball', tarball,
    '--source', plugin.source,
    '--description', plugin.description.en,
    '--description-zh', plugin.description.zh,
    ...values.publish ? ['--publish'] : [],
  ]
  const result = spawnSync(process.execPath, args, { cwd: root, encoding: 'utf8', windowsHide: true })
  if (result.status === 0) {
    published += 1
    console.log(result.stdout.trim())
  } else {
    const detail = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim().split(/\r?\n/).filter(Boolean).slice(-2).join(' | ')
    failures.push(`${name}: ${detail}`)
    console.log(`FAILED ${name}: ${detail}`)
  }
}

console.log(`publish-arya-batch: ${published} published, ${failures.length} failed (${values.publish ? 'published' : 'validated only'})`)
for (const failure of failures) console.log(`  ${failure}`)
if (failures.length > 0) process.exitCode = 1
