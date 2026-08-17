/**
 * Project-partition identity coverage: the key contract that makes per-project
 * isolation routable (stable per root, distinct across roots, filesystem-safe
 * for ids/branches/paths) plus the configured-roots merge rules.
 * @module @deepseek-ai/dsh-devflow/tests/projects
 */

import { describe, expect, it } from 'vitest'
import { isProjectDir, isScanCandidate, projectIdentity, uniqueRoots } from '../src/projects.ts'

describe('devflow project identity', () => {
  it('derives a filesystem-safe key from the root basename', () => {
    const { key, name } = projectIdentity('/Users/heyue/work/dsh-devflow')
    expect(name).toBe('dsh-devflow')
    expect(key).toMatch(/^dsh-devflow-[0-9a-f]{4}$/)
    // The key embeds the name; ids/branches built from it stay readable.
    expect(key.startsWith('dsh-devflow-')).toBe(true)
  })

  it('disambiguates same-basename roots by the path hash', () => {
    const a = projectIdentity('/work/api')
    const b = projectIdentity('/home/me/api')
    expect(a.name).toBe(b.name)
    expect(a.key).not.toBe(b.key)
  })

  it('is stable across trailing slashes', () => {
    expect(projectIdentity('/work/api/').key).toBe(projectIdentity('/work/api').key)
  })

  it('sanitizes hostile basenames and clips long ones in the key', () => {
    expect(projectIdentity('/work/My Project!').name).toBe('My-Project')
    const long = projectIdentity(`/work/${'x'.repeat(40)}`)
    // Display name keeps the full basename; the key clips to 16 chars.
    expect(long.name).toBe('x'.repeat(40))
    expect(long.key.startsWith(`${'x'.repeat(16)}-`)).toBe(true)
  })

  it('falls back to a stable identity for empty roots', () => {
    expect(projectIdentity('/').name).toBe('project')
    expect(projectIdentity('/').key).toBe(projectIdentity('//').key)
    expect(projectIdentity('/').key).toMatch(/^project-[0-9a-f]{4}$/)
  })
})

describe('devflow project discovery markers', () => {
  it('recognizes VCS metadata and package manifests as project roots', () => {
    expect(isProjectDir(['.git', 'docs'])).toBe(true)
    expect(isProjectDir(['src', 'package.json', 'readme.md'])).toBe(true)
    expect(isProjectDir(['go.mod'])).toBe(true)
    expect(isProjectDir(['src', 'tests', 'readme.md'])).toBe(false)
    expect(isProjectDir([])).toBe(false)
  })

  it('skips hidden and vendored directories as scan candidates', () => {
    expect(isScanCandidate('my-repo', 'directory')).toBe(true)
    expect(isScanCandidate('.worktrees', 'directory')).toBe(false)
    expect(isScanCandidate('node_modules', 'directory')).toBe(false)
    expect(isScanCandidate('Library', 'directory')).toBe(false)
    expect(isScanCandidate('package.json', 'file')).toBe(false)
  })
})

describe('devflow uniqueRoots', () => {
  it('keeps the primary root first and dedupes exact repeats', () => {
    expect(uniqueRoots('/work/a', ['/work/b', '/work/a/', '/work/b'])).toEqual(['/work/a', '/work/b'])
  })

  it('drops blank entries and never returns an empty list', () => {
    expect(uniqueRoots('/work/a', ['  ', ''])).toEqual(['/work/a'])
    expect(uniqueRoots(' /work/x ', [])).toEqual(['/work/x'])
  })
})
