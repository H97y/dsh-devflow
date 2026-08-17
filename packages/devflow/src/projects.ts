/**
 * Project-partition helpers for multi-root isolation: deriving a stable,
 * filesystem-safe identity from one workspace root and merging configured
 * roots into the deduped project list. Pure functions only, so the identity
 * contract is unit-testable without a Cordis context.
 *
 * @module @deepseek-ai/dsh-devflow/src/projects
 */

/** Identity of one project partition. */
export interface ProjectIdentity {
  /** Filesystem-safe unique key: prefixes item ids, routes panel calls. */
  readonly key: string
  /** Human label for the panel switcher (the root's basename). */
  readonly name: string
}

/** Normalize one root for identity comparisons (trailing slashes only). */
export function normalizeRoot(root: string): string {
  return root.replace(/\/+$/, '')
}

/** 32-bit FNV-1a as 8 hex chars (deterministic, dependency-free). */
function fnv1a(value: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}

/** Longest meaningful path segment of the root. */
function baseName(root: string): string {
  const segments = normalizeRoot(root).split('/').filter(segment => segment !== '')
  return segments.at(-1) ?? 'project'
}

/**
 * Filesystem names that mark a directory as a standalone project root (VCS
 * metadata or a package/manifest file). One hit is enough — discovery never
 * reads file contents, it only matches listing names.
 */
export const PROJECT_MARKERS: readonly string[] = [
  '.git', '.hg', '.svn',
  'package.json', 'pyproject.toml', 'requirements.txt', 'setup.py',
  'go.mod', 'Cargo.toml', 'pom.xml', 'build.gradle', 'build.gradle.kts',
  'settings.gradle', 'settings.gradle.kts', 'mix.exs', 'composer.json',
  'Gemfile', 'CMakeLists.txt', 'Makefile',
]

/**
 * Directory names never treated as projects during a workspace scan: hidden
 * entries are skipped separately, these are the visible non-project spaces
 * (dependency/vendor trees and OS-user standard folders).
 */
const SCAN_EXCLUDED = new Set([
  'node_modules', 'vendor',
  'Library', 'Applications', 'Movies', 'Music', 'Pictures', 'Public',
])

/**
 * Whether one directory's listing marks it as a project root.
 * @param names - the directory's entry names (hidden entries included).
 * @returns true when any project marker is present.
 */
export function isProjectDir(names: readonly string[]): boolean {
  return names.some(name => PROJECT_MARKERS.includes(name))
}

/**
 * Whether a scanned workspace child should be probed as a project candidate:
 * hidden and known vendored/dependency directories are skipped.
 * @param name - the child directory's basename.
 * @param type - the child's listing type.
 */
export function isScanCandidate(name: string, type: 'file' | 'directory' | 'other'): boolean {
  return type === 'directory' && !name.startsWith('.') && !SCAN_EXCLUDED.has(name)
}

/**
 * Derive one project's identity from its workspace root. The key pairs the
 * sanitized basename (clipped) with a 4-hex hash of the full path, so two
 * projects sharing a basename still land on distinct keys while the same
 * root spelled with trailing slashes stays stable.
 * @param root - absolute workspace root path.
 * @returns the partition key and the display name.
 */
export function projectIdentity(root: string): ProjectIdentity {
  const cleaned = baseName(root).replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '')
  const name = cleaned === '' ? 'project' : cleaned
  const clipped = name.length > 16 ? name.slice(0, 16) : name
  return { key: `${clipped}-${fnv1a(normalizeRoot(root)).slice(0, 4)}`, name }
}

/**
 * Merge the primary root with extra configured roots into the project list:
 * order-preserving, exact-path (trailing-slash-insensitive) dedupe, blanks
 * dropped, primary always first so it stays the default partition.
 * @param root - the primary (default) workspace root.
 * @param extra - additional configured workspace roots.
 * @returns deduped roots, primary first; never empty (root itself survives).
 */
export function uniqueRoots(root: string, extra: readonly string[]): string[] {
  const seen = new Set<string>()
  const roots: string[] = []
  for (const candidate of [root, ...extra]) {
    const trimmed = candidate.trim()
    if (trimmed === '') continue
    const id = normalizeRoot(trimmed)
    if (seen.has(id)) continue
    seen.add(id)
    roots.push(trimmed)
  }
  return roots.length > 0 ? roots : [root]
}
