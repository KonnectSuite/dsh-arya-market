#!/usr/bin/env node
/**
 * Say, in one screen, whether each Arya plugin on this machine is actually released.
 *
 * "Bumped the version" and "released" look identical in a chat and are not the same
 * thing: a plugin can be hot-copied into a profile, read as updated on one machine,
 * and still be invisible to every user because npm and the catalogue never moved.
 * The failure modes are opposite and both silent:
 *
 *   not published   — package.json is ahead of npm, so nothing downstream can know
 *   catalogue stale — npm has it and the catalog does not, so users are told they
 *                     are up to date on a release that exists
 *
 * Run this before and after any plugin task: it is the one table the author and the
 * agent can look at together.
 *
 * Usage:
 *   node scripts/arya-release-status.mjs
 *   node scripts/arya-release-status.mjs --json
 *   node scripts/arya-release-status.mjs --branch   read the catalogue branch, not the cache
 *
 * Exit codes: 0 nothing drifts, 1 something does, 2 the check itself failed.
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { spawnSync } from 'node:child_process'
import { fetchText } from './lib/archive.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const WORKSPACE = resolve(ROOT, '..')
const REPO = 'KonnectSuite/dsh-arya-market'
const BRANCH = 'catalog'
const REPO_PATH = 'data/arya-plugins.json'

const { values: options } = parseArgs({ options: {
  json: { type: 'boolean', default: false },
  branch: { type: 'boolean', default: false },
} })

const readJson = path => JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, ''))

let manifest
try {
  manifest = readJson(join(ROOT, 'arya-plugins.json'))
} catch (error) {
  console.error(`status: cannot read arya-plugins.json (${error.message})`)
  process.exit(2)
}
const market = (manifest.plugins ?? []).filter(plugin => plugin.channel === 'market')

let catalog
if (options.branch) {
  const result = spawnSync('gh', ['api', `repos/${REPO}/contents/${REPO_PATH}?ref=${BRANCH}`], { encoding: 'utf8', windowsHide: true })
  if (result.status !== 0) {
    console.error(`status: cannot read the catalogue branch (${(result.stderr ?? '').trim()})`)
    process.exit(2)
  }
  catalog = JSON.parse(Buffer.from(JSON.parse(result.stdout).content, 'base64').toString('utf8'))
} else {
  try {
    catalog = readJson(join(ROOT, REPO_PATH))
  } catch (error) {
    console.error(`status: cannot read the catalogue cache (${error.message}); pass --branch`)
    process.exit(2)
  }
}
const published = new Map(catalog.plugins.map(plugin => [plugin.name, plugin]))

/**
 * npm's `latest`, plus whether that release could be listed at all.
 *
 * A `workspace:` / `link:` / `file:` dependency is a monorepo spec that cannot
 * resolve in someone else's profile, so the market refuses the archive. Such a
 * package is published and unlistable by design, not late — reporting it as drift
 * would send the author to a command that refuses, which is worse than silence.
 */
async function npmInfo(name) {
  try {
    const document = JSON.parse(await fetchText(`https://registry.npmjs.org/${encodeURIComponent(name)}`))
    const latest = document['dist-tags']?.latest
    if (typeof latest !== 'string') return { latest: null, unlistable: false }
    const version = document.versions?.[latest] ?? {}
    const dependencies = {
      ...(version.dependencies ?? {}),
      ...(version.optionalDependencies ?? {}),
      ...(version.peerDependencies ?? {}),
    }
    const unlistable = Object.values(dependencies).some(value => typeof value === 'string' && /^(?:workspace|link|file):/.test(value))
    return { latest, unlistable }
  } catch (error) {
    if (/returned 404/.test(error.message)) return { latest: null, unlistable: false }
    throw error
  }
}

function compare(left, right) {
  const a = left.split('-')[0].split('.').map(Number)
  const b = right.split('-')[0].split('.').map(Number)
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0)
    if (difference !== 0) return difference
  }
  // A prerelease is behind its release: 0.19.2-rc.1 < 0.19.2.
  if (left.includes('-') !== right.includes('-')) return left.includes('-') ? -1 : 1
  return 0
}

const rows = []
for (const plugin of [...market].sort((a, b) => a.name.localeCompare(b.name))) {
  const directory = plugin.workspace === undefined ? undefined : join(WORKSPACE, plugin.workspace)
  let local = null
  let branch = null
  if (directory !== undefined && existsSync(join(directory, 'package.json'))) {
    const packageJson = readJson(join(directory, 'package.json'))
    local = packageJson.version ?? null
    const git = spawnSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: directory, encoding: 'utf8', windowsHide: true })
    if (git.status === 0) branch = git.stdout.trim()
  }
  const { latest: npm, unlistable } = await npmInfo(plugin.name)
  const entry = published.get(plugin.name)
  const catalogVersion = entry?.releases?.[0]?.version ?? null

  let verdict
  if (npm === null && catalogVersion === null) verdict = 'planned (npm never served it)'
  else if (catalogVersion === null && unlistable) verdict = 'published, cannot be listed (workspace dep)'
  else if (catalogVersion === null) verdict = 'NOT IN CATALOGUE — run catalogue:sync'
  else if (npm !== null && catalogVersion !== npm) verdict = 'CATALOGUE STALE — run catalogue:sync'
  else if (local !== null && npm !== null && compare(local, npm) > 0) verdict = 'NOT PUBLISHED — run release-plugin'
  else verdict = 'in sync'

  rows.push({ name: plugin.name, local, branch, npm, catalog: catalogVersion, unlistable, verdict })
}

if (options.json) {
  console.log(JSON.stringify(rows, null, 2))
} else {
  const nameWidth = Math.max(...rows.map(row => row.name.length), 'plugin'.length)
  const repoWidth = Math.max(...rows.map(row => (row.local ?? '(no checkout)').length), 'repo'.length)
  const pad = (value, size) => String(value ?? '—').padEnd(size)
  console.log(`${pad('plugin', nameWidth)}  ${pad('repo', repoWidth)}  ${pad('npm', 11)}  ${pad('catalog', 11)}  verdict`)
  console.log(`${'-'.repeat(nameWidth)}  ${'-'.repeat(repoWidth)}  ${'-'.repeat(11)}  ${'-'.repeat(11)}  -------`)
  for (const row of rows) {
    const repo = row.local === null ? '(no checkout)' : row.local
    console.log(`${pad(row.name, nameWidth)}  ${pad(repo, repoWidth)}  ${pad(row.npm, 11)}  ${pad(row.catalog, 11)}  ${row.verdict}`)
  }
  const drifting = rows.filter(row => /^NOT|^CATALOGUE/.test(row.verdict))
  const unlistable = rows.filter(row => row.unlistable && row.catalog === null)
  console.log(`\n${String(rows.length)} plugins · ${String(rows.length - drifting.length - unlistable.length)} fine · ${String(drifting.length)} drifting · ${String(unlistable.length)} unlistable`)
  if (unlistable.length > 0) {
    console.log('\nPublished but not listable — the market refuses an archive with a workspace dependency:')
    for (const row of unlistable) console.log(`  ${row.name}@${String(row.npm)}: replace the workspace spec with real versions, or move it out of the market channel in arya-plugins.json`)
  }
  if (drifting.length > 0) {
    console.log('\nFix: node scripts/release-plugin.mjs --dir ../<plugin>   (publish one plugin)')
    console.log('     node scripts/reconcile-catalogue.mjs               (record what npm already has)')
  }
}

process.exit(rows.some(row => /^NOT|^CATALOGUE/.test(row.verdict)) ? 1 : 0)
