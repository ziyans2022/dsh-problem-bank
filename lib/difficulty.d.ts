/**
 * 多维难度评价（v0.6）
 *
 * 六维各 1–5 级，不给加权总分：一般性高不代表难，计算量大也不代表概念深，
 * 用一个平均数会把「概念深但计算轻」和「概念浅但算得烦」压成同一档。
 * 因此对外只提供「逐维比较」与「槽位硬约束」两种用法。
 */
import type { DifficultyDimension, DifficultyLevel, DimensionalDifficultyProfile, DimensionRating, PaperSlot } from './types.js';
export declare const DIFFICULTY_DIMENSIONS: DifficultyDimension[];
export declare const DIMENSION_LABELS: Record<DifficultyDimension, string>;
/**
 * 固定 rubric：1/3/5 是锚点，2/4 明确为相邻等级的中间情形。
 * 评分必须给 rationale，评审时对照锚点，而不是让模型自由发挥。
 */
export declare const RUBRIC: Record<DifficultyDimension, {
    1: string;
    2: string;
    3: string;
    4: string;
    5: string;
}>;
export declare function isDifficultyLevel(n: unknown): n is DifficultyLevel;
/** 校验六维剖面；返回错误列表（空数组即通过） */
export declare function validateDimensionalProfile(profile: DimensionalDifficultyProfile | undefined): string[];
export interface DimensionComparison {
    dimension: DifficultyDimension;
    label: string;
    a?: DifficultyLevel;
    b?: DifficultyLevel;
    /** b - a，正数表示 b 更难 */
    delta?: number;
}
export interface ProfileComparison {
    aId: string;
    bId: string;
    dimensions: DimensionComparison[];
    /** 只在双方都有评分的维度上统计 */
    harderDimensions: DifficultyDimension[];
    easierDimensions: DifficultyDimension[];
    note: string;
}
export declare function compareProfiles(aId: string, bId: string, a?: DimensionalDifficultyProfile, b?: DimensionalDifficultyProfile): ProfileComparison;
export interface SlotConstraintResult {
    ok: boolean;
    failed: string[];
    missingProfile: boolean;
}
/** 槽位硬约束：任一维度越界即拒绝，不做加权抵消 */
export declare function checkSlotConstraints(profile: DimensionalDifficultyProfile | undefined, target: PaperSlot['targetDifficultyProfile']): SlotConstraintResult;
/** 给工具输出用的 rubric 摘要 */
export declare function rubricSummary(): {
    version: 1;
    dimensions: {
        id: DifficultyDimension;
        label: string;
        anchors: {
            1: string;
            3: string;
            5: string;
        };
    }[];
    note: string;
};
export type { DimensionRating };
