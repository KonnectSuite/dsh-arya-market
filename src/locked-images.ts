/**
 * Releasing a plugin's own running engine image so pnpm can swap that package.
 *
 * Windows refuses to delete (or rename over) the image file of a running
 * process, and pnpm's swap does exactly that: it stages the new version in a
 * sibling `<name>_tmp_<pid>_<n>` directory and renames it over the old one,
 * which means removing the old directory first. So an update to a package that
 * ships a standalone engine — `agent-browser-win32-x64.exe`,
 * `agent-desktop-win32-x64.exe` and friends, each started as its own process by
 * the plugin that owns it — fails with `ERR_PNPM_EPERM` while the plugin works
 * perfectly. Measured on a real profile: two failed updates ~64 s apart, the
 * holder a child process of the app started by that plugin's own launcher, and
 * a plain process kill lost the race (the launcher respawned a new engine from
 * the same path within ~6 s, while pnpm needs ~60 s to reach the swap).
 *
 * What Windows DOES allow is renaming that image: the running process keeps its
 * section mapping, and the original name becomes free. Move the image out of
 * the package directory, copy the same bytes back under the original name, and
 * the swap can proceed while the user's engine keeps running and the plugin can
 * still start a fresh one. The moved copy is NOT auto-removed: measured, it
 * opens for reading (so it was never marked delete-pending), unlinking it fails
 * `EPERM` while the process lives, and it is still listed ten seconds after the
 * process exits. It only becomes deletable once that process is gone, and
 * nothing deletes it on its own — so `sweepLockedAside` clears it opportunistically
 * on a later pass rather than the code claiming a tidy it does not have.
 *
 * This is deliberately narrow: only an image file inside
 * `<profile>/node_modules` whose owning process is neither this process nor one
 * of its ancestors, and never a `pnpm*` process. Anything else that produces
 * the same `ERR_PNPM_EPERM` text — a `.node` addon loaded INTO the app itself —
 * cannot be released without exiting, and the caller must not retry that case;
 * the classifier's advice (quit the app) is the honest answer there.
 *
 * Nothing here kills a process. Reading the process list costs ~1-2 s, and it is
 * only ever paid after a run that already failed for this reason.
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, renameSync, unlinkSync } from 'node:fs'
import { basename, extname, join, resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import { logEvent } from './log.ts'

/** A process holding an image file inside the profile's `node_modules`. */
export type LockedImage = { pid: number, name: string, path: string }

/**
 * Extensions whose file Windows maps as an image section, i.e. the ones a
 * running process locks against deletion. A data file a process merely has
 * open is usually releasable by other means and is not what blocks a swap.
 */
const IMAGE_EXTENSIONS = new Set(['.exe', '.dll', '.node'])

/** Bound the work: a profile with more than this many live engine images is a
 *  diagnosis problem, not something to move one by one inside an install. */
const MAX_IMAGES = 24

/** The scratch home for a moved image — deliberately OUTSIDE `node_modules`, so
 *  pnpm's prune, its swap and its `.ignored` quarantine never see it. */
export function lockedAsideDir(profileDirectory: string): string {
  return join(profileDirectory, '.dsh-market', 'locked-aside')
}

/**
 * The processes whose executable image lives under `<profileDirectory>/node_modules`.
 *
 * The ancestor chain of `ownPid` is collected in the same pass so the caller can
 * refuse to move the image of the very process running this code (the app hosts
 * the market, and its own loaded modules are under `node_modules` too — moving
 * those is a risk this helper has no reason to take) or any of its parents.
 *
 * Returns an empty list on a platform that has no image locking, and on ANY
 * failure: a recovery hook that throws would fail the user's command for a
 * repair that was optional to begin with.
 */
export function findLockedImagesUnder(profileDirectory: string, ownPid: number = process.pid): LockedImage[] {
  if (process.platform !== 'win32') return []
  const root = resolve(profileDirectory)
  const self = Number.isSafeInteger(ownPid) && ownPid > 0 ? ownPid : process.pid
  const script = [
    '$ErrorActionPreference = \'SilentlyContinue\'',
    `$chain = @(); $cur = ${self}; while ($cur -gt 0 -and $chain.Count -lt 40) { $chain += $cur; $parent = (Get-CimInstance Win32_Process -Filter "ProcessId=$cur").ParentProcessId; if ($null -eq $parent) { break }; $cur = [int]$parent }`,
    '$procs = @(Get-CimInstance Win32_Process | Where-Object { $null -ne $_.ExecutablePath } | ForEach-Object { [pscustomobject]@{ pid = $_.ProcessId; name = $_.Name; path = $_.ExecutablePath } })',
    '@{ chain = @($chain); procs = $procs } | ConvertTo-Json -Compress -Depth 4',
  ].join('\n')
  let parsed: { chain?: unknown, procs?: unknown } | null = null
  try {
    const out = execFileSync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { encoding: 'utf8', timeout: 20000, maxBuffer: 32 * 1024 * 1024, windowsHide: true },
    )
    parsed = JSON.parse(out.trim()) as { chain?: unknown, procs?: unknown }
  } catch (error) {
    // A machine where CIM is unavailable, or a PowerShell that refused to start:
    // there is nothing to release as far as this install is concerned.
    logEvent('warn', 'install', `could not list processes for a locked-package repair: ${String(error)}`)
    return []
  }
  const chain = new Set((Array.isArray(parsed?.chain) ? parsed!.chain : []).map(Number).filter(Number.isFinite))
  chain.add(self)
  const rows = Array.isArray(parsed?.procs) ? parsed!.procs : parsed?.procs ? [parsed!.procs] : []
  const under = `${resolve(root, 'node_modules').toLowerCase()}\\`
  const found: LockedImage[] = []
  for (const row of rows) {
    const entry = row as { pid?: unknown, name?: unknown, path?: unknown }
    const pid = Number(entry?.pid)
    const path = typeof entry?.path === 'string' ? entry.path : ''
    const name = typeof entry?.name === 'string' ? entry.name : basename(path)
    if (!Number.isSafeInteger(pid) || path === '') continue
    if (chain.has(pid)) continue
    if (/^pnpm/i.test(name)) continue
    if (!IMAGE_EXTENSIONS.has(extname(path).toLowerCase())) continue
    // Case-insensitive on Windows, and anchored on the separator so a sibling
    // directory whose name merely starts with 'node_modules' is not swept in.
    if (!resolve(path).toLowerCase().startsWith(under)) continue
    found.push({ pid, name, path })
    if (found.length >= MAX_IMAGES) break
  }
  return found
}

/**
 * Move each image out of the package directory and put the same bytes back
 * under its original name, so the swap target no longer contains a file no one
 * may delete while the plugin keeps a readable engine.
 *
 * A file that could not be moved is left exactly as it was; a file that moved
 * but could not be restored under its original name is reported in `lost` —
 * that is the one case where the plugin cannot start a NEW engine until the
 * swap lands, and the caller has to say so rather than stay quiet.
 */
export function releaseImages(images: LockedImage[], scratchDir: string): { released: LockedImage[], lost: LockedImage[] } {
  const released: LockedImage[] = []
  const lost: LockedImage[] = []
  if (images.length === 0) return { released, lost }
  try {
    mkdirSync(scratchDir, { recursive: true })
  } catch {
    // No scratch home means no move: report nothing as released and let the
    // caller fall back to the classifier's advice.
    return { released, lost: images }
  }
  for (const image of images) {
    const ext = extname(image.path)
    const stamp = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
    const scratch = join(scratchDir, `${basename(image.path, ext)}-${image.pid}-${stamp}${ext}`)
    try {
      renameSync(image.path, scratch)
    } catch (error) {
      logEvent('warn', 'install', `could not move the running image ${image.path} (pid ${image.pid}) aside: ${String(error)}`)
      continue
    }
    let restored = false
    try {
      copyFileSync(scratch, image.path)
      restored = true
    } catch {
      try {
        renameSync(scratch, image.path)
        restored = true
      } catch (back) {
        logEvent('warn', 'install', `moved ${image.path} aside but could not put it back: ${String(back)}`)
      }
    }
    if (!restored) {
      lost.push(image)
      continue
    }
    released.push(image)
    try {
      // Worth trying, because a recently-exited holder leaves the copy already
      // deletable. Measured, though, this fails `EPERM` while the process lives
      // (the mapped section never asked for DELETE access, so the unlink does
      // not even become pending) and Windows does NOT clear the copy when that
      // process exits — so it is swept on a later pass, not claimed as gone.
      unlinkSync(scratch)
    } catch { /* still mapped: sweepLockedAside clears it once the holder exits */ }
  }
  return { released, lost }
}

/**
 * Clear copies an earlier repair parked outside the package directory.
 *
 * Measured on a real profile: the renamed image of a LIVE process cannot be
 * unlinked (`EPERM` — the file opens for reading, so it was never marked
 * delete-pending), it is still listed ten seconds after that process exits, and
 * nothing removes it by itself. So this is opportunistic by design: each pass
 * deletes whatever is already deletable and reports the rest as busy. A profile
 * that keeps running the old engine keeps one copy until it restarts — an
 * engine-sized file, never a broken package, and never a silent claim of a tidy
 * the OS does not provide.
 */
export function sweepLockedAside(profileDirectory: string): { removed: string[], busy: string[] } {
  const dir = lockedAsideDir(profileDirectory)
  const removed: string[] = []
  const busy: string[] = []
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return { removed, busy } // no scratch home: nothing was ever parked here
  }
  for (const name of names) {
    try {
      unlinkSync(join(dir, name))
      removed.push(name)
    } catch {
      busy.push(name) // still mapped by a live engine: a later pass will get it
    }
  }
  if (removed.length > 0) {
    logEvent('info', 'install', `removed ${removed.length} engine copy/copies an earlier locked-update repair had parked in ${dir}`)
  }
  return { removed, busy }
}

/**
 * Find and release every releasable engine image under this profile.
 *
 * @returns the images that are no longer blocking the swap (empty when there
 *   was nothing of this shape to release, which is the signal to the caller
 *   that the failure is the loaded-module kind and must not be retried).
 */
export async function releaseLockedImages(
  profileDirectory: string,
  finder: (dir: string) => LockedImage[] = findLockedImagesUnder,
): Promise<LockedImage[]> {
  if (process.platform !== 'win32') return []
  // Swept before anything else, and even when this pass finds no candidate: a
  // copy parked by an earlier repair becomes deletable the moment the old
  // engine exits, and this is the only pass that ever runs for this failure.
  sweepLockedAside(profileDirectory)
  let candidates: LockedImage[] = []
  try {
    candidates = finder(profileDirectory)
  } catch (error) {
    logEvent('warn', 'install', `the locked-image scan failed: ${String(error)}`)
    return []
  }
  if (candidates.length === 0) return []
  const { released, lost } = releaseImages(candidates, lockedAsideDir(profileDirectory))
  if (lost.length > 0) {
    logEvent('warn', 'install', `engine images that could not be restored under their original name: ${lost.map(l => `${l.name} (pid ${l.pid})`).join(', ')} — a new engine for those cannot start until the swap lands`)
  }
  if (released.length > 0 && !existsSync(join(profileDirectory, 'node_modules'))) {
    // Should not happen: the candidates were found under node_modules. Kept as
    // a guard so a mis-resolved profile directory is visible in the log rather
    // than silently moving files out of the wrong tree.
    logEvent('warn', 'install', `released ${released.length} image(s) but ${profileDirectory} has no node_modules — check the profile path`)
  }
  return released
}
