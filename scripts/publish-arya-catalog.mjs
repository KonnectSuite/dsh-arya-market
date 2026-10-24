#!/usr/bin/env node
/**
 * Move the published Arya plugin catalog between this checkout and the
 * `catalog` branch.
 *
 * The catalog is generated data: it changes on every plugin publish, and the
 * market fetches it over HTTP at runtime. Keeping it on the product branch made
 * publish churn part of the code history and forced `src/arya.ts` to pin a
 * feature branch by name. It lives on its own branch instead, and this script is
 * the only writer.
 *
 * Usage:
 *   node scripts/publish-arya-catalog.mjs --pull    catalog branch -> data/arya-plugins.json
 *   node scripts/publish-arya-catalog.mjs --push    data/arya-plugins.json -> catalog branch
 *
 * --pull is what seeds a fresh checkout before `publish-arya-release.mjs` can
 * append to the catalog; that script starts from an empty catalog when the file
 * is absent, which would drop every previously published version.
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const REPO = 'KonnectSuite/dsh-arya-market'
const BRANCH = 'catalog'
const REPO_PATH = 'data/arya-plugins.json'
const LOCAL = join(ROOT, REPO_PATH)

const CJK_RE = /[\u4E00-\u9FFF]/
/** Latin-1 supplement runs are what UTF-8 read as Latin-1 looks like. */
const MOJIBAKE_RE = /[\u00C0-\u00FF]{2,}/

/** Run gh, returning stdout. */
function gh(args, input) {
  return execFileSync('gh', args, { encoding: 'utf8', input, windowsHide: true })
}

/**
 * Validate a catalog before it can be published.
 * @param text - catalog file contents.
 * @returns the parsed catalog.
 */
function validate(text) {
  if (text.charCodeAt(0) === 0xFEFF) throw new Error(`${REPO_PATH} starts with a UTF-8 BOM`)
  const catalog = JSON.parse(text)
  if (!Array.isArray(catalog.plugins) || catalog.plugins.length === 0) throw new Error('catalog has no plugins')
  if (catalog.count !== catalog.plugins.length) throw new Error(`catalog.count is ${catalog.count}, plugins is ${catalog.plugins.length}`)
  const names = new Set()
  for (const plugin of catalog.plugins) {
    if (typeof plugin.name !== 'string' || names.has(plugin.name)) throw new Error(`invalid or duplicate package name: ${plugin.name}`)
    names.add(plugin.name)
    const zh = plugin.description?.zh
    if (typeof zh !== 'string' || !CJK_RE.test(zh)) throw new Error(`${plugin.name}: description.zh has no Chinese characters`)
    if (MOJIBAKE_RE.test(zh)) throw new Error(`${plugin.name}: description.zh looks like mojibake`)
    if (!Array.isArray(plugin.releases) || plugin.releases.length === 0) throw new Error(`${plugin.name}: no packaged releases`)
    for (const release of plugin.releases) {
      if (!/^[0-9a-f]{64}$/.test(String(release.sha256))) throw new Error(`${plugin.name}@${release.version}: invalid checksum`)
    }
  }
  return catalog
}

/** Read the catalog currently on the branch. */
function readRemote() {
  try {
    const json = JSON.parse(gh(['api', `repos/${REPO}/contents/${REPO_PATH}?ref=${BRANCH}`]))
    return { sha: json.sha, text: Buffer.from(json.content, 'base64').toString('utf8') }
  } catch (error) {
    const detail = String(error.stderr ?? '') + String(error.message ?? '')
    if (/404|Not Found/.test(detail)) return null
    throw error
  }
}

if (process.argv.includes('--pull')) {
  const remote = readRemote()
  if (remote === null) throw new Error(`no ${REPO_PATH} on ${BRANCH}`)
  const catalog = validate(remote.text)
  writeFileSync(LOCAL, remote.text, 'utf8')
  console.log(`pulled ${catalog.plugins.length} plugins from ${BRANCH} into ${REPO_PATH}`)
} else if (process.argv.includes('--push')) {
  const text = readFileSync(LOCAL, 'utf8')
  const catalog = validate(text)
  const remote = readRemote()
  if (remote !== null && remote.text === text) {
    console.log(`${BRANCH} is already at ${catalog.plugins.length} plugins; nothing to publish`)
  } else {
    const payload = {
      message: `catalog: publish ${catalog.plugins.length} plugins (${catalog.plugins.map(plugin => plugin.name).length} packages)`,
      branch: BRANCH,
      content: Buffer.from(text, 'utf8').toString('base64'),
    }
    if (remote !== null) payload.sha = remote.sha
    const dir = mkdtempSync(join(tmpdir(), 'arya-catalog-'))
    const file = join(dir, 'payload.json')
    writeFileSync(file, JSON.stringify(payload), 'utf8')
    gh(['api', `repos/${REPO}/contents/${REPO_PATH}`, '--method', 'PUT', '--input', file])
    console.log(`pushed ${catalog.plugins.length} plugins to ${BRANCH}/${REPO_PATH}`)
  }
} else {
  console.error('usage: publish-arya-catalog.mjs --pull | --push')
  process.exitCode = 2
}
