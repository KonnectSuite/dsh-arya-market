#!/usr/bin/env node
/**
 * Append one release of an Arya plugin to the catalog, from a local tarball or
 * from the registry.
 *
 * Two sources, one catalog entry shape:
 *
 *   --tarball <file>   uploads the archive to a `dsh-arya-market` release and
 *                      points the entry at that asset (the installer-era shape)
 *   --npm <version>    downloads the published registry tarball, verifies it and
 *                      points the entry at `registry.npmjs.org`, which is what
 *                      every other entry in this catalog uses
 */
import { createHash } from 'node:crypto'
import { mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { parseArgs } from 'node:util'
import { fileURLToPath } from 'node:url'
import { get } from 'node:https'

const REPO = 'KonnectSuite/dsh-arya-market'
const BRANCH = 'catalog'
const REPO_PATH = 'data/arya-plugins.json'
const LIVE = `https://raw.githubusercontent.com/${REPO}/${BRANCH}/${REPO_PATH}`

/**
 * The two validators this script shares with the running market.
 *
 * Imported dynamically, and only after a build exists: the publish path is
 * the one place a release can quietly diverge from what the market will
 * accept, so "run npm run build first" has to be a sentence rather than a
 * MODULE_NOT_FOUND stack from a script that was supposed to be the guard.
 */
let compareVersions
let validateAryaRegistry
try {
  ;({ compareVersions } = await import('../lib/updates.js'))
  ;({ validateAryaRegistry } = await import('../lib/arya.js'))
} catch (error) {
  console.error(`publish: cannot load the built validators (${error instanceof Error ? error.message : String(error)})`)
  console.error('publish: run `npm run build` first, or use `npm run publish:arya`, which builds.')
  process.exit(2)
}

const root = fileURLToPath(new URL('..', import.meta.url))
const { values } = parseArgs({ options: {
  tarball: { type: 'string' }, npm: { type: 'string' }, name: { type: 'string' }, source: { type: 'string' },
  description: { type: 'string' }, 'description-zh': { type: 'string' }, publish: { type: 'boolean', default: false },
  /**
   * Finish the release: pull the branch first, record, push, then prove the
   * branch serves the version and digest. Three steps that used to be three
   * commands and one memory — and the forgotten one was always the last.
   */
  push: { type: 'boolean', default: false },
  /** Check what the branch serves for this release without writing or pushing. */
  verify: { type: 'boolean', default: false },
} })
const fromNpm = values.npm !== undefined
if ((values.tarball === undefined && !fromNpm) || values.source === undefined || !/^KonnectSuite\/[A-Za-z0-9._-]+$/.test(values.source)) {
  throw new Error('Use --npm <version> --source KonnectSuite/<repository> [--description <text> --description-zh <text>], or --tarball <packed file> instead of --npm')
}
if (values.push && values.verify) throw new Error('--push already verifies; use one or the other')

/** Run a command and return its stdout. */
function run(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8', windowsHide: true })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`${command} failed: ${result.stderr}`)
  return result.stdout.trim()
}

/** Fetch a URL as text. */
function fetchText(url, headers = { 'user-agent': 'dsh-arya-market/publish' }) {
  return new Promise((resolvePromise, reject) => {
    get(url, { headers }, response => {
      if (response.statusCode !== 200) {
        reject(new Error(`${url} returned ${String(response.statusCode)}`))
        response.resume()
        return
      }
      let text = ''
      response.setEncoding('utf8')
      response.on('data', chunk => { text += chunk })
      response.on('end', () => resolvePromise(text))
    }).on('error', reject)
  })
}

/** Download a URL into memory. */
function fetchBytes(url) {
  return new Promise((resolvePromise, reject) => {
    get(url, response => {
      if (response.statusCode !== 200) {
        reject(new Error(`${url} returned ${String(response.statusCode)}`))
        response.resume()
        return
      }
      const chunks = []
      response.on('data', chunk => chunks.push(chunk))
      response.on('end', () => resolvePromise(Buffer.concat(chunks)))
    }).on('error', reject)
  })
}

/**
 * The catalog the `catalog` branch serves right now, via the API.
 *
 * Not the raw URL: that one sits behind a CDN that answers from cache for
 * minutes, so a verification built on it would report the previous copy as
 * this release's. The raw URL is still checked separately, as the freshness
 * question it actually is.
 *
 * `node:https` rather than global `fetch` on purpose: importing the built
 * market validators loads undici, whose dispatcher and the runtime's bundled
 * one do not have to agree, and a verification that throws
 * `assert(dispatcher)` would read as "the branch is missing the release".
 *
 * `gh api` first when it is available: the publish path already needs it for
 * the push, and it is authenticated, so the check is not the request that
 * happens to land on the anonymous rate limit.
 */
async function readBranchCatalog() {
  const path = `repos/${REPO}/contents/${REPO_PATH}?ref=${BRANCH}`
  let text
  try {
    text = run('gh', ['api', path])
  } catch {
    // No gh, or it is not signed in: the API is public, just rate-limited.
    text = await fetchText(`https://api.github.com/${path}`, {
      'user-agent': 'dsh-arya-market/publish',
      accept: 'application/vnd.github+json',
    })
  }
  return JSON.parse(Buffer.from(JSON.parse(text).content, 'base64').toString('utf8'))
}

/**
 * Poll the branch until it lists this release with this digest.
 *
 * GitHub's contents API is strongly consistent enough for this and, unlike the
 * CDN, cannot answer with the catalog from before the push. A push whose entry
 * does not arrive is the failure that used to be discovered by a user, days
 * later, as "the update never showed up".
 */
async function waitForBranch(name, version, sha256, timeoutMs = 120_000) {
  let detail = 'not checked'
  const started = Date.now()
  for (;;) {
    try {
      const catalog = await readBranchCatalog()
      const entry = catalog.plugins?.find(plugin => plugin.name === name)
      const recorded = entry?.releases?.find(release => release.version === version)
      if (entry === undefined) detail = `the branch has no entry for ${name}`
      else if (recorded === undefined) detail = `the branch does not list ${name}@${version}`
      else if (recorded.sha256 !== sha256) detail = `${name}@${version} is on the branch with sha256 ${String(recorded.sha256)}, not ${sha256}`
      else if (entry.version !== entry.releases?.[0]?.version) detail = `${name}: entry.version ${String(entry.version)} disagrees with releases[0] ${String(entry.releases?.[0]?.version)}`
      else return { ok: true, newest: entry.releases?.[0]?.version ?? version }
    } catch (error) {
      detail = error instanceof Error ? error.message : String(error)
    }
    if (Date.now() - started > timeoutMs) return { ok: false, detail }
    await new Promise(done => setTimeout(done, 3000))
  }
}

/** Refuse an archive that carries credentials or unresolved dependency specs. */
function inspect(paths, manifest, archive) {
  if (paths.some(path => /(?:^|\/)(?:\.env(?:\..+)?|credentials\.json|id_rsa|id_ed25519)$/.test(path)))
    throw new Error('Refusing to publish credential or environment files')
  for (const section of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
    if (Object.values(manifest[section] ?? {}).some(value => /^(?:workspace|link|file):/.test(value)))
      throw new Error(`Archive has unresolved ${section} (${archive})`)
  }
  if (manifest.dsh?.bundle?.patch === undefined) throw new Error('Only installable plugin bundles belong in this catalog')
}

let name
let version
let sha256
let fileName
let archiveUrl
let bytes

if (values.push) {
  // The catalog is generated data on its own branch. Recording onto a stale
  // local copy would push an entry that is missing everything that landed
  // since; recording onto NO copy would push only this plugin and delete every
  // other one. That is exactly what --pull exists for, so --push does it
  // instead of hoping the caller remembered.
  run(process.execPath, [resolve(root, 'scripts/publish-arya-catalog.mjs'), '--pull'])
}

if (fromNpm) {
  // The package name comes from the source repository's catalog entry, so a
  // first-time npm release needs --name; an existing entry supplies it.
  const catalogPath = join(root, 'data/arya-plugins.json')
  const existing = JSON.parse(readFileSync(catalogPath, 'utf8'))
  const pluginName = values.name
    ?? existing.plugins.find(plugin => plugin.url === `https://github.com/${values.source}`)?.name
  if (pluginName === undefined) throw new Error('Pass --name <package> for a package with no catalog entry yet')
  const document = JSON.parse(await fetchText(`https://registry.npmjs.org/${encodeURIComponent(pluginName)}`))
  const published = document.versions?.[values.npm]
  if (published === undefined) throw new Error(`${pluginName}@${values.npm} is not published (latest ${String(document['dist-tags']?.latest)})`)
  const tarballUrl = published.dist?.tarball
  if (typeof tarballUrl !== 'string') throw new Error('Registry entry carries no tarball URL')
  bytes = await fetchBytes(tarballUrl)
  const scratch = resolve(root, '.arya-release-artifacts', `${pluginName.replaceAll('/', '-')}-${values.npm}.tgz`)
  mkdirSync(dirname(scratch), { recursive: true })
  writeFileSync(scratch, bytes)
  const paths = run('tar', ['-tzf', scratch]).split(/\r?\n/)
  const manifest = JSON.parse(run('tar', ['-xOf', scratch, 'package/package.json']))
  inspect(paths, manifest, tarballUrl)
  name = manifest.name
  version = manifest.version
  if (name !== pluginName || version !== values.npm) throw new Error(`Registry tarball is ${name}@${version}, expected ${pluginName}@${values.npm}`)
  sha256 = createHash('sha256').update(bytes).digest('hex')
  archiveUrl = tarballUrl
  fileName = basename(new URL(tarballUrl).pathname)
} else {
  const tarball = resolve(values.tarball)
  const paths = run('tar', ['-tzf', tarball]).split(/\r?\n/)
  const manifest = JSON.parse(run('tar', ['-xOf', tarball, 'package/package.json']))
  inspect(paths, manifest, tarball)
  name = manifest.name
  version = manifest.version
  if (typeof name !== 'string' || typeof version !== 'string') throw new Error('Archive has no package identity')
  fileName = `${name.replace(/^@/, '').replaceAll('/', '-')}-${version}.tgz`
  if (basename(tarball) !== fileName) throw new Error(`Archive must be named ${fileName}`)
  const tag = `plugin-${name.replace(/^@/, '').replaceAll('/', '-')}-v${version}`
  archiveUrl = `https://github.com/KonnectSuite/dsh-arya-market/releases/download/${tag}/${fileName}`
  // Digest the exact local archive the GitHub release will carry, so the entry
  // records the bytes the installer downloads and verifies.
  sha256 = createHash('sha256').update(readFileSync(tarball)).digest('hex')
}

const catalogPath = resolve(root, 'data/arya-plugins.json')
let catalog
try { catalog = JSON.parse(readFileSync(catalogPath, 'utf8')) } catch (error) {
  if (error.code !== 'ENOENT') throw error
  catalog = { updated: '', count: 0, categories: { arya: { en: 'Arya', zh: 'Arya' } }, plugins: [] }
}
let plugin = catalog.plugins.find(plugin => plugin.name === name)
if (!plugin) {
  if (!values.description || !values['description-zh']) throw new Error('New entries require English and Chinese descriptions')
  plugin = { name, owner: 'KonnectSuite', url: `https://github.com/${values.source}`, category: 'arya', description: { en: values.description, zh: values['description-zh'] }, added: new Date().toISOString().slice(0, 10), install: '', arya: true, releases: [] }
  catalog.plugins.push(plugin)
}
if (plugin.url !== `https://github.com/${values.source}`) throw new Error('Repository differs from the existing catalog entry')
const old = plugin.releases.find(release => release.version === version)
if (old && old.sha256 !== sha256) throw new Error('Published versions cannot be overwritten; increment the plugin version')
// Same bytes, new host: this is how a release moves from a market asset to the
// registry tarball. A different digest is still refused above.
if (old) old.tarball = archiveUrl
else plugin.releases.push({ version, tarball: archiveUrl, sha256 })
plugin.releases.sort((a, b) => compareVersions(b.version, a.version) ?? 0)
plugin.version = plugin.releases[0].version
plugin.tarball = plugin.releases[0].tarball
catalog.count = catalog.plugins.length
validateAryaRegistry(catalog)

if (values.publish && !fromNpm) {
  const tag = `plugin-${name.replace(/^@/, '').replaceAll('/', '-')}-v${version}`
  const lookup = spawnSync('gh', ['release', 'view', tag, '--repo', 'KonnectSuite/dsh-arya-market', '--json', 'assets,isDraft'], { encoding: 'utf8', windowsHide: true })
  const tarballPath = resolve(values.tarball)
  if (lookup.status !== 0) {
    const bodyPath = resolve(root, '.arya-release-artifacts', `${tag}.md`)
    mkdirSync(dirname(bodyPath), { recursive: true })
    writeFileSync(bodyPath, `${name} ${version}\n\nPackaged from https://github.com/${values.source}.\n\nSHA256: \`${sha256}\`\n`, 'utf8')
    run('gh', ['release', 'create', tag, tarballPath, '--repo', 'KonnectSuite/dsh-arya-market', '--draft', '--latest=false', '--title', `${name} ${version}`, '--notes-file', bodyPath])
  }
  const release = JSON.parse(run('gh', ['release', 'view', tag, '--repo', 'KonnectSuite/dsh-arya-market', '--json', 'assets,isDraft']))
  const asset = release.assets.find(asset => asset.name === fileName)
  if (!asset || asset.digest !== `sha256:${sha256}`) throw new Error('Uploaded archive differs from the verified package; release remains unpublished')
  if (release.isDraft) run('gh', ['release', 'edit', tag, '--repo', 'KonnectSuite/dsh-arya-market', '--draft=false', '--latest=false'])
}

if (!values.verify) {
  // An absent local file means the catalog was never pulled. Recording onto it
  // would write a catalog that contains only this release, and the next
  // `--push` would delete every other entry — the trap `--pull` exists for.
  // `--push` pulls first, so this only refuses the half-done local path.
  if (!existsSync(catalogPath)) {
    throw new Error(`${REPO_PATH} is absent, so there is no catalog to record into. Run with --push (which pulls the branch first), or \`node scripts/publish-arya-catalog.mjs --pull\` and then record.`)
  }
  catalog.updated = new Date().toISOString()
  mkdirSync(dirname(catalogPath), { recursive: true })
  writeFileSync(catalogPath, `${JSON.stringify(catalog, null, 2)}\n`, 'utf8')
  console.log(`${fromNpm ? 'Recorded' : values.publish ? 'Published' : 'Prepared'} ${name}@${version} (${sha256})${fromNpm ? ' from the registry' : ''}`)
}

if (values.push) {
  run(process.execPath, [resolve(root, 'scripts/publish-arya-catalog.mjs'), '--push'])
}

if (values.push || values.verify) {
  // The branch is the authority; the CDN is only ever a delay. Both are
  // checked, and only the first one can fail the command.
  const branch = await waitForBranch(name, version, sha256)
  if (!branch.ok) {
    console.error(`publish: the catalog branch never showed ${name}@${version}: ${branch.detail}`)
    console.error('publish: the release is NOT visible to users. Re-run with --verify once the push is understood.')
    process.exitCode = 1
  } else {
    let live = false
    try {
      const served = JSON.parse(await fetchText(`${LIVE}?v=${String(Date.now())}`))
      live = served.plugins?.some(plugin => plugin.name === name && plugin.releases?.some(release => release.version === version)) === true
    } catch {
      /* freshness is a note, never a verdict */
    }
    console.log(`publish: the branch serves ${name}@${version} with sha256 ${sha256}`)
    if (branch.newest !== version) console.log(`publish: note — the branch's newest release is ${branch.newest}, so the market offers that one`)
    console.log(live
      ? 'publish: the live catalog already serves it — users see it now'
      : 'publish: the live catalog URL is still serving the previous copy (CDN, minutes); the branch is correct, so users catch up on their own')
  }
} else {
  console.log('not pushed: the catalog branch was not touched, so users still see the previous version.')
  console.log('publish: re-run with --push (pull, record, push, verify), or `npm run publish:arya:catalog`.')
}
