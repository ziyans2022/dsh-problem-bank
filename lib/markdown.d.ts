/**
 * Markdown 解析与序列化（v0.6 拆出）
 *
 * 题目文件 = frontmatter（元数据，每行 `key: JSON`）+ 正文（题面 / 解析 / 额外解法 / 配图）。
 * 拆成纯函数后，迁移脚本与测试可以直接复用同一套读写，不必实例化 Service。
 */
import type { Problem } from './types.js';
export declare function serializeProblem(p: Problem): string;
/**
 * 按顶级标题切分正文。识别：
 * - ## 题面
 * - ## 解析
 * - ## 图形…（与 toMarkdown 一致，兼容旧「## 配图」）
 * 题面/解析内部的 ## 小问 等不切换分段。
 */
export declare function splitBodySections(body: string): {
    stem: string;
    solution: string;
    extraSolutions: {
        id: string;
        title: string;
        keyIdea: string;
        body: string;
    }[];
};
/**
 * 解析 frontmatter：每行 key: JSON
 * schemaVersion 缺失视为旧版（1），读入后不强制改写磁盘，下次 write 升到 PROBLEM_SCHEMA_VERSION
 */
export declare function parseProblem(raw: string, id: string): Problem;
