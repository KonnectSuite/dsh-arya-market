#!/usr/bin/env node
/** Publish a packaged Arya plugin and append its version to the catalog. */
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, dirname, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { parseArgs } from 'node:util'
import { fileURLToPath } from 'node:url'
import { compareVersions } from '../lib/updates.js'
import { validateAryaRegistry } from '../lib/arya.js'

const root = fileURLToPath(new URL('..', import.meta.url))
const { values } = parseArgs({ options: {
  tarball: { type: 'string' }, source: { type: 'string' }, description: { type: 'string' },
  'description-zh': { type: 'string' }, publish: { type: 'boolean', default: false },
} })
if (!values.tarball || !values.source || !/^KonnectSuite\/[A-Za-z0-9._-]+$/.test(values.source)) {
  throw new Error('Use --tarball <packed file> --source KonnectSuite/<repository> --description <text> [--description-zh <text>] [--publish]')
}
function run(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8', windowsHide: true })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`${command} failed: ${result.stderr}`)
  return result.stdout.trim()
}
const tarball = resolve(values.tarball)
const paths = run('tar', ['-tzf', tarball]).split(/\r?\n/)
if (paths.some(path => /(?:^|\/)(?:\.env(?:\..+)?|credentials\.json|id_rsa|id_ed25519)$/.test(path))) throw new Error('Refusing to publish credential or environment files')
const manifest = JSON.parse(run('tar', ['-xOf', tarball, 'package/package.json']))
const name = manifest.name
const version = manifest.version
if (typeof name !== 'string' || typeof version !== 'string') throw new Error('Archive has no package identity')
if (!manifest.dsh?.bundle?.patch) throw new Error('Only installable plugin bundles belong in this catalog')
const exported = manifest.exports?.['.']
const entry = (manifest.main ?? (typeof exported === 'string' ? exported : exported?.default))?.replace(/^\.\//, '')
if (!entry || !paths.includes(`package/${entry}`) || !paths.includes(`package/${manifest.dsh.bundle.patch.replace(/^\.\//, '')}`)) throw new Error('Archive is missing its built entry or bundle patch')
for (const section of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
  if (Object.values(manifest[section] ?? {}).some(value => /^(?:workspace|link|file):/.test(value))) throw new Error(`Archive has unresolved ${section}`)
}
const fileName = `${name.replace(/^@/, '').replaceAll('/', '-')}-${version}.tgz`
if (basename(tarball) !== fileName) throw new Error(`Archive must be named ${fileName}`)
const tag = `plugin-${name.replace(/^@/, '').replaceAll('/', '-')}-v${version}`
const archiveUrl = `https://github.com/KonnectSuite/dsh-arya-market/releases/download/${tag}/${fileName}`
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
const bytes = readFileSync(tarball)
const sha256 = createHash('sha256').update(bytes).digest('hex')
const old = plugin.releases.find(release => release.version === version)
if (old && old.sha256 !== sha256) throw new Error('Published versions cannot be overwritten; increment the plugin version')
if (!old) plugin.releases.push({ version, tarball: archiveUrl, sha256 })
plugin.releases.sort((a, b) => compareVersions(b.version, a.version) ?? 0)
plugin.version = plugin.releases[0].version
plugin.tarball = plugin.releases[0].tarball
catalog.count = catalog.plugins.length
validateAryaRegistry(catalog)
if (values.publish) {
  const lookup = spawnSync('gh', ['release', 'view', tag, '--repo', 'KonnectSuite/dsh-arya-market', '--json', 'assets,isDraft'], { encoding: 'utf8', windowsHide: true })
  if (lookup.status !== 0) {
    const bodyPath = resolve(root, '.arya-release-artifacts', `${tag}.md`)
    mkdirSync(dirname(bodyPath), { recursive: true })
    writeFileSync(bodyPath, `${name} ${version}\n\nPackaged from https://github.com/${values.source}.\n\nSHA256: \`${sha256}\`\n`, 'utf8')
    run('gh', ['release', 'create', tag, tarball, '--repo', 'KonnectSuite/dsh-arya-market', '--draft', '--latest=false', '--title', `${name} ${version}`, '--notes-file', bodyPath])
  }
  const release = JSON.parse(run('gh', ['release', 'view', tag, '--repo', 'KonnectSuite/dsh-arya-market', '--json', 'assets,isDraft']))
  const asset = release.assets.find(asset => asset.name === fileName)
  if (!asset || asset.digest !== `sha256:${sha256}` || asset.size !== bytes.length) throw new Error('Uploaded archive differs from the verified package; release remains unpublished')
  if (release.isDraft) run('gh', ['release', 'edit', tag, '--repo', 'KonnectSuite/dsh-arya-market', '--draft=false', '--latest=false'])
}
catalog.updated = new Date().toISOString()
mkdirSync(dirname(catalogPath), { recursive: true })
writeFileSync(catalogPath, `${JSON.stringify(catalog, null, 2)}\n`, 'utf8')
console.log(`${values.publish ? 'Published' : 'Prepared'} ${name}@${version} (${sha256})`)
