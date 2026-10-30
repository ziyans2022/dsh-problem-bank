// 运行期注入到系统提示里的短摘要。
//
// 为什么只注入摘要，不注入 SYSTEM_PROMPT.md 全文：
// 系统提示是每次请求都要付的固定成本，而这个插件已经往上下文里注册了 42 个工具
// 的 schema。把两千字的完整说明塞进系统提示，会把「省 token」这个卖点抵消掉。
// 完整说明留在 SYSTEM_PROMPT.md 里，供人和市场评审阅读。

/** 段落名：与插件 id 保持一致，便于在 `system-prompt` 的排序里定位。 */
export const PROMPT_SECTION = 'problem-bank'

/**
 * 排序值。DSH 内置段落在 100 以内，插件段放在 120 附近，
 * 保证「工具用法」出现在「任务背景」之后、尾部约束之前。
 */
export const PROMPT_ORDER = 120

/** 摘要正文。改这里记得同步 README 的「模型会看到什么」。 */
export function promptText(): string {
  return [
    '[problem-bank] 结构化数学题库已启用。',
    '出题：sample_by_technique 取硬约束与样板 → 先定数学结构再写题面 → 独立求解 →',
    'record_variation_intent 声明变式类型与难度目标 → audit_variation 过质量门 →',
    'submit_for_review → review_problem → commit_problem。',
    '硬规则：变式必须写明保留了什么核心难点、新增了什么推理要求；',
    '把一般性问题截成特例会被质量门拒绝；变式入库前还要 review_innovation。',
  ].join('\n')
}
