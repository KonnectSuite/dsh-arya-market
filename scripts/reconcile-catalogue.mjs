#!/usr/bin/env node
/**
 * Make the published catalog match npm, without anyone remembering to.
 *
 * Publishing a plugin is two writes in two places: `npm publish` in the plugin
 * repository, and the catalog entry the market actually reads. The second one
 * has been a manual step for as long as this repo has existed, so it is skipped
 * whenever a release is cut in a hurry — and a skipped entry does not merely go
 * unannounced, it HIDES the release: the market answers from `releases[0]`, so
 * a newer npm version reads as "up to date" to every user.
 *
 * This script closes that loop. For every package the catalog lists (and every
 * package the manifest says belongs in the market), it asks npm for `latest`
 * and records what is missing: download the archive, run the same installability
 * guard `publish-arya-release.mjs` runs, pin its sha256, and push once at the
 * end. It is idempotent — a catalog that is already current costs one request
 * per package and no write.
 *
 * Usage:
 *   node scripts/reconcile-catalogue.mjs              record what npm has, push, verify
 *   node scripts/reconcile-catalogue.mjs --dry-run    print the plan, change nothing
 *   node scripts/reconcile-catalogue.mjs --only @aryacode/dsh-arya-image-gen
 *   node scripts/reconcile-catalogue.mjs --no-push    record locally, push nothing
 *
 * Exit codes: 0 nothing to do or everything recorded, 1 something failed, 2 refused.
 *
 * What it will NOT do: publish an archive that is not an installable bundle, or
 * overwrite a recorded version with different bytes. Both are reported and the
 * run continues, so one broken package cannot block the other nine.
 */
import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { fetchText, inspectRegistryRelease } from './lib/archive.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const REPO = 'KonnectSuite/dsh-arya-market'
const BRANCH = 'catalog'
const REPO_PATH = 'data/arya-plugins.json'
const CATALOG = join(ROOT, REPO_PATH)
const SOURCES = join(ROOT, 'data', 'arya-sources.json')
const ARTIFACTS = join(ROOT, '.arya-release-artifacts')

const { values } = parseArgs({ options: {
  'dry-run': { type: 'boolean', default: false },
  only: { type: 'string' },
  'no-push': { type: 'boolean', default: false },
} })

/** Built validators. The catalog must satisfy the same rules the market enforces. */
let compareVersions
let validateAryaRegistry
try {
  ;({ compareVersions } = await import('../lib/updates.js'))
  ;({ validateAryaRegistry } = await import('../lib/arya.js'))
} catch (error) {
  console.error(`reconcile: cannot load the built validators (${error instanceof Error ? error.message : String(error)})`)
  console.error('reconcile: run `npm run build` first.')
  process.exit(2)
}

/** Run gh and return stdout. */
function gh(args) {
  const result = spawnSync('gh', args, { encoding: 'utf8', windowsHide: true })
  if (result.status !== 0) throw new Error(`gh ${args[0]} failed: ${(result.stderr ?? '').trim()}`)
  return (result.stdout ?? '').trim()
}

/** The catalog the branch serves right now — never the CDN, which lags minutes. */
function readBranchCatalog() {
  const body = JSON.parse(gh(['api', `repos/${REPO}/contents/${REPO_PATH}?ref=${BRANCH}`]))
  return { catalog: JSON.parse(Buffer.from(body.content, 'base64').toString('utf8')), sha: body.sha, text: Buffer.from(body.content, 'base64').toString('utf8') }
}

/** npm's `latest`, with the publish time for the report. */
async function npmLatest(name) {
  const document = JSON.parse(await fetchText(`https://registry.npmjs.org/${encodeURIComponent(name)}`))
  const latest = document['dist-tags']?.latest
  if (typeof latest !== 'string') throw new Error('the registry answers without a latest dist-tag')
  return { latest, published: document.time?.[latest] ?? null }
}

let sources = { plugins: [] }
try {
  sources = JSON.parse(readFileSync(SOURCES, 'utf8').replace(/^\uFEFF/, ''))
} catch {
  /* the catalog alone is still checkable */
}
const sourceByName = new Map((sources.plugins ?? []).map(plugin => [plugin.name, plugin]))

let branch
try {
  branch = readBranchCatalog()
} catch (error) {
  console.error(`reconcile: cannot read the catalog branch: ${error instanceof Error ? error.message : String(error)}`)
  process.exit(2)
}
const catalog = branch.catalog

const recorded = new Map(catalog.plugins.map(plugin => [plugin.name, plugin]))
const candidates = new Set(recorded.keys())
for (const name of sourceByName.keys()) candidates.add(name)

const changes = []
/** Refusals on packages the catalog already lists: a hidden update, so fatal. */
const fatal = []
/** Refusals on packages only the manifest names: reported, not fatal. */
const problems = []
for (const name of [...candidates].sort()) {
  if (values.only !== undefined && name !== values.only) continue
  let npm
  try {
    npm = await npmLatest(name)
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    // A manifest entry npm has never served is a plan, not a defect.
    if (/returned 404/.test(detail)) continue
    problems.push(`${name}: npm lookup failed — ${detail}`)
    continue
  }
  const entry = recorded.get(name)
  const top = entry?.releases?.[0]?.version ?? null
  if (top !== null && compareVersions(npm.latest, top) !== null && compareVersions(npm.latest, top) <= 0) continue

  // A new package needs a catalog identity: repository plus both descriptions.
  const source = sourceByName.get(name)
  if (entry === undefined && source === undefined) {
    problems.push(`${name}@${npm.latest}: npm serves it and the catalog does not list it, but data/arya-sources.json has no entry — add one, then re-run`)
    continue
  }

  try {
    const release = await inspectRegistryRelease(name, npm.latest, ARTIFACTS)
    changes.push({ name, source, release })
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    // A package the catalog ALREADY lists has users waiting on this version, so
    // failing to record it is a hidden update and fails the run. A package only
    // the manifest names has never been in the market, so an unlistable archive
    // is reported and does not turn every later run red — the daily parity check
    // is where it stays visible.
    if (entry === undefined) problems.push(`${name}@${npm.latest}: refused — ${detail}`)
    else fatal.push(`${name}@${npm.latest}: refused — ${detail}`)
  }
}

if (values['dry-run']) {
  console.log(`reconcile: ${String(changes.length)} release(s) to record, ${String(problems.length + fatal.length)} problem(s)`)
  for (const change of changes) console.log(`  would record ${change.name}@${change.release.version} (${change.release.sha256.slice(0, 12)}…)`)
  for (const problem of [...problems, ...fatal]) console.error(`  ${problem}`)
  process.exit(fatal.length > 0 ? 1 : 0)
}

const recordedNow = []
for (const { name, source, release } of changes) {
  let plugin = recorded.get(name)
  if (plugin === undefined) {
    plugin = {
      name,
      owner: 'KonnectSuite',
      url: `https://github.com/${source.source}`,
      category: 'arya',
      description: { en: source.description.en, zh: source.description.zh },
      added: new Date().toISOString().slice(0, 10),
      install: '',
      arya: true,
      releases: [],
    }
    catalog.plugins.push(plugin)
    recorded.set(name, plugin)
  }
  const existing = plugin.releases.find(candidate => candidate.version === release.version)
  if (existing !== undefined) {
    if (existing.sha256 !== release.sha256) {
      problems.push(`${name}@${release.version}: already recorded with different bytes; a published version is immutable — bump it instead`)
    }
    continue
  }
  plugin.releases.push({ version: release.version, tarball: release.tarball, sha256: release.sha256 })
  plugin.releases.sort((a, b) => compareVersions(b.version, a.version) ?? 0)
  plugin.version = plugin.releases[0].version
  plugin.tarball = plugin.releases[0].tarball
  recordedNow.push(`${name}@${release.version}`)
}

catalog.count = catalog.plugins.length
if (recordedNow.length > 0) catalog.updated = new Date().toISOString()
try {
  validateAryaRegistry(catalog)
} catch (error) {
  console.error(`reconcile: the reconciled catalog is invalid, nothing was written — ${error instanceof Error ? error.message : String(error)}`)
  process.exit(2)
}

if (recordedNow.length === 0) {
  console.log(`reconcile: the catalog already matches npm (${String(catalog.plugins.length)} entries) — nothing to do`)
  for (const problem of [...problems, ...fatal]) console.error(`  ${problem}`)
  if (fatal.length > 0) process.exitCode = 1
  process.exit(process.exitCode ?? 0)
}

mkdirSync(ARTIFACTS, { recursive: true })
const text = `${JSON.stringify(catalog, null, 2)}\n`
writeFileSync(CATALOG, text, 'utf8')

let pushed = false
if (!values['no-push']) {
  try {
    if (branch.text !== text) {
      const payloadFile = join(ARTIFACTS, 'catalog-payload.json')
      writeFileSync(payloadFile, JSON.stringify({
        message: `catalog: sync ${String(catalog.plugins.length)} plugins with npm`,
        branch: BRANCH,
        content: Buffer.from(text, 'utf8').toString('base64'),
        sha: branch.sha,
      }), 'utf8')
      gh(['api', `repos/${REPO}/contents/${REPO_PATH}`, '--method', 'PUT', '--input', payloadFile])
      pushed = true
    }
  } catch (error) {
    console.error(`reconcile: the local catalog was updated but the push failed — ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  }
}

for (const name of recordedNow) console.log(`recorded ${name}`)
for (const problem of [...problems, ...fatal]) console.error(`  ${problem}`)
console.log(`reconcile: ${String(recordedNow.length)} recorded${pushed ? ', catalog branch updated' : values['no-push'] ? ', not pushed' : ''}${problems.length + fatal.length > 0 ? `, ${String(problems.length + fatal.length)} problem(s)` : ''}`)
if (fatal.length > 0) process.exitCode = 1
