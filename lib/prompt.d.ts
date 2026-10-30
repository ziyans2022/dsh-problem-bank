/** 段落名：与插件 id 保持一致，便于在 `system-prompt` 的排序里定位。 */
export declare const PROMPT_SECTION = "problem-bank";
/**
 * 排序值。DSH 内置段落在 100 以内，插件段放在 120 附近，
 * 保证「工具用法」出现在「任务背景」之后、尾部约束之前。
 */
export declare const PROMPT_ORDER = 120;
/** 摘要正文。改这里记得同步 README 的「模型会看到什么」。 */
export declare function promptText(): string;
