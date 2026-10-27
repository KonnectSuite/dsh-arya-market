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
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { parseArgs } from 'node:util'
import { fileURLToPath } from 'node:url'
import { get } from 'node:https'
import { compareVersions } from '../lib/updates.js'
import { validateAryaRegistry } from '../lib/arya.js'

const root = fileURLToPath(new URL('..', import.meta.url))
const { values } = parseArgs({ options: {
  tarball: { type: 'string' }, npm: { type: 'string' }, name: { type: 'string' }, source: { type: 'string' },
  description: { type: 'string' }, 'description-zh': { type: 'string' }, publish: { type: 'boolean', default: false },
} })
const fromNpm = values.npm !== undefined
if ((values.tarball === undefined && !fromNpm) || values.source === undefined || !/^KonnectSuite\/[A-Za-z0-9._-]+$/.test(values.source)) {
  throw new Error('Use --npm <version> --source KonnectSuite/<repository> [--description <text> --description-zh <text>], or --tarball <packed file> instead of --npm')
}

/** Run a command and return its stdout. */
function run(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8', windowsHide: true })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`${command} failed: ${result.stderr}`)
  return result.stdout.trim()
}

/** Fetch a URL as text. */
function fetchText(url) {
  return new Promise((resolvePromise, reject) => {
    get(url, response => {
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

catalog.updated = new Date().toISOString()
mkdirSync(dirname(catalogPath), { recursive: true })
writeFileSync(catalogPath, `${JSON.stringify(catalog, null, 2)}\n`, 'utf8')
console.log(`${fromNpm ? 'Recorded' : values.publish ? 'Published' : 'Prepared'} ${name}@${version} (${sha256})${fromNpm ? ' from the registry' : ''}`)
