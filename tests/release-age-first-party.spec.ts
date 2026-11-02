/**
 * First-party releases are not held.
 *
 * The release-age hold buys review time before a third party's new code is
 * installed. Our own packages are catalog-verified (sha256 per release), so a
 * hold has nothing to add — and it actively hides a release from the author's
 * other machines for a day, which is the bug this pins.
 */
import { describe, expect, it } from 'vitest'
import { isFirstPartyRelease } from '../src/updates.ts'

describe('the release-age hold exempts first-party packages', () => {
  it('recognises our scoped packages', () => {
    expect(isFirstPartyRelease('@aryacode/dsh-engineering')).toBe(true)
    expect(isFirstPartyRelease('@aryacode/dsh-aryacode-polish')).toBe(true)
    expect(isFirstPartyRelease('@aryacode/dsh-arya-market')).toBe(true)
  })

  it('recognises the unscoped first-party names', () => {
    expect(isFirstPartyRelease('dsh-arya-image-gen')).toBe(true)
  })

  it('leaves third-party packages held', () => {
    expect(isFirstPartyRelease('dsh-better-sidebar')).toBe(false)
    expect(isFirstPartyRelease('@deepseek-ai/dsh-tool-web')).toBe(false)
    expect(isFirstPartyRelease('@michengai/dsh-codex-pet')).toBe(false)
    expect(isFirstPartyRelease('@axyatech/dsh-plugin-rea')).toBe(false)
    expect(isFirstPartyRelease('some-other-package')).toBe(false)
  })
})
