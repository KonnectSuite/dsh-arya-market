/**
 * Archive checks shared by every path that can put a package in the catalog.
 *
 * `publish-arya-release.mjs` records one release; `reconcile-catalogue.mjs`
 * records whatever npm has moved on to. Both download a tarball and both must
 * refuse the same things, so the rules live here once: two copies of a publish
 * guard drift, and the copy nobody updated is the one that lets a broken
 * archive through.
 */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { get } from 'node:https'

/** Run a command and return its stdout, or throw with stderr attached. */
export function run(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8', windowsHide: true })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`${command} failed: ${result.stderr}`)
  return result.stdout.trim()
}

/** Download a URL into memory, following one redirect (npm does not need it, GH does). */
export function fetchBytes(url, redirects = 2) {
  return new Promise((resolvePromise, reject) => {
    get(url, { headers: { 'user-agent': 'dsh-arya-market/reconcile' } }, response => {
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location !== undefined && redirects > 0) {
        response.resume()
        fetchBytes(new URL(response.headers.location, url).toString(), redirects - 1).then(resolvePromise, reject)
        return
      }
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

/** Fetch a URL as text. */
export function fetchText(url, headers = { 'user-agent': 'dsh-arya-market/reconcile' }) {
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

/**
 * Refuse an archive that carries credentials or unresolved dependency specs.
 *
 * `dsh.bundle.patch` is what makes it a plugin the host can compose; a
 * `workspace:` / `link:` / `file:` dependency is a monorepo spec that cannot
 * resolve in someone else's profile (`@aryacode/dsh-client-ui-release-notes`
 * is published for exactly that reason and cannot be listed).
 */
export function inspectArchive(paths, manifest, archive) {
  if (paths.some(path => /(?:^|\/)(?:\.env(?:\..+)?|credentials\.json|id_rsa|id_ed25519)$/.test(path))) {
    throw new Error('Refusing to publish credential or environment files')
  }
  for (const section of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
    const values = Object.values(manifest[section] ?? {})
    const unresolved = values.find(value => typeof value === 'string' && /^(?:workspace|link|file):/.test(value))
    if (unresolved !== undefined) throw new Error(`Archive has unresolved ${section} (${archive})`)
  }
  if (manifest.dsh?.bundle?.patch === undefined) throw new Error('Only installable plugin bundles belong in this catalog')
}

/**
 * Download, verify and identify one published archive.
 *
 * @returns {{ name: string, version: string, tarball: string, sha256: string }}
 * @throws when the archive is not an installable bundle or does not identify as the expected package.
 */
export async function inspectRegistryRelease(packageName, version, scratchRoot) {
  // The registry serves a scoped tarball at the UNENCODED path, and the catalog
  // validator requires exactly that shape (`/@scope/name/-/name-version.tgz`),
  // so encoding the scope here would produce a URL the market refuses.
  const tarballUrl = `https://registry.npmjs.org/${packageName}/-/${packageName.slice(packageName.lastIndexOf('/') + 1)}-${version}.tgz`
  const bytes = await fetchBytes(tarballUrl)
  const scratch = resolve(scratchRoot, `${packageName.replaceAll('/', '-')}-${version}.tgz`)
  mkdirSync(dirname(scratch), { recursive: true })
  writeFileSync(scratch, bytes)
  const paths = run('tar', ['-tzf', scratch]).split(/\r?\n/)
  const manifest = JSON.parse(run('tar', ['-xOf', scratch, 'package/package.json']))
  inspectArchive(paths, manifest, tarballUrl)
  if (manifest.name !== packageName || manifest.version !== version) {
    throw new Error(`Registry tarball is ${String(manifest.name)}@${String(manifest.version)}, expected ${packageName}@${version}`)
  }
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  return { name: packageName, version, tarball: tarballUrl, sha256 }
}
