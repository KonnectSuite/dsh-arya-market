#!/usr/bin/env node
/**
 * Release one Arya plugin, all the way to the catalogue users actually read.
 *
 * A version bump is not a release. Four things have to be true at the same time,
 * and the fourth one is the one that kept going missing:
 *
 *   1. `npm view <name>@<version> version` prints the version;
 *   2. the `catalog` branch lists it;
 *   3. the entry's `releases[0].sha256` equals the hash of the tarball npm serves;
 *   4. `check-catalogue-parity.mjs` exits 0.
 *
 * Running those four by hand is a six-step ritual with six places to stop, which
 * is why a plugin could be hot-copied into a profile, look updated on one machine,
 * and never reach anyone else. This command is the ritual, and it exits non-zero
 * unless all four are true.
 *
 * Usage, from inside a plugin repository:
 *   node ../dsh-arya-market/scripts/release-plugin.mjs
 *   node ../dsh-arya-market/scripts/release-plugin.mjs --dry-run
 *   node ../dsh-arya-market/scripts/release-plugin.mjs --dir ../dsh-local-llm
 *   node ../dsh-arya-market/scripts/release-plugin.mjs --allow-dirty --skip-tests
 *   node ../dsh-arya-market/scripts/release-plugin.mjs --register --description-zh '…'
 *
 * Exit codes: 0 released and verified, 1 a gate failed, 2 refused before doing
 * anything (nothing was published).
 *
 * What it will NOT do: publish an archive that is not an installable bundle,
 * rewrite a version npm already serves with different bytes, hand-edit
 * `data/arya-plugins.json`, or touch the `catalog` branch itself (the reconciler
 * owns that).
 */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { fetchBytes, inspectArchive, inspectRegistryRelease, run } from './lib/archive.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const REPO = 'KonnectSuite/dsh-arya-market'
const BRANCH = 'catalog'
const REPO_PATH = 'data/arya-plugins.json'
const MANIFEST = join(ROOT, 'arya-plugins.json')
const MAX_RELEASE_BYTES = 64 * 1024 * 1024
const REGISTRY = 'https://registry.npmjs.org'

class Refused extends Error {}
class Failed extends Error {}

// Every refusal and every failed gate leaves through here: one sentence in the
// same voice as the rest of the output, and the documented exit code. A raw stack
// trace after twenty lines of build log reads as a crash, not as "nothing was
// published, fix this one thing".
const fail = error => {
  const message = error instanceof Error ? error.message : String(error)
  console.error(`release: ${message}`)
  process.exit(error instanceof Refused ? 2 : 1)
}
process.on('uncaughtException', fail)
process.on('unhandledRejection', fail)

// A typo in the flags is the same kind of answer as any other refusal: nothing
// was published, here is the one thing to fix.
let options
try {
  ;({ values: options } = parseArgs({ options: {
    dir: { type: 'string' },
    'dry-run': { type: 'boolean', default: false },
    'allow-dirty': { type: 'boolean', default: false },
    'skip-build': { type: 'boolean', default: false },
    'skip-tests': { type: 'boolean', default: false },
    'no-sync': { type: 'boolean', default: false },
    register: { type: 'boolean', default: false },
    'description-zh': { type: 'string' },
    'dist-tag': { type: 'string', default: 'latest' },
    timeout: { type: 'string', default: '180000' },
  } }))
} catch (error) {
  fail(new Refused(`${error instanceof Error ? error.message : String(error)} — see the usage block at the top of this file`))
}

const dryRun = options['dry-run']
const timeoutMs = Number(options.timeout)

const log = message => console.log(`release: ${message}`)
const step = message => console.log(`\n== ${message}`)

function command(args, cwd) {
  const result = spawnSync(args[0], args.slice(1), {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  if (result.error) throw new Failed(`${args.join(' ')} could not run: ${result.error.message}`)
  return { status: result.status ?? 1, stdout: (result.stdout ?? '').trim(), stderr: (result.stderr ?? '').trim() }
}

function must(args, cwd, what) {
  const result = command(args, cwd)
  if (result.status !== 0) {
    throw new Failed(`${what} failed:\n${[result.stdout, result.stderr].filter(Boolean).join('\n')}`)
  }
  return result.stdout
}

function interactive(args, cwd, what) {
  const result = spawnSync(args[0], args.slice(1), { cwd, stdio: 'inherit', windowsHide: true })
  if (result.status !== 0) throw new Failed(`${what} failed (exit ${String(result.status)})`)
}

function gh(args) {
  const result = command(['gh', ...args], ROOT)
  if (result.status !== 0) throw new Failed(`gh ${args[0] ?? ''} failed: ${result.stderr}`)
  return result.stdout
}

/**
 * npm without a shell.
 *
 * `spawnSync('npm', …)` fails on Windows: npm is `npm.cmd`, and a `.cmd` is not an
 * executable there. The CLI's JavaScript entry point is portable, so resolve that
 * and run it with the same node that is running this script.
 */
function npmCli() {
  const fromEnv = process.env.npm_execpath
  if (typeof fromEnv === 'string' && /npm-cli\.js$/.test(fromEnv) && existsSync(fromEnv)) return fromEnv
  const besideNode = join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js')
  if (existsSync(besideNode)) return besideNode
  const roaming = join(process.env.APPDATA ?? '', 'npm', 'node_modules', 'npm', 'bin', 'npm-cli.js')
  if (existsSync(roaming)) return roaming
  return undefined
}

const NPM_CLI = npmCli()

function npmCommand(args, cwd, what) {
  if (NPM_CLI === undefined) throw new Failed('cannot find npm-cli.js next to node; run the release with npm on PATH')
  return command([process.execPath, NPM_CLI, ...args], cwd)
}

function npmMust(args, cwd, what) {
  const result = npmCommand(args, cwd, what)
  if (result.status !== 0) {
    throw new Failed(`${what} failed:\n${[result.stdout, result.stderr].filter(Boolean).join('\n')}`)
  }
  return result.stdout
}

function npmInteractive(args, cwd, what) {
  if (NPM_CLI === undefined) throw new Failed('cannot find npm-cli.js next to node; run the release with npm on PATH')
  const result = spawnSync(process.execPath, [NPM_CLI, ...args], { cwd, stdio: 'inherit', windowsHide: true })
  if (result.error) throw new Failed(`${what} could not run: ${result.error.message}`)
  if (result.status !== 0) throw new Failed(`${what} failed (exit ${String(result.status)})`)
}

/** The catalogue the `catalog` branch serves — the authority, not the CDN copy. */
function readBranchCatalog() {
  const body = JSON.parse(gh(['api', `repos/${REPO}/contents/${REPO_PATH}?ref=${BRANCH}`]))
  const text = Buffer.from(body.content, 'base64').toString('utf8')
  return JSON.parse(text)
}

const sleep = ms => new Promise(resolvePromise => setTimeout(resolvePromise, ms))

async function poll(what, attempt, { everyMs = 3000, withinMs = timeoutMs } = {}) {
  const deadline = Date.now() + withinMs
  let last = 'no answer yet'
  for (;;) {
    try {
      const answer = await attempt()
      if (answer !== undefined) return answer
    } catch (error) {
      last = error instanceof Error ? error.message : String(error)
    }
    if (Date.now() >= deadline) throw new Failed(`${what} did not happen within ${String(Math.round(withinMs / 1000))}s (last: ${last})`)
    await sleep(everyMs)
  }
}

// ---------------------------------------------------------------- the package

const directory = resolve(options.dir ?? process.cwd())
const manifestPath = join(directory, 'package.json')
if (!existsSync(manifestPath)) throw new Refused(`${directory} has no package.json — run this from a plugin repository`)
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8').replace(/^\uFEFF/, ''))
const { name, version } = manifest
if (typeof name !== 'string' || name === '') throw new Refused('package.json has no name')
if (typeof version !== 'string' || !/^\d+\.\d+\.\d+(?:-[\w.]+)?$/.test(version)) {
  throw new Refused(`package.json version "${String(version)}" is not a semver release`)
}
if (manifest.private === true) throw new Refused(`${name} is private: true — nothing to publish`)
if (manifest.dsh?.bundle?.patch === undefined) {
  throw new Refused(`${name} has no dsh.bundle.patch — only an installable plugin bundle can be listed`)
}
if (manifest.dsh?.engines?.dsh === undefined) {
  throw new Refused(
    `${name} does not declare dsh.engines.dsh — without it the market card shows "Host requirement unknown"\n`
    + '  add:  "dsh": { "engines": { "dsh": "^0.2.1-rc.3 || ^0.2.2-alpha.2" } }',
  )
}
if (manifest.repository?.url === undefined) {
  throw new Refused(`${name} has no repository.url — the catalogue records the repository and cannot be built from an empty value`)
}
const sourceRepo = String(manifest.repository.url)
  .replace(/^git\+/, '')
  .replace(/^https:\/\/github\.com\//, '')
  .replace(/\.git$/, '')
if (!/^[\w.-]+\/[\w.-]+$/.test(sourceRepo)) throw new Refused(`repository.url "${String(manifest.repository.url)}" does not name a GitHub repository`)

step(`${name}@${version} from ${directory}`)

// ------------------------------------------------------------- git state

const insideGit = command(['git', 'rev-parse', '--is-inside-work-tree'], directory)
if (insideGit.status !== 0 || insideGit.stdout !== 'true') throw new Refused(`${directory} is not a git repository`)
const branch = command(['git', 'rev-parse', '--abbrev-ref', 'HEAD'], directory).stdout
const dirty = command(['git', 'status', '--porcelain'], directory).stdout
if (dirty !== '' && !options['allow-dirty']) {
  const lines = dirty.split(/\r?\n/)
  throw new Refused(
    `${name} has ${String(lines.length)} uncommitted path(s); a release must be reproducible from a commit\n`
    + `${lines.slice(0, 8).map(line => `  ${line}`).join('\n')}\n`
    + '  commit them, or pass --allow-dirty when the tree really is what you mean to publish',
  )
}
if (dirty !== '') log(`warning: publishing an uncommitted tree (${String(dirty.split(/\r?\n/).length)} path(s))`)
const defaultRef = command(['git', 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], directory)
const defaultBranch = defaultRef.status === 0 ? defaultRef.stdout.replace(/^origin\//, '') : '(unknown)'
if (defaultBranch !== '(unknown)' && branch !== defaultBranch) {
  log(`warning: on branch "${branch}", not "${defaultBranch}" — the catalogue records the repository, so a version published from a branch is not on the default branch`)
}

// ---------------------------------------------------------------- the build

const scripts = manifest.scripts ?? {}
if (options['skip-build'] === true) {
  log('build skipped by --skip-build (a repository with its own pipeline, e.g. assemble, publishes first)')
} else if (typeof scripts.build === 'string') {
  step('build')
  npmInteractive(['run', 'build'], directory, 'npm run build')
} else {
  log('no build script — using the committed output as-is')
}

if (typeof scripts.test === 'string' && options['skip-tests'] !== true) {
  step('test')
  npmInteractive(['test'], directory, 'npm test')
} else if (options['skip-tests'] === true) {
  log('tests skipped by --skip-tests')
}

// ---------------------------------------------------------------- the archive

step('pack')
const scratch = mkdtempSync(join(tmpdir(), 'arya-release-'))
const packed = npmMust(['pack', '--ignore-scripts', '--pack-destination', scratch], directory, 'npm pack')
const tarball = resolve(scratch, packed.split(/\r?\n/).filter(Boolean).at(-1))
const bytes = readFileSync(tarball)
const sha256 = createHash('sha256').update(bytes).digest('hex')
if (bytes.length > MAX_RELEASE_BYTES) {
  throw new Refused(`${tarball} is ${String(bytes.length)} bytes; the market refuses more than 64 MiB`)
}
const paths = must(['tar', '-tzf', tarball], directory, 'tar -tzf').split(/\r?\n/).filter(Boolean)
const packedManifest = JSON.parse(must(['tar', '-xOf', tarball, 'package/package.json'], directory, 'tar -xOf'))
inspectArchive(paths, packedManifest, tarball)
if (packedManifest.name !== name || packedManifest.version !== version) {
  throw new Refused(`the archive is ${String(packedManifest.name)}@${String(packedManifest.version)}, expected ${name}@${version}`)
}
log(`${String(paths.length)} files, ${String(Math.round(bytes.length / 1024))} KiB, sha256 ${sha256.slice(0, 12)}…`)

// ------------------------------------------------------------- the registry

step('registry')
let alreadyPublished = false
let localPackDiffers = false
const registryTarball = `${REGISTRY}/${name}/-/${name.slice(name.lastIndexOf('/') + 1)}-${version}.tgz`
const existing = npmCommand(['view', `${name}@${version}`, 'version'], directory, 'npm view')
if (existing.status === 0 && existing.stdout !== '') {
  const published = await inspectRegistryRelease(name, version, join(scratch, 'registry'))
  if (published.sha256 === sha256) {
    alreadyPublished = true
    log(`${name}@${version} is already on the registry with these exact bytes — nothing to publish`)
  } else {
    // Some builds are not byte-reproducible (a generated file stamps the time), so
    // packing the same source twice gives two hashes. The catalogue has to describe
    // the bytes npm serves, never this machine's pack, so the published copy wins and
    // the version is still never rewritten: skipping the publish is the whole guard.
    alreadyPublished = true
    localPackDiffers = true
    log(`${name}@${version} is already on the registry with different bytes (registry ${published.sha256.slice(0, 12)}…, this pack ${sha256.slice(0, 12)}…)`)
    log('  nothing is published: a version is immutable, and the catalogue records the registry copy')
  }
}

if (alreadyPublished === false) {
  if (dryRun) {
    log(`would run: npm publish ${tarball} --access public --tag ${options['dist-tag']}`)
  } else {
    step(`publish (${options['dist-tag']})`)
    npmInteractive(['publish', tarball, '--access', 'public', '--tag', options['dist-tag'], '--ignore-scripts'], directory, 'npm publish')
    await poll(`registry to serve ${name}@${version}`, async () => {
      await fetchBytes(registryTarball)
      return true
    }, { everyMs: 2500 })
    log(`registry serves ${name}@${version}`)
  }
}

// -------------------------------------------------------------- the catalogue

if (options['no-sync'] === true) {
  log('catalogue left to the 15-minute sync job (--no-sync)')
} else if (dryRun) {
  log(`would run: node scripts/reconcile-catalogue.mjs --only ${name}`)
} else {
  step('catalogue')
  interactive(['node', 'scripts/reconcile-catalogue.mjs', '--only', name], ROOT, 'the catalogue reconciler')
}

// ------------------------------------------------------------ registration

const manifestNow = JSON.parse(readFileSync(MANIFEST, 'utf8').replace(/^\uFEFF/, ''))
const listed = manifestNow.plugins.some(plugin => plugin.name === name)
if (listed === false) {
  if (options.register !== true) {
    throw new Refused(
      `${name} is published but arya-plugins.json does not name it, so nothing records its repository\n`
      + `  add it with: --register --description-zh '卡片上的中文说明'\n`
      + `  (this is the "in the catalog but not the manifest" failure sync-arya-sources reports)`,
    )
  }
  const descriptionZh = options['description-zh']
  if (typeof descriptionZh !== 'string' || descriptionZh.trim() === '' || /[\u4E00-\u9FFF]/.test(descriptionZh) === false) {
    throw new Refused('--register needs --description-zh with a Chinese sentence for the card')
  }
  const english = typeof manifest.description === 'string' ? manifest.description.trim() : ''
  if (english === '') throw new Refused('--register reads the English description from package.json description, which is empty')
  manifestNow.plugins.push({
    name,
    channel: 'market',
    repo: sourceRepo,
    workspace: directory.split(/[\\/]/).at(-1),
    description: { en: english, zh: descriptionZh.trim() },
  })
  manifestNow.plugins.sort((a, b) => a.name.localeCompare(b.name))
  if (dryRun) {
    log(`would add ${name} to arya-plugins.json`)
  } else {
    writeFileSync(MANIFEST, `${JSON.stringify(manifestNow, null, 2)}\n`, 'utf8')
    interactive(['node', 'scripts/sync-arya-sources.mjs'], ROOT, 'sync-arya-sources')
    log(`registered ${name} in arya-plugins.json`)
  }
}

// ------------------------------------------------------------- verification

step('verify')
if (dryRun) {
  log('dry run: nothing was published, so there is nothing to verify')
  log(`receipt would be: released ${name}@${version} · npm ok · catalogue ok · sha256 ${sha256.slice(0, 12)}`)
  process.exit(0)
}

const entry = await poll(`the catalogue branch to list ${name}@${version}`, async () => {
  const catalog = readBranchCatalog()
  const found = catalog.plugins.find(plugin => plugin.name === name)
  if (found === undefined) return undefined
  const top = found.releases?.[0]
  if (top === undefined || top.version !== version) return undefined
  return found
})

const recorded = entry.releases[0]
await poll(`${recorded.tarball} to answer 200`, async () => {
  const served = await fetchBytes(recorded.tarball)
  const servedSha = createHash('sha256').update(served).digest('hex')
  if (servedSha !== recorded.sha256) {
    throw new Failed(
      `the catalogue records ${String(recorded.sha256).slice(0, 12)}… but ${recorded.tarball} hashes to ${servedSha.slice(0, 12)}…\n`
      + '  the entry describes bytes nobody can download: node scripts/reconcile-catalogue.mjs',
    )
  }
  if (localPackDiffers === true) log(`the catalogue records the registry copy (${servedSha.slice(0, 12)}…), not this machine's pack (${sha256.slice(0, 12)}…)`)
  return true
})

const parity = command(['node', 'scripts/check-catalogue-parity.mjs'], ROOT)
if (parity.status !== 0) {
  throw new Failed(`check-catalogue-parity.mjs exits ${String(parity.status)}:\n${[parity.stdout, parity.stderr].filter(Boolean).join('\n')}`)
}

console.log(`\nreleased ${name}@${version} · npm ok · catalogue ok · sha256 ${recorded.sha256.slice(0, 12)}`)
console.log(`  live catalogue: https://raw.githubusercontent.com/${REPO}/${BRANCH}/${REPO_PATH}`)
console.log(`  installed profiles update on their next check; a catalogue install sidesteps the 24-hour npm window`)
if (branch !== defaultBranch && defaultBranch !== '(unknown)') {
  console.log(`  warning: published from branch "${branch}", not "${defaultBranch}" — merge it`)
}
