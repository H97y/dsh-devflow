/**
 * Default stage prompt templates with variable substitution. Users override
 * any stage through the panel editor; overrides persist in
 * `.devflow/prompts.json` and take effect on the next model call.
 *
 * @module @deepseek-ai/dsh-devflow/src/prompts
 */

/** Stage keys a template may be registered under. */
export type DevflowPromptStage =
  | 'system'
  | 'refine'
  | 'design'
  | 'plan'
  | 'reviewDp'
  | 'fixDesign'
  | 'fixPlan'
  | 'codeReview'
  | 'report'

/** Built-in templates: a strong default per stage. */
export const DEFAULT_PROMPTS: Record<DevflowPromptStage, string> = {
  system: '你是资深全栈工程师，严格遵守项目规范（YAGNI、外科手术式修改、遵循现有约定、最小改动）。'
    + '核心原则：所有可能阻塞进度的决策，必须依据项目规范和工程经验自动决策，并在产出中记录决策与理由；'
    + '只有不可逆、依赖外部系统或账号、或与项目规范冲突的决策，才允许生成用户问题(questions)。'
    + '除明确说明外，输出必须是单个合法JSON对象，不要输出JSON以外的文字。',
  refine: '{{repo}}\n\n【需求池原始条目】\n{{batch}}\n'
    + '请批量精炼优化这些需求/bug：结合项目结构补充完整描述与验收标准（合理推断，不虚构业务事实），'
    + '评估价值与信息完整度，并评估实施规模 size：small=预计≤3个文件且单模块、无迁移/架构变更；'
    + 'medium=4~8个文件或跨模块协作；large=>8个文件或涉及数据库迁移/架构调整。'
    + '仅当关键意图确实缺失、无法开工时才标 incomplete=true 并给出 questions（每问2-4个选项并推荐其一）。'
    + '价值过低(≤2)或与项目无关可 reject=true。\n'
    + '输出JSON: {"items":[{"id":"","title":"","value":0,"completeness":0,"size":"small|medium|large",'
    + '"context":"","acceptance":[""],"scope":"","incomplete":false,'
    + '"questions":[{"id":"q1","q":"","options":[{"label":"","desc":""}],"recommend":""}],'
    + '"reject":false,"reason":""}]}',
  design: '{{repo}}\n\n【精炼后的需求】\n{{requirement}}{{answers}}\n'
    + '请产出技术设计文档(markdown)。必须包含：目标与背景、方案设计与选型理由（每个决策点给出自动决策及依据的规范/约定）、'
    + '模块与接口变更、数据结构变更、影响面、风险与回滚。\n'
    + '输出JSON: {"design":"# markdown文档","questions":[]}',
  plan: '【需求】\n{{requirement}}\n\n【设计文档】\n{{design}}{{answers}}\n'
    + '请产出详细实施计划(markdown)。分步骤，每步包含：改动文件路径、具体改动内容、验证方式；标注步骤间依赖；'
    + '涉及迁移/配置/风险处显式标注。\n'
    + '输出JSON: {"plan":"# markdown计划","questions":[]}',
  reviewDp: '【需求】{{requirement}}\n\n【设计文档】\n{{design}}\n\n【实施计划】\n{{plan}}{{answers}}\n'
    + '请严格评审设计与计划的组合质量：需求覆盖度、方案正确性、规范符合性、步骤可执行性、风险遗漏。'
    + '一般问题直接进 issues 给修复建议；仅必须用户拍板的进 questions。\n'
    + '输出JSON: {"verdict":"pass"|"issues","issues":[{"severity":"high|mid|low","what":"","why":"","fix":""}],"questions":[]}',
  fixDesign: '【设计文档】\n{{design}}\n\n【评审问题】\n{{issues}}\n'
    + '请修订设计文档解决上述全部问题，输出完整修订版（保持markdown）。\n输出JSON: {"doc":"markdown"}',
  fixPlan: '【修订后设计】\n{{design}}\n\n【实施计划】\n{{plan}}\n\n【评审问题】\n{{issues}}\n'
    + '请修订实施计划解决上述全部问题并与修订后设计保持一致，输出完整修订版。\n输出JSON: {"doc":"markdown"}',
  codeReview: '【需求】{{requirement}}\n【实施计划（截断）】\n{{plan}}\n【实施者报告】\n{{implReport}}\n'
    + '【最近修复报告】\n{{fixReport}}\n【全部改动文件内容（截断）】\n{{files}}{{answers}}\n'
    + '请严格评审上述代码实施：正确性、需求覆盖、规范符合（YAGNI/外科手术修改/约定一致）、错误处理、明显缺陷。\n'
    + '输出JSON: {"verdict":"pass"|"issues","issues":[{"severity":"","what":"","why":"","fix":""}],"questions":[]}',
  report: '请根据以下全过程材料生成最终开发报告(markdown)，包含：需求概述、设计要点、实施摘要、评审与修复轮次、'
    + '验证结果、合并结果、遗留问题、自动决策记录。\n【需求】{{requirement}}\n【设计（截断）】\n{{design}}\n'
    + '【计划（截断）】\n{{plan}}\n【评审记录】\n{{reviews}}\n【实施报告】\n{{impls}}\n【修复报告】\n{{fixes}}\n'
    + '【验证记录】\n{{verifies}}\n输出JSON: {"report":"# markdown报告"}',
}

/** Variables each stage template may reference. */
export const PROMPT_VARS: Record<DevflowPromptStage, readonly string[]> = {
  system: [],
  refine: ['repo', 'batch'],
  design: ['repo', 'requirement', 'answers'],
  plan: ['requirement', 'design', 'answers'],
  reviewDp: ['requirement', 'design', 'plan', 'answers'],
  fixDesign: ['design', 'issues'],
  fixPlan: ['design', 'plan', 'issues'],
  codeReview: ['requirement', 'plan', 'implReport', 'fixReport', 'files', 'answers'],
  report: ['requirement', 'design', 'plan', 'reviews', 'impls', 'fixes', 'verifies'],
}

/**
 * Render one stage's prompt: the user's override wins over the default, and
 * `{{var}}` placeholders resolve from the supplied values (unknown ones stay
 * literal so mistakes are visible in the model input rather than vanishing).
 * @param stage - template stage key.
 * @param custom - user overrides keyed by stage (may be empty).
 * @param vars - variable values available to this render.
 * @returns the fully rendered user-message text.
 */
export function renderPrompt(
  stage: DevflowPromptStage,
  custom: Record<string, string>,
  vars: Record<string, string>,
): string {
  const template = custom[stage] ?? DEFAULT_PROMPTS[stage]
  return template.replace(/\{\{(\w+)\}\}/g, (match, key: string) =>
    vars[key] ?? match)
}
