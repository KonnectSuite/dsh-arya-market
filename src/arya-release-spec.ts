/** Identities of checksum-verified Arya release files in a profile cache. */
export interface CachedAryaRelease {
  version: string
  sha256: string
}

/** Content-addressed file name for a published package. */
export function aryaReleaseFile(name: string, release: CachedAryaRelease): string {
  return `${name.replace(/^@/, '').replaceAll('/', '-')}-${release.version}-${release.sha256}.tgz`
}

/** Recognize a market-owned release cache spec instead of a development checkout. */
export function isAryaReleaseSpec(plugin: { name: string; releases?: CachedAryaRelease[] }, spec: string): boolean {
  if (!spec.startsWith('file:')) return false
  const normalized = spec.replaceAll('\\', '/')
  return plugin.releases?.some(release => normalized.endsWith(`/.dsh-market/releases/${aryaReleaseFile(plugin.name, release)}`)) === true
}

/** A bare (or caret/tilde) version spec, as pnpm writes back after a registry install. */
const BARE_VERSION_RE = /^[\^~]?\s*v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/

/** A published release as the catalog records it. */
export interface PublishedRelease {
  version: string
  tarball?: string
}

/**
 * Whether a manifest spec already names one of this entry's released builds.
 *
 * A release installs from its tarball URL or from the cache file the market
 * staged, but pnpm rewrites the manifest to the version it resolved — so a
 * plugin that came from this catalog is stored as `0.114.0` or `^0.114.0`.
 * Treating only the tarball URL as "the same published source" made that
 * rewrite permanent: the next update asked for "a released version explicitly",
 * which the update dialog never sends, so the plugin could never move again.
 * @param plugin - Catalog entry whose releases were published.
 * @param spec - Dependency spec as the profile records it.
 * @returns true when the spec resolves to a version this entry published.
 */
export function isPublishedReleaseSpec(plugin: { releases?: PublishedRelease[] }, spec: string): boolean {
  if (plugin.releases?.some(release => release.tarball === spec) === true) return true
  const version = BARE_VERSION_RE.exec(spec)?.[1]
  return version !== undefined && plugin.releases?.some(release => release.version === version) === true
}

