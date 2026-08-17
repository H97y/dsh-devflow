# dsh-devflow

An automated development pipeline plugin for DeepSeek Harness: requirement pool → LLM batch refinement (with size assessment) → best-candidate selection → design → plan → review & revision loops (≤3 rounds) → implementation (small items in the main workspace / medium-large items in worktrees) → code review loops (≤3 rounds) → web verification → integration-branch merge back to main → development report.

Every potentially blocking decision is made automatically by the model following project conventions by default; the few that genuinely need a human ruling enter the per-stage waiting queue and auto-resume once answered on the page. All state persists under `<root>/.devflow/`. Requirement pools are isolated per project with zero configuration: projects under the workspace are auto-discovered, any folder can be added or removed from the panel, and multiple projects' pipelines run in parallel.

The browser side is a native embedded UI (not a floating popup): an entry at the sidebar foot (same level as "Settings") opens a full main-area workbench page. The plugin mounts its own generated Remote namespace, modifies no harness product source, and works out of the box with `pnpm add`.

## Repository layout

```
├── package.json / pnpm-workspace.yaml / tsconfig.{host,client}.json   # repo shell and aggregate build graph
├── packages/devflow/          # publishable package dsh-devflow
│   ├── src/index.ts           # host service: per-project state machines + LLM stages + devflow model tool
│   ├── src/projects.ts        # project markers + partition identity (key derivation)
│   ├── src/prompts.ts         # 9-stage default prompts + {{variable}} rendering
│   ├── src/types.ts           # public types
│   ├── src/client/            # browser UI (sidebar entry + main-area page with project switcher)
│   └── lib/typert.*           # vendored wire artifacts (see below)
└── scripts/
    ├── tsdown.client.ts       # browser-bundle preset vendored from harness
    ├── platform.ts            # vendored platform-module table
    ├── vendor-typert.sh       # legacy: copy + rename the typert quartet from harness (manual)
    └── sync-to-profile.sh     # dev loop: link into the dsh profile + rebuild this repo
```

## Dev loop (local harness checkout used read-only)

Iterating depends on `link:` pointers into a local `deepseek-harness` checkout (its npm releases currently lag the checkout); the paths are hardcoded in `packages/devflow/package.json` — adjust to taste. **The harness checkout stays unmodified**: the plugin installs into `~/.dsh/profiles/web` as a link, the composition row `dsh-devflow` resolves to this repo through the profile's node_modules, and the web server's `/plugins` route serves `lib/client.js` straight from this repo (no-cache).

```bash
pnpm install && pnpm build && pnpm test   # this repo builds standalone
pnpm sync:profile                         # link into the profile (restart dsh web after the first link / composition change)
```

Day-to-day iteration: edit code → `pnpm build` → reload the browser page (no restart, no harness involvement).

**Why the typert wire artifacts are vendored & how to regenerate**: the generator's workspace discovery requires the analyzed package and `@deepseek-ai/dsh-typert-protocol` to sit as real directories under one `<root>/packages/` (its `@Remote` recognition resolves the decorator symbol against registered packages). When the `@Remote` method surface changes, run `pnpm --filter dsh-devflow run gen:typert`: it assembles a throwaway workspace (`.typert-gen/`, git-ignored) with real copies of this package and the protocol package plus a temp aggregate that pins the protocol import to the local copy, regenerates the quartet straight into `wire/`, and cleans up — the harness checkout stays read-only. (`scripts/vendor-typert.sh`, the older copy-into-harness dance, remains as a fallback.)

## Quick start (install and first use)

> **Publish status**: `dsh-devflow@0.1.0` is live on npm
> ([registry](https://www.npmjs.com/package/dsh-devflow)) — one command to
> install; building from source is only for developers.

### Prerequisites

- The DeepSeek Harness CLI installed (`npm i -g @deepseek-ai/dsh`, any recent
  rc) and `dsh web` runnable; the `sidebar.footer.action` slot the entry uses
  needs a recent rc line
- pnpm as the profile plugin installer (set up by dsh)

### Install (npm, recommended)

One command handles the dependency and the composition wiring (the
`dsh.bundle` manifest + the in-package `cordis.patch.yml` take effect
automatically; the `@deepseek-ai/*` peers come preinstalled with the
deployment — nothing manual):

```bash
dsh plugin --profile web add dsh-devflow
```

### From source (developers only; needs a local deepseek-harness checkout)

Runtime dependencies are all on npm now; only build-time types still use
`link:` paths into a local harness checkout (see the dev-loop section).
After cloning, point the `link:/...` entries in
`packages/devflow/package.json` at your own checkout, then build and link
into the profile:

```bash
git clone https://github.com/H97y/dsh-devflow.git
cd dsh-devflow
# Edit packages/devflow/package.json: change link:/Users/heyue/deepseek-harness/...
#   to link:<your-harness-checkout>/... (build-time type resolution needs it too)
pnpm install && pnpm build && pnpm test
pnpm sync:profile        # link into ~/.dsh/profiles/web (DSH_PROFILE picks another)
```

### Configure the workspace

`root` defaults to the process working directory — point it at your projects
folder and you are done (nothing else to configure); to override it, edit
your profile patch layer (`~/.dsh/profiles/web/cordis.patch.yml`):

```yaml
- id: devflow
  config:
    root: /path/to/your/projects   # discovery scans here; the default project's .devflow/ lives under it
    # maxActive: 3                  # concurrent pipeline cap per project (default 3)
    # maxWorktrees: 2               # concurrent worktree cap per project (default 2)
    # logCap: 40                    # per-item log cap (default 40)
    # tickIntervalMs: 2000          # state machine tick (default 2000)
```

**Auto-discovery & panel management (zero config)**: the plugin scans `root`
for standalone project folders (directories carrying `.git` /
`package.json` / `go.mod`-style markers; a root that is itself a single repo
counts as one project, a projects folder is scanned two levels deep for
`~/projects/group/repo` layouts) and lists them in the top-right switcher —
every project runs a fully isolated pool, `.devflow/` state, prompt
overrides, tick lane, and main-workspace/worktree budget, all in parallel.
Projects elsewhere are added through the「＋」beside the switcher: the OS
directory chooser, the in-app browse flow, or a pasted path (the same
picking capability the workspace manager uses), and can be removed or
restored at any time; manual adds and hides persist in
`<root>/.devflow/projects.json`. Item ids embed the project key
(`<key>-r<n>`), so panel operations and pump reports route automatically.

### Per-stage model configuration

The workbench header's "设置" (Settings) opens the unified settings pane:
every pipeline stage (refine / design / plan / review / code review /
report) can pick its own model, with candidates read-only from the models
configured in harness (the plugin manages no API keys). Unset stages fall
back to the harness-active model; a configured model later removed from
harness falls back at runtime and is flagged as drifted in the pane.
Saves take effect immediately and persist to `<root>/.devflow/settings.json`
(runtime state, untracked by git).

Reset semantics: **deleting settings.json re-imports legacy settings
rather than resetting to defaults**; to reset, edit the file content to
`{"version":1,"stageModels":{}}`.

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

`dsh-devflow@0.1.0` was published to npm on 2026-08-17. The flow for
subsequent releases:

1. Runtime dependencies are all npm ranges; the `link:` entries under
   `devDependencies` are build-time only and never ship. Where npm's
   `@deepseek-ai/dsh-*` rc versions lag the harness checkout, the
   `peerDependencies` `>=` ranges cover both (declared accordingly).
2. Bump `version` in `packages/devflow/package.json` → `pnpm build && pnpm
   test` → `pnpm --filter dsh-devflow publish --access public`
3. The GitHub repo already carries the `dsh-plugin` topic (the official
   ecosystem's discovery mechanism).
