# CLAUDE.md

Conventions and context for working in this repo (a Homebridge plugin for PalGate gates).

**Product scope:** make PalGate gates a complete *Apple Home* experience. This is not a
PalGate admin panel — user management, log-browsing UIs, scheduling engines, etc. are out
of scope. Every feature should make the gates behave like first-class HomeKit accessories.

## Commits
- **Commit as you go.** Make small, focused commits — one logical change each — as each
  piece of work is finished and verified, rather than batching everything into one big
  commit at the end. This keeps history readable and easy to revert.
- **One concern per commit.** Don't mix unrelated changes (e.g. a feature and a doc tidy, or
  two separate fixes) in the same commit — split them into separate commits.
- Verify before committing: run the relevant tests, and leave the working tree clean after
  each commit.
- Conventional Commits, lowercase: `feat`, `fix`, `docs`, `test`, `chore`, `style`, `ci`.
  Scopes seen: `ui`, `api`, `platform`, `e2e`, `deps`. Combine when a change spans areas —
  e.g. `fix(ui):`, `chore(deps):`, `docs+ui:`, `fix(api)+test:`.
- Keep messages **short** — a single concise title line. Add at most a one-line body when it
  genuinely adds context; avoid long multi-paragraph bodies.
- **No `Co-Authored-By` trailer.**
- Commit directly to `master` (repo convention). Version bumps are their own commit:
  `chore: bump version to X.Y.Z`.

## Versioning & releases
- SemVer in `package.json`. Feature work → **minor** bump; small fixes → **patch**.
- Git tags are the **bare version number, no `v` prefix** (e.g. `3.7.0`).
- **Publishing is automated by the tag.** Creating a GitHub release with the version tag
  triggers `.github/workflows/npm-publish.yml`, which runs `npm test` then `npm publish`.
  So only create a *tagged* release when you're ready to publish to npm — otherwise use a
  draft (no tag). `.github/workflows/test.yml` runs `npm test` on every push/PR (Node
  20/22/24).
- Release flow: bump version commit → push master → `gh release create <version>
  --title "<version>" --notes-file <file>` → the publish workflow ships it.

## Release notes style
Write for users, not developers. Match existing releases (see 3.6.0 / 3.7.0):
- Open with a **one-line summary** of the release theme.
- Then sections, **omitting any that don't apply**: `**New features**`, `**Bug fixes**`,
  `**Improvements**`, `**Maintenance**`. Under Bug fixes, sub-group with italic headers
  (`*Home app*`, `*Settings screen*`) when there are several.
- Bullet lists; **bold the key noun/action** in each bullet. Plain, second-person voice
  ("you"), no implementation detail.
- Only list **Bug fixes** for real fixes to *existing* behavior — not bugs in code added
  in the same release.
- Optional `> **Note:**` blockquote for caveats.

## Testing
- `npm test` = four hermetic layers (`test/unit`, `test/api`, `test/platform`,
  `test/ui-server`). These run in CI. Keep them green.
- `npm run test:e2e` is **local only** — needs a running Homebridge + config-ui-x + Chrome
  and `HB_UI_PASSWORD`; it drives the real settings iframe in headless Chrome.
- New API endpoints get a route in the stub server (`test/helpers/stub-palgate.js`) plus an
  envelope-unwrap regression test (the API wraps payloads in `{err,msg,status,...}`).
- Follow existing patterns: per-gate config overrides beat global; `callApi` (retries) vs
  `callApiOnce` (single-shot); poller write cooldowns; companion-accessory sync.

## Config UI (`homebridge-ui/public/index.html`)
- **Icons:** config-ui-x's CSP blocks CDN assets, so every icon must be in the bundled
  Font Awesome subset. To add one: subset with `pyftsubset` (full font + `codepoints.txt`
  + `glyphmap.json` live in `scratch/fa/`), then add the glyph to
  `homebridge-ui/public/fontawesome/palgate-icons.css` **and** the icon-hardening block in
  `index.html`, and bump the glyph count in both places + `TESTING.md`.
- **Tooltips:** native `title` and Bootstrap JS tooltips don't work in the iframe — use the
  CSS-only `.pg-tip` + `data-tip` pattern.
- **Per-gate overrides:** show a live "(global default)" tag beside a toggle when it matches
  the global value; persist a per-gate value only when it deviates from global.
- Keep wording/ordering consistent with the README.

## README / docs
- Second-person, practical, **American spelling**. Subsection headings are plain topic
  names (no "Notes on …"). Don't label features "(opt-in)".
- Keep ordering consistent across the README, the config UI, and the Features list.
  Current order: **Relay Mode above External-Open Detection**.

## Domain facts to keep straight
- **External-open detection** reads PalGate's operation log, so it only sees opens PalGate
  records (the PalGate app, dial-in calls). It **cannot** detect non-PalGate opens (a
  physical remote, key fob, or keypad). Requires **admin** on the gate.
- **Relay / Hold Open & Hold Closed** requires **latch** permission on the output. Exposable
  as Lock, Switch, or Valve; a Valve adds a native countdown (`valveDefaultDuration`, 0 =
  indefinite, max 3600s — HAP's limit).
- HomeKit state is a **time-based animation** (`gateOpeningDelay` + `gateCloseDelay` for
  every accessory type), not the gate's real position — PalGate doesn't report position.
  `momentary` trigger mode resets immediately instead.
- `axios` is a **runtime** dependency — keep it patched (Dependabot). Most other Dependabot
  alerts come via `homebridge-config-ui-x` (devDependency) and don't ship.
- `scratch/` is gitignored (dev probes like `probe_fields.js`, which dumps live API
  payloads using creds from `~/.homebridge/config.json`).
