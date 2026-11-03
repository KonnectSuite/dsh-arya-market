# AGENTS-PLUGINS.md — how a plugin gets into the Arya Market

This file governs the **process** of taking a plugin from a repository to a listing that real users
can install. It is a constraint, not a reference: work that skips a gate is not finished.

It deliberately does **not** cover how to write a DSH Cordis plugin — slots, `cordis.patch.yml`,
`dsh.client`, bundles, activation, the client module loader. Those rules live with the host
(`C:\Users\KNPhu\.arya\github\KonnectSuite\AryaCode`) and with each plugin repository's own docs.
What is here is everything after "the code compiles": docs, Dev AryaCode verification, approval,
publication.

Related documents: `AGENTS.md` (how the market's UI and copy should be written), `ARYA.md` (what is
in the catalogue and what the host badge means), `TESTING.md`, `SECURITY.md`.

---

## 1. The one rule

A plugin reaches Arya users through **four gates, in this order**:

1. **Documented** — a stranger can install it, find it in the UI, use it and remove it without
   reading the source.
2. **Verified on Dev AryaCode** — installed into an isolated dev profile of the development build,
   activated, exercised, and the evidence recorded.
3. **Approved** — a human said yes to *this version*, after seeing the evidence.
4. **Published** — npm first, then the catalogue (`--pull`, `--release`, `--push`), then the live URL
   verified.

A plugin that is on npm but not in the catalogue is not released. A plugin in the catalogue that
was never verified on Dev AryaCode is a regression waiting for a user to find it — that is exactly
what happened on 2026-10-24 when twelve packages were published in one batch and none of them had
been tested against the host they landed on.

**Never ask the user to choose between "ship now" and "verify first".** Verify first; it takes
minutes. Ask for approval once, with evidence.

---

## 2. Repository and package identity

- Source of truth is a repository under `KonnectSuite/<name>`. The catalogue entry records that
  repository URL, so renaming or moving the repository breaks the entry.
- First-party packages are scoped `@aryacode/dsh-<name>`; the repository may be named after the
  feature (`dsh-native-window`, `dsh-aryacode-polish`).
- The published tarball must be installable as-is: `dsh.bundle.patch` present, no `workspace:` /
  `link:` / `file:` dependency specifiers (the release script refuses these), no `.env` or
  credential files in the archive.
- Declare the host range in `dsh.engines.dsh` (for example `"^0.2.1-rc.3 || >=0.2.2-alpha.2"`).
  Without it the market shows **Host requirement unknown** and can neither confirm nor block the
  install; with it the card states the requirement.
- Keep the archive small. The market downloads the tarball, verifies it and stages it into the
  profile, with **64 MiB / 120 s** defaults (`maxReleaseBytes`, `releaseDownloadTimeoutMs`). A
  package that needs to be bigger needs a host-side decision, not a bigger archive.

---

## 3. Gate 1 — documentation

"Well documented" means this exists **in the plugin repository**, not in a chat:

- `README.md` with, in this order:
  - what the plugin does, in the user's words, one paragraph;
  - **requirements** — AryaCode/host version, `dsh.engines.dsh`, Python or other runtimes and
    packages, ports or other resources it binds, credentials it needs;
  - **install** — one copy-pasteable command or the market path;
  - **where it appears** — the sidebar row, the footer chip, the main panel or the tab, described by
    what the user sees, not by slot names;
  - **first run** — what to do before it is useful;
  - **settings** — every switch and what it changes;
  - **remove** — how to uninstall and how to clear its data;
  - **troubleshooting** — the two or three failures that really happen, each with what to do;
  - **licence**.
- Every user-visible string localised (English and Chinese) with both sides saying the same thing.
  If the repository has a docs/locale parity test, it must pass.
- A `HANDOFF.md` (or an equivalent state section) recording: current version, the commit it was
  built from, the published tarball digest, what was verified and where, and the known gaps.
- A `CHANGELOG.md` or release notes: one entry per published version, newest first.
- No placeholder copy, no `TODO`, no "coming soon" in anything that ships.

The reviewer's test: could someone who has never seen this repository install it from the market,
find it in the UI, and recover from the two most likely failures using only the README?

---

## 4. Gate 2 — verification on Dev AryaCode

The development build is the only place a plugin is tested before publication. Never use the
installed application for this: its profile is the user's real data.

**Recipe** (Windows, from the `AryaCode` checkout):

```powershell
$dev  = "$env:LOCALAPPDATA\AryaCode-dev\home"
$env:ARYACODE_HOME = $dev            # the desktop app resolves its profile from this
$env:DSH_HOME      = $dev
$env:DSH_DESKTOP_RENDERER_DEBUG_PORT = '9333'   # any free port
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue

# install the candidate tarball into the dev profile (remove first: a file: spec of the
# same version will otherwise resolve from pnpm's store and you will test the old bytes)
Set-Location "$dev\profiles\desktop"
node 'C:\Users\KNPhu\AppData\Roaming\npm\node_modules\pnpm\bin\pnpm.cjs' remove '@aryacode/<name>'
node 'C:\Users\KNPhu\AppData\Roaming\npm\node_modules\pnpm\bin\pnpm.cjs' add "file:<tarball>"

# launch; read the URL from the redirected log, never reuse an old token
Start-Process node -ArgumentList 'C:\Users\KNPhu\AppData\Roaming\npm\node_modules\pnpm\bin\pnpm.cjs','run','start:desktop' `
  -WorkingDirectory 'C:\Users\KNPhu\.arya\github\KonnectSuite\AryaCode' `
  -RedirectStandardOutput "$env:TEMP\dev.out.log" -RedirectStandardError "$env:TEMP\dev.err.log"
```

- Launch the desktop app through `Start-Process` with redirected files. A background job dies with
  its parent session, and an interrupted tool call kills its whole process tree — including the app.
- The dev profile must be signed in. A brand-new `ARYACODE_HOME` opens the welcome screen, the shell
  never loads, and the plugin cannot be seen.
- If the plugin runs a sidecar or helper, point it at the Python (`DSH_DESKTOP_PYTHON_PATH`) or
  other runtime explicitly, and give it its own port: a helper left by another AryaCode/AryaAI
  install will answer on the default port and you will be testing that one.
- Stop the dev app by filtering `electron.exe` on its command line (`-like '*AryaCode*'`). Never
  filter by process start time, and never touch `node.exe`.

**What to record as evidence** — all of it, in the report to the user:

1. `GET /dsh-market/installed` on the dev host: the plugin listed, `activation.state` `live`,
   `diagnostics.findings` empty.
2. The plugin's own surface rendered in the running app: the rail row, footer chip, tab or panel —
   named as the user sees it, plus a screenshot.
3. The feature actually exercised once, end to end (open the page, run the tool, dock the window,
   take the capture — whatever the plugin is for).
4. The dev stderr free of activation errors (`did not activate`, `import failed`,
   `duplicate factory`, `failed to load`).
5. A restart check when the plugin registers host code or a config row: the second launch must come
   up clean on the same profile.

If any of that fails, the plugin is not ready — fix, repack, reinstall with `remove` then `add`, and
start the evidence list again.

---

## 5. Gate 3 — approval

Approval is a human word, for a specific version, after the evidence exists. Ask once, then stop:

- the version and the commit being proposed;
- what changed since the last published version;
- the evidence from gate 2, including the screenshot;
- the known limits — requirements, ports, unsupported surfaces, anything the plugin cannot do.

"Publish it", "go", "proceed" — those are approval. Silence, a question, or an unrelated message is
not. Do not publish a second version on the strength of an earlier approval, and never publish
"while I'm here".

---

## 6. Gate 4 — publication

Run from `C:\Users\KNPhu\.arya\github\KonnectSuite\dsh-arya-market`. One command does the whole gate:

```powershell
# 0. in the PLUGIN repository: bump the version, commit, push, npm publish
#    (or push the v* tag and let that repository's release workflow do it)

# 1. record it, publish it, and prove it landed
node scripts/publish-arya-release.mjs --npm 0.2.8 --source KonnectSuite/dsh-native-window --push
```

`--push` exits 0 only when the `catalog` branch serves that version with that digest. Anything else
is a release users cannot see, and the command says so instead of returning quietly.

First-time entry — `--name` and both descriptions are required:

```powershell
node scripts/publish-arya-release.mjs --npm 0.2.8 --source KonnectSuite/dsh-native-window `
  --name '@aryacode/dsh-native-window' `
  --description 'English sentence for the card' `
  --description-zh '卡片上的中文说明' `
  --push
```

### What that command does, in order

Each step is a way a release has gone missing, which is why they are one command and not five:

1. **`publish-arya-catalog.mjs --pull`** — the catalog lives on its own branch and the local file is
   only a cache. Recording onto a stale copy pushes an entry missing everything that landed since;
   recording onto an absent one pushes only this plugin and deletes the rest. That is why `--push`
   pulls first, and why recording with no local copy at all is now refused instead of writing a
   one-plugin catalog.
2. **Record** — download the published tarball, refuse it unless it carries `dsh.bundle.patch` and no
   `workspace:` / `link:` / `file:` dependency and no credentials, and pin its `sha256`. A published
   version whose bytes differ is refused: bump the version, never rewrite the entry.
3. **`--push`** — rewrite the branch through the API, then poll it until the entry, its version and
   its `sha256` are all present.
4. **Report** — `the branch serves <name>@<version>`, and separately whether the CDN in front of the
   raw URL is already serving it. The branch is the authority; the CDN is minutes.

Without `--push` nothing is published. The script prepares the local file and says so — "the JSON
looks right" is not a released plugin, and that gap is what made publishing feel random.

`--verify` asks the same question after the fact, for a release that was pushed earlier: it writes
nothing, pushes nothing, and exits 0 only when the branch serves that version with that digest.

### The check that catches a skip

```powershell
node scripts/check-catalogue-parity.mjs
```

Read-only, no build needed. It compares every catalogue entry against npm's `latest` and against the
digest its own tarball serves, and says which entries are on npm but not in the catalogue. That is the
state where users are shown "up to date" for a release that exists — the failure this is here to make
impossible to miss. Run it before a release and after one; `--strict` also fails on the
manifest-vs-catalogue list disagreements.

Then verify the live document — this, not the local file, is what users' apps read:

```
https://raw.githubusercontent.com/KonnectSuite/dsh-arya-market/catalog/data/arya-plugins.json
```

The raw URL is CDN-cached for a couple of minutes; poll it, or read the file through
`https://api.github.com/repos/KonnectSuite/dsh-arya-market/contents/data/arya-plugins.json?ref=catalog`
to prove the push landed. Confirm `count`, the entry's `version`, its `releases[0].sha256` equal to
`Get-FileHash <published tarball> -Algorithm SHA256`, and that the tarball URL answers 200.

The release script refuses to overwrite a published version with different bytes. If that happens,
the version was reused: bump it, do not rewrite the entry by hand.

### Why the catalogue entry is also the 24-hour answer

`minimumReleaseAge` refuses a version younger than its window (1440 minutes — 24 hours — whenever the
profile does not set it explicitly). A **catalogue** install sidesteps it completely: the market
downloads the tarball itself, verifies the `sha256` and installs a `file:` spec, so pnpm never
resolves it from the registry and there is no fresh-release window to wait out.

An install that came from **npm** (a bare `"0.115.0"` in the profile's `package.json`) has no such
shortcut, and on a Desktop host the market takes no one-shot bypass either — that click can only fail
until the window passes.

So the entry is not documentation of a release. It is the delivery path that works on publication
day, on every machine, whatever that machine's `minimumReleaseAge` says. When an agent reports "npm
only allows an update every 24 hours", it is describing the npm path; recording the release in the
catalogue is the way around it, and `--push` is what makes that real.

### What the catalogue enforces

`validateAryaRegistry` rejects the whole catalogue, not just the bad entry, when:

- any plugin lacks `arya: true`, or a package name is invalid or duplicated;
- `releases` is empty, a version is malformed (`x.y.z` or `x.y.z-tag`) or duplicated;
- a `sha256` is not 64 lowercase hex characters;
- a tarball URL is not exactly one of
  `https://registry.npmjs.org/<name>/-/<basename>-<version>.tgz` or
  `https://github.com/KonnectSuite/dsh-arya-market/releases/download/plugin-<flattened>-v<version>/<flattened>-<version>.tgz`,
  or carries a query, fragment or credentials.

The market installs from `releases`: the first entry when no version is chosen, an exact match when
the user picks one. It downloads that tarball, verifies its `sha256`, stages it into
`<profile>/.dsh-market/releases/` and installs it as a `file:` spec. The entry's top-level
`version` and `tarball` are written by the script for the listing — never hand-edit them, and keep
them agreeing with `releases[0]`.

---

## 7. Versions, retirement, and rollback

- Semver, monotonically increasing. A published version is immutable; its bytes are pinned by
  `sha256` in the catalogue and by the npm registry.
- The catalogue keeps earlier versions in `releases`; that list is the rollback path for users
  (**Choose version** in the market). Never delete old releases to "clean up".
- Retiring a package is **deprecate**, not unpublish: `npm deprecate "<name>@<version>" "reason"`.
  Deprecation needs no second factor and keeps existing installs working.
- Unpublishing deletes the archive for everyone pinned to it and needs a passkey-gated code; it is
  only for names that should never have existed, and only with explicit approval per package.
- A failed or accidental publish can leave a staged version on npm (`0.0.0-stage`). That is cleaned
  in the npm UI under *Staged packages*; it cannot be removed from the CLI.

---

## 8. The installer seed is not the market

Plugins reach users through the market. A small set is *seeded* into a fresh install by the
installer (`apps/desktop/seed` in the AryaCode checkout — currently the market itself, the
engineering bundle and Better Sidebar). The seed and the catalogue are different mechanisms:

- Seeding means shipping a tarball inside the installer, which requires a new installer build, a
  release, and a feed/site update.
- Adding a plugin to the seed needs an explicit instruction. "Publish it to the market" does not
  mean "seed it", and a plugin in the catalogue must never be added to the seed on the assumption
  that it should be there.

---

## 9. Traps that have actually cost time here

- **A `file:` tarball of the same version hides behind pnpm's store.** Always `pnpm remove` the
  package before `pnpm add "file:<new tarball>"`, then confirm the installed `lib/` size or a
  distinctive string changed.
- **A byte-order mark breaks JSON reads.** Write files with
  `[IO.File]::WriteAllText($path, $text, (New-Object System.Text.UTF8Encoding($false)))`; a profile
  manifest saved with a BOM silently reads as "unknown version".
- **Net's `[IO.File]` calls use the process working directory, not PowerShell's `Set-Location`.**
  Pass absolute paths.
- **`$home`/`$HOME` is read-only.** Assigning to it silently leaves `ARYACODE_HOME` empty and the app
  writes into the real user profile.
- **`git commit -m` with quotes breaks in PowerShell.** Write the message to a file and use
  `git commit -F`.
- **A successful `git push` exits 1 in this shell** because git writes progress to stderr. Read the
  ref update line, not the exit marker.
- **The whole app can be killed by a process filter.** Filter `electron.exe` on the command line;
  never touch `node.exe`.
- **Stale helpers own the ports.** If a sidecar reports another product's process, kill the orphan,
  give this profile its own port in `cordis.patch.yml`, and relaunch.

---

## 10. Checklists

**Before asking for approval**

- [ ] README covers requirements, install, where it appears, first run, settings, remove,
      troubleshooting.
- [ ] User-visible strings localised, both languages saying the same thing.
- [ ] `HANDOFF.md`/state section updated; `CHANGELOG` entry written.
- [ ] `dsh.engines.dsh` declared; `dsh.bundle.patch` present; no `file:`/`link:` deps.
- [ ] Version bumped; `pnpm pack` archive under 64 MiB and free of credentials.
- [ ] Dev AryaCode: activation `live`, surface rendered, feature exercised, restart clean,
      evidence collected.

**Before publishing**

- [ ] Approval exists for this exact version.
- [ ] `npm publish` succeeded and `latest` on the registry shows it.
- [ ] `node scripts/check-catalogue-parity.mjs` exits 0 — no entry is on npm but missing from the
      catalogue, and every pinned `sha256` matches the archive it points at.
- [ ] `--push` reported `the branch serves <name>@<version>` (it pulls, records, pushes and verifies
      in one command; without it nothing is published).
- [ ] Live catalogue shows the version, its `sha256` matches the published tarball, tarball answers
      200.
- [ ] The plugin repository is committed and pushed, with the version and digest recorded in
      `HANDOFF.md`.
- [ ] Nothing was added to the installer seed.

---

## 11. Where things live

| Thing | Location |
| --- | --- |
| Catalogue document | `KonnectSuite/dsh-arya-market`, branch `catalog`, `data/arya-plugins.json` |
| Live catalogue URL | `https://raw.githubusercontent.com/KonnectSuite/dsh-arya-market/catalog/data/arya-plugins.json` |
| Validation rules | `lib/arya.js` (`validateAryaRegistry`, `stageAryaRelease`) |
| Publish scripts | `scripts/publish-arya-catalog.mjs`, `scripts/publish-arya-release.mjs` |
| Drift check | `scripts/check-catalogue-parity.mjs` (read-only, no build needed) |
| Dev build and seed | `C:\Users\KNPhu\.arya\github\KonnectSuite\AryaCode` (`apps/desktop/seed`) |
| npm packages | `https://registry.npmjs.org/@aryacode%2F<package>` |
