# Handoff — market self-update UI + installer seed (one release)

Written at the end of the session that shipped the in-place update fix. The context ran out before
the work below was executed, so **nothing in this file is done yet** except what is listed under
"Already shipped".

## Objective (user's words)

> the arya market fix you made to get the sidebar update to work. how to we make it easier and in the UI?
> i have two other installs of AryaCode out there and it all needs the same update

> please do that and since we are going to be publishing a new installer. please lets seed the lastest
> version of the engineering plugin as well. please make sure updating from market still works

> i dont want multiple steps. i want it all done and verified and one installer release with these new updates

## Already shipped

- `@aryacode/dsh-arya-market@1.70.1-arya.0.2` — the update path now calls the host's `updateBundle`
  instead of remove-then-add, so a loaded plugin can be updated (no more `bundle-in-use`).
  Files: `src/official-desktop.ts` (`OfficialPluginManagerLike.updateBundle?`, `EXACT_VERSION`,
  the branch inside `installOrReinstall`), tests in `tests/official-desktop.spec.ts`
  ("uses the host upgrade instead of removing a plugin that is in use (#935)",
  "keeps the remove path when the target is a range, not a version").
- `@aryacode/dsh-aryacode-polish@0.96.0` — grey closed / blue open folders, tinted current rows, Focus row removed.

## Remaining work — market (`C:\Users\KNPhu\.arya\github\KonnectSuite\dsh-market`)

1. **Market update strip.** Header already knows the running version and the registry latest; when they
   differ, render a strip "Market update available → Update" whose button calls `updateMarketInPlace`
   directly (never the remove path).
2. **Turn the refusal into a button.** Where `bundle-in-use` is turned into a message
   (`src/official-desktop.ts`, the `'bundle-in-use'` entry in the copy table), attach a machine-readable
   action so the client can render **Update in place**; that action re-runs the update through
   `manager.updateBundle` even when the spec is a tag (resolve the tag to a version first — see 4).
3. **Stop pinning on self-update.** `updateMarketInPlace` currently leaves the profile dependency as an
   exact version (`1.70.1-arya.0.1`), which is what made 0.2 unreachable by ordinary resolution. It must
   write a range (`^<version>`) or leave the existing range untouched.
4. **Tag fallback.** `installOrReinstall` only takes the `updateBundle` branch when the spec carries an
   exact version (`routes.ts:4645-4646` passes `${name}@${tag}` when registry metadata is unavailable).
   Resolve the tag to a version before calling `updateBundle`, or pass through and let the host resolve.

Release: bump to `1.70.1-arya.0.3`, `npm publish --access public --tag latest`, then
`node scripts/publish-arya-release.mjs --npm 1.70.1-arya.0.3 --source KonnectSuite/dsh-market --publish`
and `publish-arya-catalog.mjs --pull` / `--push`. Verify with
`npm view @aryacode/dsh-arya-market dist-tags --json` and by packing the published tarball and grepping
`lib/official-desktop.js` for the new branch.

## Remaining work — installer (`C:\Users\KNPhu\.arya\github\KonnectSuite\AryaCode`)

`apps/desktop/src/starter-plugins.ts` (verified in this session):

```ts
name: '@aryacode/dsh-arya-market', range: '^1.70.1-arya.0.1', version: '1.70.1-arya.0.1', tarball: '',
name: 'dsh-better-sidebar',        range: '^0.28.0',           version: '0.28.0',           tarball: 'dsh-better-sidebar-0.28.0.tgz',
```

`apps/desktop/seed/` currently holds only `dsh-better-sidebar-0.28.0.tgz`.

1. Market entry → `range: '^1.70.1-arya.0.3'`, `version: '1.70.1-arya.0.3'`, `tarball: ''`.
2. Add engineering (latest on npm at handoff time: **`@aryacode/dsh-engineering@0.19.1`**):
   `range: '^0.19.1'`, `version: '0.19.1'`, `tarball: 'aryacode-dsh-engineering-0.19.1.tgz'`,
   `integrity: 'sha512-…'` — download the tarball, compute sha512 base64, copy it into `apps/desktop/seed/`.
   The seed validates integrity with `verifyStarterTarball` and is idempotent (`node_modules/<name>` wins).
3. Keep the rule in that file: a **semver range**, never a `file:` spec.

Verify: `packages/util/*` + `apps/desktop` tests; then one installer release.

## Invariants to preserve

- Build → test in Dev AryaCode → publish only when final.
- Never edit the installed app; harness changes only in the checkout.
- After seeding, the profile must be indistinguishable from a market install, so the market can update it.

## Immediate unblock for the other two machines (no code)

Plugins → Arya Plugin Market → update **the market itself** (in-place path), restart, then update plugins.
If the row refuses because the dependency is pinned:
`pnpm add @aryacode/dsh-arya-market@1.70.1-arya.0.2 --config.minimum-release-age=0` in the profile dir.
