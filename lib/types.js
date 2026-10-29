/**
 * problem-bank 核心类型 v0.5
 * - 知识子图 + 题型骨架 → 抑制换皮
 * - 技巧/思路层（Technique）→ 同技巧、异题面的可控创新
 * - 多信号近重复 + 强制迁移采样
 */
/** frontmatter 格式版本：用于兼容迁移与往返校验 */
export const PROBLEM_SCHEMA_VERSION = 5;
export const INNOVATION_OPERATOR_HINTS = {
    transfer_domain: '换知识载体：代数↔几何↔概率↔复数/向量；条件结构与题面领域须与 exemplar 不同',
    change_goal: '换设问目标：求值→参数范围 / 存在性 / 计数 / 证明；答案形态须变化',
    couple: '技巧组合：主技巧 + 第二技巧（或 application 知识点）必须在关键一步同时出现',
    inverse: '逆问题：以原技巧的典型结论为已知，反推条件、参数范围或存在性',
    critical: '临界化：把「求值/证明」改成「常数是否可改进 / 等号是否可达」',
};
export const VARIATION_TYPE_LABELS = {
    original: '原始题（非变式）',
    isomorphic: '同构变式（保持推理深度，改表述或参数）',
    structural: '结构变式（保留核心思想，换关键结构）',
    harder: '增难变式（新增推理障碍）',
    extension: '拓展变式（推广结论或研究边界）',
    simplified: '降难变式（教学模式，不计为创新）',
};
