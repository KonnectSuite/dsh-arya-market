// The locked-engine repair, tested against REAL machinery: a real process started
// from a real copy of a real .exe inside a real fixture node_modules.
//
// Why this is not mocked: the whole point of src/locked-images.ts is a Windows
// behaviour — the image of a running process cannot be deleted, but it CAN be
// renamed, and the package directory holding it becomes removable the moment it
// is. No fake can tell us that; the assertion that matters (the directory can be
// removed while the process is still running) either holds against the OS or it
// does not. Everything here is therefore the OS itself, and the spec is skipped
// off Windows rather than simulated there.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { findLockedImagesUnder, lockedAsideDir, releaseImages, releaseLockedImages, sweepLockedAside } from '../src/locked-images.ts'

// Any small console image works; ping is chosen because `-n 60` keeps the image
// mapped for a minute without touching the network beyond loopback. Copied, never
// run in place: the point is an image inside the fixture's node_modules.
const SYSTEM_PING = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'ping.exe')
const windows = process.platform === 'win32' && existsSync(SYSTEM_PING)
// The gate has to sit at the TEST level. `describe(...)` inside a `describe`
// opens a nested suite, and an async suite factory is awaited at COLLECTION
// time — before beforeEach has made the fixture root — so a first draft of
// this file built its fixture under the repository instead of a temp
// directory. it.skip is the gate that keeps the fixture lifecycle intact.
const itWindows = windows ? it : it.skip

function engineFixture(root: string): string {
  const bin = join(root, 'node_modules', 'arya-engine', 'bin')
  mkdirSync(bin, { recursive: true })
  const image = join(bin, 'arya-probe-engine.exe')
  copyFileSync(SYSTEM_PING, image)
  return image
}

function startEngine(image: string): ChildProcess {
  // stdio ignore: a console app with inherited pipes would keep the test's own
  // stdio handles open. windowsHide so no console window flashes on a desktop run.
  return spawn(image, ['-n', '60', '127.0.0.1'], { stdio: 'ignore', windowsHide: true })
}

// The scan is a CIM query, so it costs about a second and the process must be
// registered before it answers. Polling beats sleeping: it says which assumption
// failed when it never finds the process at all.
async function scanUntil(root: string, pid: number, tries = 6) {
  for (let attempt = 0; attempt < tries; attempt++) {
    const found = findLockedImagesUnder(root).filter(image => image.pid === pid)
    if (found.length > 0) return found
    await new Promise(resolve => setTimeout(resolve, 500))
  }
  return []
}

function alive(pid: number): boolean {
  try {
    // Signal 0 is Node's documented existence probe; it sends nothing.
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

// Stop the engine and WAIT for it to be reaped. This is not tidiness: the repair
// leaves the image it moved aside as a delete-pending file, and Windows
// completes that delete only when the last handle to the owning process closes —
// so a directory containing one cannot be removed while the process lives.
// Waiting on process.kill(pid, 0) is not enough either: on Windows a terminated
// process that the parent has not reaped yet still answers OpenProcess.
async function stopAndWait(child: ChildProcess | null): Promise<void> {
  if (!child) return
  const alreadyGone = child.exitCode !== null || child.signalCode !== null
  child.kill()
  if (!alreadyGone) {
    await new Promise<void>(resolve => {
      child.once('exit', () => resolve())
      setTimeout(resolve, 5000)
    })
  }
  // The pending delete lands a moment after the exit event, not at it.
  await new Promise(resolve => setTimeout(resolve, 400))
}

// Paired with stopAndWait: the delete-pending image can outlive the wait by a
// few hundred ms on a busy machine, so the removal retries rather than fails
// a test whose assertions all passed.
const cleanRoot = (root: string) => rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 })

describe('the locked-image scan is anchored to one profile', () => {
  let root = ''
  let child: ChildProcess | null = null

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'dshm-locked-'))
  })
  afterEach(async () => {
    await stopAndWait(child)
    child = null
    cleanRoot(root)
  })

  itWindows('finds the engine a plugin started inside that profile', async () => {
    const image = engineFixture(root)
    child = startEngine(image)
    const found = await scanUntil(root, child.pid!)
    expect(found).toHaveLength(1)
    expect(found[0]!.pid).toBe(child.pid)
    expect(found[0]!.path.toLowerCase()).toBe(image.toLowerCase())
    expect(found[0]!.name).toBe('arya-probe-engine.exe')
  })

  itWindows('never reports the image of the process asking, or of its ancestors', async () => {
    // The safety rule the whole design rests on: the market must not move the
    // image of the process that would move it, nor of the app that owns it.
    const image = engineFixture(root)
    child = startEngine(image)
    expect(await scanUntil(root, child.pid!)).toHaveLength(1)
    expect(findLockedImagesUnder(root, child.pid!)).toEqual([])
    // ...and the image is exactly where it was.
    expect(existsSync(image)).toBe(true)
  })

  itWindows('ignores the same image outside the profile node_modules', async () => {
    // An engine running from anywhere else — the host's own tree, another
    // profile — is none of this repair's business.
    const loose = join(root, 'arya-outside.exe')
    copyFileSync(SYSTEM_PING, loose)
    child = startEngine(loose)
    await new Promise(resolve => setTimeout(resolve, 800))
    expect(findLockedImagesUnder(root)).toEqual([])
  })

  itWindows('releases the image so the package directory can be removed, with the process still running', async () => {
    // This is the whole fix, end to end: after the release the swap pnpm was
    // refused on becomes possible, and nothing was killed.
    const image = engineFixture(root)
    child = startEngine(image)
    expect(await scanUntil(root, child.pid!)).toHaveLength(1)
    const released = await releaseLockedImages(root)
    expect(released).toHaveLength(1)
    expect(released[0]!.pid).toBe(child.pid)
    // The engine is still running — the user did not lose their session.
    expect(alive(child.pid!)).toBe(true)
    // The name is free because the file at it is a NEW file, not the mapped image.
    expect(existsSync(image)).toBe(true)
    expect(readFileSync(image).length).toBe(readFileSync(SYSTEM_PING).length)
    // The copy set aside is NOT gone and NOT auto-removed: measured, it opens
    // for reading (so it was never marked delete-pending), unlinking it fails
    // `EPERM` while the process lives, and it is still listed ten seconds after
    // the process exits. So the honest claim is what the sweep reports.
    expect(readdirSync(lockedAsideDir(root))).toHaveLength(1)
    expect(sweepLockedAside(root)).toEqual({ removed: [], busy: readdirSync(lockedAsideDir(root)) })
    // And the decisive part: pnpm removes the old package directory before it
    // renames the staged one over it. That removal is what EPERM'd.
    const pkg = join(root, 'node_modules', 'arya-engine')
    expect(() => rmSync(pkg, { recursive: true })).not.toThrow()
    expect(existsSync(pkg)).toBe(false)
    // The no-leftover claim, measured rather than asserted on faith: the sweep
    // clears the copy once the engine that held it is gone.
    await stopAndWait(child)
    child = null
    expect(sweepLockedAside(root).removed).toHaveLength(1)
    expect(readdirSync(lockedAsideDir(root))).toEqual([])
  })

  itWindows('finds nothing to release in a profile with no engine running', async () => {
    // The loaded-module shape (.node addons the host itself holds) must stay on
    // the old path: the caller retries nothing when this returns empty.
    engineFixture(root)
    expect(await releaseLockedImages(root)).toEqual([])
  })
})

describe('the release step reports what it could not do', () => {
  let root = ''
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'dshm-locked-unit-'))
  })
  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('leaves an image it could not move exactly as it was, and claims nothing', () => {
    // A file that is not there is not "released" and not "lost": saying either
    // would send the user looking for a process that never existed.
    const missing = join(root, 'node_modules', 'arya-engine', 'gone.exe')
    expect(releaseImages([{ pid: 400, name: 'gone.exe', path: missing }], join(root, 'aside')))
      .toEqual({ released: [], lost: [] })
  })

  it('moves nothing at all when the scratch directory cannot be created, and says every image is lost', () => {
    // Half a repair is worse than none: an image renamed aside with nowhere to
    // put it back is an engine the plugin cannot start. So the mkdir failure must
    // stop the whole step and report every image, not just the first.
    const blocker = join(root, 'blocked')
    writeFileSync(blocker, 'a file where a directory is needed')
    const images = [
      { pid: 1, name: 'a.exe', path: join(root, 'node_modules', 'x', 'a.exe') },
      { pid: 2, name: 'b.dll', path: join(root, 'node_modules', 'x', 'b.dll') },
    ]
    const result = releaseImages(images, join(blocker, 'aside'))
    expect(result.released).toEqual([])
    expect(result.lost).toEqual(images)
  })
})
