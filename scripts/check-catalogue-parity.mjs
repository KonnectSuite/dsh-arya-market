#!/usr/bin/env node
/**
 * Read-only drift check between the published Arya catalog and npm.
 *
 * The market answers "is there an update?" from two places: the catalog's
 * `releases[0]` for the packages it lists, and npm's `latest` for everything
 * else. Those are written by separate steps (npm publish, then the catalog
 * record, then the branch push), so they drift — and the symptom is silent.
 * A release recorded on npm but not in the catalog is not merely
 * unannounced: for a listed package the catalog answer WINS, so a newer npm
 * release is hidden behind an older one and every user reads "up to date".
 *
 * This script compares, for every catalog entry: the catalog's newest
 * release, npm's `latest`, the digest the entry pins, and the digest the
 * tarball actually serves. It also compares the catalog against
 * `data/arya-sources.json`, because an entry published without being listed
 * there (or listed there and never published) is the same defect one step
 * earlier.
 *
 * It changes nothing and needs no build.
 *
 * Usage:
 *   node scripts/check-catalogue-parity.mjs                published catalog vs npm
 *   node scripts/check-catalogue-parity.mjs --catalog <f>  a local catalog file
 *   node scripts/check-catalogue-parity.mjs --no-digest    skip tarball downloads
 *   node scripts/check-catalogue-parity.mjs --json         machine-readable
 *   node scripts/check-catalogue-parity.mjs --strict       warnings fail the run too
 *
 * Exit codes: 0 in parity, 1 drift found, 2 the check itself could not run.
 * Without --strict only errors fail: a hidden update, a bad checksum, an
 * unreadable entry. List-vs-list warnings are printed and counted, not fatal.
 */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const LIVE = 'https://raw.githubusercontent.com/KonnectSuite/dsh-arya-market/catalog/data/arya-plugins.json'
/**
 * The branch itself, not the CDN.
 *
 * Users read the raw URL above, but it answers from cache for minutes — and a
 * check built on it reports the catalog from BEFORE a push as the catalog
 * today. That turns "you published seconds ago" into "npm is ahead", which is
 * the alarm this script exists to raise, so it must not also be able to fake
 * it. The API is the authority; the raw URL is only used when the API refuses.
 */
const API = 'https://api.github.com/repos/KonnectSuite/dsh-arya-market/contents/data/arya-plugins.json?ref=catalog'
const SOURCES = join(ROOT, 'data', 'arya-sources.json')

const { values } = parseArgs({ options: {
  catalog: { type: 'string' },
  json: { type: 'boolean', default: false },
  'no-digest': { type: 'boolean', default: false },
} })

/**
 * Semver precedence, negative / 0 / positive.
 *
 * Duplicated from `src/updates.ts` on purpose: this script is the check you
 * run when a publish may have gone wrong, including on a clone that has never
 * been built, and importing `lib/` would make a diagnostic depend on the
 * build it is meant to diagnose.
 */
const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/
function parseVersion(text) {
  const match = SEMVER.exec(String(text).trim())
  if (match === null) return null
  return { core: [Number(match[1]), Number(match[2]), Number(match[3])], pre: match[4] === undefined ? [] : match[4].split('.') }
}
function compareVersions(a, b) {
  const left = parseVersion(a)
  const right = parseVersion(b)
  if (left === null || right === null) return null
  for (let index = 0; index < 3; index += 1) {
    if (left.core[index] !== right.core[index]) return left.core[index] - right.core[index]
  }
  if (left.pre.length === 0 || right.pre.length === 0) return right.pre.length - left.pre.length
  for (let index = 0; index < Math.max(left.pre.length, right.pre.length); index += 1) {
    const x = left.pre[index]
    const y = right.pre[index]
    if (x === undefined) return -1
    if (y === undefined) return 1
    if (x === y) continue
    const nx = /^\d+$/.test(x)
    const ny = /^\d+$/.test(y)
    if (nx && ny) return Number(x) - Number(y)
    if (nx !== ny) return nx ? -1 : 1
    return x < y ? -1 : 1
  }
  return 0
}

/** Fetch JSON, reporting the HTTP status rather than a parse error. */
async function fetchJson(url, retries = 2) {
  let last
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const response = await fetch(url, { headers: { 'user-agent': 'dsh-arya-market/parity-check' } })
      if (!response.ok) throw new Error(`HTTP ${String(response.status)}`)
      return await response.json()
    } catch (error) {
      last = error
      if (attempt < retries) await new Promise(done => setTimeout(done, 400 * (attempt + 1)))
    }
  }
  throw new Error(`${url}: ${last instanceof Error ? last.message : String(last)}`)
}

/** Digest a tarball URL without keeping it in memory. */
async function digestOf(url) {
  const response = await fetch(url, { headers: { 'user-agent': 'dsh-arya-market/parity-check' } })
  if (!response.ok) throw new Error(`HTTP ${String(response.status)}`)
  const hash = createHash('sha256')
  for await (const chunk of response.body) hash.update(chunk)
  return hash.digest('hex')
}

let catalog
let catalogSource
if (values.catalog !== undefined) {
  catalogSource = resolve(values.catalog)
  try {
    catalog = JSON.parse(readFileSync(catalogSource, 'utf8').replace(/^\uFEFF/, ''))
  } catch (error) {
    console.error(`parity: cannot read ${catalogSource}: ${error instanceof Error ? error.message : String(error)}`)
    process.exit(2)
  }
} else {
  try {
    const body = await fetchJson(API)
    catalog = JSON.parse(Buffer.from(body.content, 'base64').toString('utf8'))
    catalogSource = `${API} (the branch)`
  } catch (apiError) {
    // The API is anonymous here, so it can be rate-limited. Falling back is
    // better than not running — as long as the answer says which copy it read.
    try {
      catalog = await fetchJson(`${LIVE}?parity=${String(Date.now())}`)
      catalogSource = `${LIVE} (CDN copy — the branch API refused: ${apiError instanceof Error ? apiError.message : String(apiError)})`
    } catch (error) {
      console.error(`parity: cannot read the published catalog: ${error instanceof Error ? error.message : String(error)}`)
      process.exit(2)
    }
  }
}

if (!Array.isArray(catalog.plugins) || catalog.plugins.length === 0) {
  console.error('parity: the catalog has no plugins')
  process.exit(2)
}

/**
 * An error is something a user can feel today: a hidden update, an archive
 * that will fail its checksum, an entry that cannot install. A warning is a
 * list that disagrees with another list but is not yet a broken install.
 */
const errors = []
const warnings = []
const rows = []
for (const plugin of catalog.plugins) {
  const row = { name: plugin.name, catalog: plugin.releases?.[0]?.version ?? null, npm: null, pinned: plugin.releases?.[0]?.sha256 ?? null, served: null, notes: [] }
  rows.push(row)
  let npmDocument = null
  try {
    npmDocument = await fetchJson(`https://registry.npmjs.org/${encodeURIComponent(plugin.name)}`)
    row.npm = typeof npmDocument['dist-tags']?.latest === 'string' ? npmDocument['dist-tags'].latest : null
  } catch (error) {
    row.notes.push(`npm lookup failed (${error instanceof Error ? error.message : String(error)})`)
    errors.push({ kind: 'npm-unreadable', package: plugin.name, detail: `${plugin.name}: ${row.notes.at(-1)}` })
    continue
  }
  if (row.npm === null) {
    row.notes.push('npm has no `latest` tag')
    warnings.push({ kind: 'npm-no-latest', package: plugin.name, detail: `${plugin.name}: the registry answers without a latest dist-tag` })
  }
  if (row.catalog === null) {
    row.notes.push('catalog has no releases')
    errors.push({ kind: 'catalog-empty', package: plugin.name, detail: `${plugin.name}: the entry records no releases` })
    continue
  }
  // The direction that hides updates: npm already serves something newer, so
  // the catalog answer suppresses it for every user of this market.
  if (row.npm !== null && compareVersions(row.npm, row.catalog) !== null && compareVersions(row.npm, row.catalog) > 0) {
    row.notes.push(`DRIFT: npm is ahead (${row.npm} > ${row.catalog})`)
    const repo = typeof plugin.url === 'string' ? plugin.url.replace(/^https:\/\/github\.com\//i, '') : '<repo>'
    errors.push({
      kind: 'npm-ahead',
      package: plugin.name,
      detail: `${plugin.name}: npm latest ${row.npm} is newer than the catalog's ${row.catalog}, so users read "up to date". Record it: node scripts/publish-arya-release.mjs --npm ${row.npm} --source ${repo} --push${Array.isArray(plugin.releases) && plugin.releases.some(release => release.version === row.npm) ? ' (already recorded — the branch push is what is missing)' : ''}`,
    })
  } else if (row.npm !== null && compareVersions(row.catalog, row.npm) !== null && compareVersions(row.catalog, row.npm) > 0) {
    // Legitimate (a beta line, or a version recorded before `latest` moved),
    // but worth naming: `latest` is not what the catalog promises, so a plain
    // `pnpm add <name>` installs something else than the market would.
    row.notes.push(`catalog is ahead of npm latest (${row.catalog} > ${row.npm})`)
  }
  if (values['no-digest']) continue
  try {
    row.served = await digestOf(plugin.releases[0].tarball)
    if (row.served !== row.pinned) {
      row.notes.push('DRIFT: pinned sha256 differs from the tarball')
      errors.push({
        kind: 'digest-mismatch',
        package: plugin.name,
        detail: `${plugin.name}@${row.catalog}: catalog pins ${String(row.pinned)}, the archive serves ${row.served}`,
      })
    }
  } catch (error) {
    row.notes.push(`tarball unreadable (${error instanceof Error ? error.message : String(error)})`)
    errors.push({ kind: 'tarball-unreadable', package: plugin.name, detail: `${plugin.releases[0].tarball}: ${error instanceof Error ? error.message : String(error)}` })
  }
}

/** The manifest the catalog is supposed to describe. */
let sources = []
try {
  sources = JSON.parse(readFileSync(SOURCES, 'utf8').replace(/^\uFEFF/, '')).plugins ?? []
} catch {
  /* A checkout without the generated sources file still gets the npm checks. */
}
const sourceNames = new Set(sources.map(plugin => plugin.name))
const catalogNames = new Set(catalog.plugins.map(plugin => plugin.name))
// Both directions are reported but not fatal: an unpublished plugin is a
// normal state, and a catalog entry outside the manifest may predate it. What
// matters is that the two lists are KNOWN to disagree instead of silently
// diverging — a package that lives only in the manifest can never update
// through the catalog, only through npm and its release-age wait.
const manifestOnly = [...sourceNames].filter(name => !catalogNames.has(name)).sort()
const catalogOnly = sourceNames.size === 0 ? [] : [...catalogNames].filter(name => !sourceNames.has(name)).sort()

const strict = process.argv.includes('--strict')
const blocking = errors.length + (strict ? warnings.length + manifestOnly.length + catalogOnly.length : 0)

if (values.json) {
  console.log(JSON.stringify({
    catalog: catalogSource,
    updated: catalog.updated,
    count: catalog.plugins.length,
    rows,
    errors,
    warnings,
    manifestOnly,
    catalogOnly,
  }, null, 2))
} else {
  const pad = Math.max(...rows.map(row => row.name.length), 'package'.length)
  console.log(`${catalogSource}`)
  console.log(`updated ${String(catalog.updated)} · ${String(catalog.plugins.length)} entries\n`)
  console.log(`${'package'.padEnd(pad)}  catalog   npm       sha256   notes`)
  for (const row of rows) {
    const sha = values['no-digest'] ? 'skipped' : row.served === null ? '-' : row.served === row.pinned ? 'ok' : 'MISMATCH'
    console.log(`${row.name.padEnd(pad)}  ${(row.catalog ?? '-').padEnd(9)} ${(row.npm ?? '-').padEnd(9)} ${sha.padEnd(8)} ${row.notes.join('; ')}`)
  }
  console.log('')
  for (const item of errors) console.log(`  ERROR ${item.kind}: ${item.detail}`)
  for (const item of warnings) console.log(`  warning ${item.kind}: ${item.detail}`)
  if (manifestOnly.length > 0) {
    console.log(`  warning manifest-vs-catalog: in data/arya-sources.json but never published, so no catalog update can ever reach them: ${manifestOnly.join(', ')}`)
  }
  if (catalogOnly.length > 0) {
    console.log(`  warning manifest-vs-catalog: published but absent from data/arya-sources.json: ${catalogOnly.join(', ')}`)
  }
  const summary = `${String(errors.length)} error(s), ${String(warnings.length + manifestOnly.length + catalogOnly.length)} warning(s)`
  console.log(errors.length === 0 && blocking === 0
    ? `\nparity: in parity for every installable entry — ${summary}`
    : `\nparity: ${summary}`)
}

if (blocking > 0) process.exitCode = 1
