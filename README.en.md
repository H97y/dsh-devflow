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

## Installation (end users)

Once published to npm, one command handles both the dependency and the
composition wiring (the `dsh.bundle` manifest + the in-package
`cordis.patch.yml` take effect automatically):

```bash
dsh plugin --profile web add dsh-devflow
```

`root` defaults to the process working directory; to point it at a specific
workspace, override it in your own profile patch layer
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

Manual equivalent before the npm release:

```bash
cd ~/.dsh/profiles/web
pnpm add dsh-devflow
```

and add the insert row to `cordis.patch.yml`:

```yaml
- insert:
    - id: devflow
      name: dsh-devflow
```

The browser UI mounts in two additive places: the entry button registers in `sidebar.footer.action` (sidebar foot, beside Settings, styled to match the native trigger rows; collapses to a 56px rail circle, carries a waiting-decision count badge); clicking it opens a full main-area page through `shell.overlay` (anchored to the sidebar's live right edge, tracking drags/collapses; a two-column master-detail layout — pool column with grouped sections on the left, item detail / artifact viewer / stage prompt editor on the right; Escape unwinds level by level). The browser half `$mount`s this package's generated `/remote` artifact itself — the `remote.devflow` namespace is mounted by the plugin, with no host-assembly wiring, so the npm install path works as-is. The `devflow` model tool (`next` / `report`) is called by the session pump to execute implement / fix-code / verify / merge tasks.

## Publishing

1. `peerDependencies` already declare npm version ranges; the `link:` dependencies exist only in the iteration copy under `devDependencies`/`dependencies` — switch back to npm ranges and verify before publishing (the `@deepseek-ai/dsh-*` rc versions on npm currently lag the harness checkout; switch once they catch up).
2. `pnpm --filter dsh-devflow publish --access public`
3. Add the topic `dsh-plugin` to the GitHub repo (the official ecosystem's discovery mechanism).
