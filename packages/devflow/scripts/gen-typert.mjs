#!/usr/bin/env node
/**
 * Regenerate the vendored Typert wire quartet into wire/ without touching the
 * harness checkout.
 *
 * Why a scratch workspace: the generator registers packages from the
 * aggregate tsconfig's project references (package roots must physically sit
 * under `<root>/packages/`), and `@Remote` decorators are only recognized
 * when the `Remote` symbol's declaration belongs to a registered
 * `@deepseek-ai/dsh-typert-protocol` package. That layout exists naturally
 * in the harness monorepo — hence the old copy-into-harness dance — but a
 * throwaway workspace inside THIS repo provides the same shape: real copies
 * of this package and the protocol package, a temp aggregate referencing
 * both, and a `paths` mapping so the analyzed program resolves the protocol
 * import to the local copy (node_modules links would realPath back to the
 * harness tree and fail registration). Everything lands in .typert-gen/,
 * which is removed afterwards; the harness checkout stays read-only.
 *
 * Run after changing the @Remote method face:
 *   pnpm --filter dsh-devflow run gen:typert   (then pnpm build copies wire/ → lib/)
 */
import { cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { WorkspaceTypertGenerator } from '@deepseek-ai/dsh-typert-generator'

const pkgRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const repoRoot = resolve(pkgRoot, '../..')
// Resolved through this package's node_modules links (which point at the
// harness checkout); the copies below reuse those same link targets.
const protocolSrc = resolve(pkgRoot, 'node_modules/@deepseek-ai/dsh-typert-protocol/src')
const protocolManifest = resolve(pkgRoot, 'node_modules/@deepseek-ai/dsh-typert-protocol/package.json')
const cordisLink = resolve(pkgRoot, 'node_modules/@deepseek-ai/cordis')
const invariantsLink = resolve(pkgRoot, 'node_modules/@deepseek-ai/dsh-invariants')

const scratch = join(repoRoot, '.typert-gen')
rmSync(scratch, { recursive: true, force: true })

try {
  // 1) Real package copies under <scratch>/packages/ (symlinks would fail
  //    the generator's realPath-based registration check).
  const flowDir = join(scratch, 'packages/devflow')
  const protoDir = join(scratch, 'packages/typert-protocol')
  mkdirSync(flowDir, { recursive: true })
  for (const entry of ['src', 'package.json', 'tsconfig.json', 'tsconfig.client.json']) {
    cpSync(join(pkgRoot, entry), join(flowDir, entry), { recursive: true })
  }
  cpSync(protocolSrc, join(protoDir, 'src'), { recursive: true })
  cpSync(protocolManifest, join(protoDir, 'package.json'))
  // Minimal parseable project config: registration only needs it to parse
  // (the protocol copy is never a selected generation target).
  writeFileSync(join(protoDir, 'tsconfig.json'), `${JSON.stringify({
    compilerOptions: {
      target: 'es2024',
      module: 'esnext',
      moduleResolution: 'bundler',
      strict: true,
      skipLibCheck: true,
      allowImportingTsExtensions: true,
      noEmit: true,
    },
    include: ['src'],
  }, null, 2)}\n`)
  // The devflow copy keeps resolving its deps through the real package's
  // node_modules; the protocol copy needs cordis + dsh-invariants links of
  // its own (same link targets the real package uses).
  symlinkSync(resolve(pkgRoot, 'node_modules'), join(flowDir, 'node_modules'), 'dir')
  const protoModules = join(protoDir, 'node_modules/@deepseek-ai')
  mkdirSync(protoModules, { recursive: true })
  symlinkSync(cordisLink, join(protoModules, 'cordis'), 'dir')
  symlinkSync(invariantsLink, join(protoModules, 'dsh-invariants'), 'dir')

  // 2) Temp host aggregate: repo compiler options + the paths override that
  //    pins the protocol specifier to the registered local copy.
  writeFileSync(join(scratch, 'tsconfig.host.json'), `${JSON.stringify({
    compilerOptions: {
      target: 'es2024',
      module: 'esnext',
      moduleResolution: 'bundler',
      lib: ['ES2024'],
      types: ['node'],
      strict: true,
      skipLibCheck: true,
      esModuleInterop: true,
      allowImportingTsExtensions: true,
      rewriteRelativeImportExtensions: true,
      baseUrl: '.',
      paths: { '@deepseek-ai/dsh-typert-protocol': ['packages/typert-protocol/src/index.ts'] },
    },
    files: [],
    references: [
      { path: './packages/devflow' },
      { path: './packages/typert-protocol' },
    ],
  }, null, 2)}\n`)

  // 3) Generate the host face only (no ./client/typert export here; the
  //    remote-client artifacts ride on the host artifact) and write the
  //    quartet straight into wire/.
  const artifacts = new WorkspaceTypertGenerator(scratch).generate(['dsh-devflow'], ['host'])
  const wireDir = join(pkgRoot, 'wire')
  mkdirSync(wireDir, { recursive: true })
  let wrote = 0
  for (const artifact of artifacts) {
    writeFileSync(join(wireDir, `typert.${artifact.face}.js`), artifact.js)
    writeFileSync(join(wireDir, `typert.${artifact.face}.d.ts`), artifact.dts)
    wrote += 2
    if (artifact.face === 'host' && artifact.remote !== undefined) {
      writeFileSync(join(wireDir, 'typert.remote-client.js'), artifact.remote.js)
      writeFileSync(join(wireDir, 'typert.remote-client.d.ts'), artifact.remote.dts)
      wrote += 2
    }
  }
  console.log(`gen-typert: wrote ${wrote} file(s) to ${wireDir}`)
} finally {
  rmSync(scratch, { recursive: true, force: true })
}
