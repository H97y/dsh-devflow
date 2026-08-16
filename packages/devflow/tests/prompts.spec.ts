/**
 * Prompt-template unit coverage: the defaults stay structurally renderable
 * and the override/var-substitution contract holds for every stage.
 * @module @deepseek-ai/dsh-devflow/tests/prompts
 */

import { describe, expect, it } from 'vitest'
import { DEFAULT_PROMPTS, PROMPT_VARS, renderPrompt } from '../src/prompts.ts'
import type { DevflowPromptStage } from '../src/prompts.ts'

describe('devflow prompts', () => {
  it('keeps every stage key aligned between templates and variable lists', () => {
    expect(Object.keys(PROMPT_VARS).sort()).toEqual(Object.keys(DEFAULT_PROMPTS).sort())
  })

  it('substitutes known variables and leaves unknown placeholders literal', () => {
    const rendered = renderPrompt('design', { design: 'repo={{repo}} oops={{oops}}' }, {
      repo: 'REPO-CTX',
      requirement: 'REQ',
      answers: '',
    })
    // {{repo}} resolves from the bag; {{oops}} has no value so it must stay
    // literal (visible in the model input) rather than silently vanish.
    expect(rendered).toBe('repo=REPO-CTX oops={{oops}}')
  })

  it('falls back to the default template when no override exists', () => {
    const rendered = renderPrompt('refine', {}, { repo: 'R', batch: 'B' })
    expect(rendered).toContain('R')
    expect(rendered).toContain('B')
    expect(rendered).toContain('请批量精炼优化')
  })

  it('renders every default stage with a full variable bag', () => {
    const bag: Record<string, string> = {
      repo: 'r', batch: 'b', requirement: 'q', answers: 'a', design: 'd', plan: 'p',
      issues: 'i', implReport: 'ir', fixReport: 'fr', files: 'f',
      reviews: 'rv', impls: 'im', fixes: 'fx', verifies: 'vf',
    }
    for (const stage of Object.keys(DEFAULT_PROMPTS) as DevflowPromptStage[]) {
      const rendered = renderPrompt(stage, {}, bag)
      // Every variable the stage declares must resolve in the output.
      for (const name of PROMPT_VARS[stage]) expect(rendered).toContain(bag[name]!)
      // And no declared-variable placeholder may survive unresolved.
      expect(rendered).not.toMatch(new RegExp(`\\{\\{(${PROMPT_VARS[stage].join('|')})\\}\\}`))
    }
  })
})
