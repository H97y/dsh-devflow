# dsh-devflow

An automated development pipeline plugin for DeepSeek Harness: requirement pool → LLM batch refinement (with size assessment) → best-candidate selection → design → plan → review & revision loops (≤3 rounds) → implementation (small items in the main workspace / medium-large items in worktrees) → code review loops (≤3 rounds) → web verification → integration-branch merge back to main → development report.

Every potentially blocking decision is made automatically by the model following project conventions by default; the few that genuinely need a human ruling enter the per-stage waiting queue and auto-resume once answered on the page. All state persists under `<root>/.devflow/`.

The browser side is a native embedded UI (not a floating popup): an entry at the sidebar foot (same level as "Settings") opens a full main-area workbench page. The plugin mounts its own generated Remote namespace, modifies no harness product source, and works out of the box with `pnpm add`.

## Repository layout

```
├── package.json / pnpm-workspace.yaml / tsconfig.{host,client}.json   # repo shell and aggregate build graph
├── packages/devflow/          # publishable package dsh-devflow
│   ├── src/index.ts           # host service: state machine + LLM stages + devflow model tool
│   ├── src/prompts.ts         # 9-stage default prompts + {{variable}} rendering
│   ├── src/types.ts           # public types
│   ├── src/client/            # browser UI (sidebar entry + main-area page)
│   └── lib/typert.*           # vendored wire artifacts (see below)
└── scripts/
    ├── tsdown.client.ts       # browser-bundle preset vendored from harness
    ├── platform.ts            # vendored platform-module table
    ├── vendor-typert.sh       # copy + rename the typert quartet from harness (manual)
    └── sync-to-profile.sh     # dev loop: link into the dsh profile + rebuild this repo
```

## Dev loop (local harness checkout used read-only)

Iterating depends on `link:` pointers into a local `deepseek-harness` checkout (its npm releases currently lag the checkout); the paths are hardcoded in `packages/devflow/package.json` — adjust to taste. **The harness checkout stays unmodified**: the plugin installs into `~/.dsh/profiles/web` as a link, the composition row `dsh-devflow` resolves to this repo through the profile's node_modules, and the web server's `/plugins` route serves `lib/client.js` straight from this repo (no-cache).

```bash
pnpm install && pnpm build && pnpm test   # this repo builds standalone
pnpm sync:profile                         # link into the profile (restart dsh web after the first link / composition change)
```

Day-to-day iteration: edit code → `pnpm build` → reload the browser page (no restart, no harness involvement).

**Why the typert wire artifacts are vendored**: the generator's workspace discovery depends on the harness monorepo layout (aggregate tsconfig references + the `<root>/packages/` directory-membership check) and cannot be driven inside a single-package repo. When the `@Remote` method surface changes: temporarily copy `packages/devflow` into some harness checkout's `packages/` and rebuild; `scripts/vendor-typert.sh` then copies the regenerated `lib/typert.*` back into this repo, renaming `@deepseek-ai/dsh-devflow` → `dsh-devflow` for commit. Once the npm releases catch up with the checkout, this can switch to depending on the npm package directly.

## Quick start (install and first use)

> **Publish status**: `dsh-devflow` is not yet on npm (see "Publishing" for the
> prerequisites). Until then, external users should use "Option B: from
> source" below.

### Prerequisites

- The DeepSeek Harness CLI installed (`npm i -g @deepseek-ai/dsh`, any recent
  rc) and `dsh web` runnable; the `sidebar.footer.action` slot the entry uses
  needs a recent rc line
- pnpm as the profile plugin installer (set up by dsh)

### Option A: npm install (once published — recommended)

One command handles the dependency and the composition wiring (the
`dsh.bundle` manifest + the in-package `cordis.patch.yml` take effect
automatically; the `@deepseek-ai/*` peers resolve through pnpm — nothing
manual):

```bash
dsh plugin --profile web add dsh-devflow
```

### Option B: from source (works today; needs a local deepseek-harness checkout)

Runtime dependencies and build-time types currently use `link:` paths into a
local harness checkout (see the dev-loop section). After cloning, point the
`link:/...` entries in `packages/devflow/package.json` at your own checkout,
then build and link into the profile:

```bash
git clone https://github.com/H97y/dsh-devflow.git
cd dsh-devflow
# Edit packages/devflow/package.json: change link:/Users/heyue/deepseek-harness/...
#   to link:<your-harness-checkout>/... (build-time type resolution needs it too)
pnpm install && pnpm build && pnpm test
pnpm sync:profile        # link into ~/.dsh/profiles/web (DSH_PROFILE picks another)
```

> Without a local harness checkout, wait for the npm release (Option A).

### Configure the workspace

`root` defaults to the process working directory; to point it at a specific
workspace, override it in your profile patch layer
(`~/.dsh/profiles/web/cordis.patch.yml`):

```yaml
- id: devflow
  config:
    root: /path/to/your/workspace   # where .devflow/ state and the small-item workspace live
    # maxActive: 3                  # concurrent pipeline cap (default 3)
    # maxWorktrees: 2               # concurrent worktree cap (default 2)
    # logCap: 40                    # per-item log cap (default 40)
    # tickIntervalMs: 2000          # state machine tick (default 2000)
```

### Verify and first run

1. (After a first install or composition change) restart `dsh web` and open
   the web UI
2. **Verify the mount**: a "开发流水线" (Dev Pipeline) entry appears at the
   sidebar foot above Settings (a 56px rail circle when the sidebar is
   collapsed) — if not, see troubleshooting
3. Click it to open the main-area workbench; paste a rough requirement into
   the pool entry ("add a search box to the list") and hit submit
4. The background runs: batch refinement (with size assessment) → selection →
   design → plan → review & revision → implementation (the `devflow` model
   tool, driven by the session pump) → code review → web verification →
   merge to main → report; anything needing your ruling pauses in the
   waiting queue and auto-resumes once answered
5. All state lives under `<root>/.devflow/` and survives restarts

### Troubleshooting

| Symptom | Fix |
|---|---|
| No entry at the sidebar foot | Restart `dsh web`; if still missing, `curl -s http://127.0.0.1:3080/ \| grep -o 'dsh-devflow[^"]*'` to check the boot roster, then check the profile install (`~/.dsh/profiles/web/node_modules/dsh-devflow`) and the `cordis.patch.yml` insert row |
| Page opens but the status bar reports a connection error | Host half not mounted: the composition row's `name: dsh-devflow` must match the installed package name |
| No `.devflow/` directory anywhere | It sits under the configured `root` (default: the `dsh web` working directory); set it explicitly per "Configure the workspace" |

The browser UI mounts in two additive places: the entry button registers in `sidebar.footer.action` (sidebar foot, beside Settings, styled to match the native trigger rows; collapses to a 56px rail circle, carries a waiting-decision count badge); clicking it opens a full main-area page through `shell.overlay` (anchored to the sidebar's live right edge, tracking drags/collapses; a two-column master-detail layout — pool column with grouped sections on the left, item detail / artifact viewer / stage prompt editor on the right; Escape unwinds level by level). The browser half `$mount`s this package's generated `/remote` artifact itself — the `remote.devflow` namespace is mounted by the plugin, with no host-assembly wiring, so the npm install path works as-is. The `devflow` model tool (`next` / `report`) is called by the session pump to execute implement / fix-code / verify / merge tasks.

## Publishing

1. `peerDependencies` already declare npm version ranges; the `link:` dependencies exist only in the iteration copy under `devDependencies`/`dependencies` — switch back to npm ranges and verify before publishing (the `@deepseek-ai/dsh-*` rc versions on npm currently lag the harness checkout; switch once they catch up).
2. `pnpm --filter dsh-devflow publish --access public`
3. Add the topic `dsh-plugin` to the GitHub repo (the official ecosystem's discovery mechanism).
