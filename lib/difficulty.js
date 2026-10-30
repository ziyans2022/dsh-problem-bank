/**
 * 多维难度评价（v0.6）
 *
 * 六维各 1–5 级，不给加权总分：一般性高不代表难，计算量大也不代表概念深，
 * 用一个平均数会把「概念深但计算轻」和「概念浅但算得烦」压成同一档。
 * 因此对外只提供「逐维比较」与「槽位硬约束」两种用法。
 */
export const DIFFICULTY_DIMENSIONS = [
    'conceptual',
    'technical',
    'proofDepth',
    'prerequisiteLoad',
    'ingenuity',
    'generality',
];
export const DIMENSION_LABELS = {
    conceptual: '概念难度',
    technical: '技术难度',
    proofDepth: '证明深度',
    prerequisiteLoad: '前置知识负担',
    ingenuity: '创造性',
    generality: '一般性负担',
};
/**
 * 固定 rubric：1/3/5 是锚点，2/4 明确为相邻等级的中间情形。
 * 评分必须给 rationale，评审时对照锚点，而不是让模型自由发挥。
 */
export const RUBRIC = {
    conceptual: {
        1: '直接套用定义或单一概念，无需理解结构',
        2: '单一概念加一处变形，属于 1 与 3 之间的情形',
        3: '需要把两个以上概念联系起来才能读懂题意',
        4: '多个概念之间需要一次非平凡的联系，属于 3 与 5 之间的情形',
        5: '需要跨领域抽象或概念迁移，读懂题目本身就是难点',
    },
    technical: {
        1: '一步代入或一次简单运算',
        2: '两三步常规运算，属于 1 与 3 之间的情形',
        3: '多步变形或需要选择运算顺序',
        4: '多步运算且中途易错，属于 3 与 5 之间的情形',
        5: '需要精细估计、复杂计算或大量代数操作',
    },
    proofDepth: {
        1: '直接由定义推出，一两行完成',
        2: '两步推理，属于 1 与 3 之间的情形',
        3: '需要多层推理，中间结论本身需要论证',
        4: '多层推理且存在一处需要额外引理，属于 3 与 5 之间的情形',
        5: '非平凡构造加多阶段证明，关键引理不显然',
    },
    prerequisiteLoad: {
        1: '只用到本章基础定义',
        2: '用到前一章的一两个结论，属于 1 与 3 之间的情形',
        3: '需要两三个知识模块配合',
        4: '需要跨模块且其中一块不常考，属于 3 与 5 之间的情形',
        5: '依赖高阶理论或竞赛级结论',
    },
    ingenuity: {
        1: '标准模板，照着例题走',
        2: '模板加一处小调整，属于 1 与 3 之间的情形',
        3: '需要在一两个常规策略里做选择',
        4: '需要在多个策略中判断，且有一条是死路，属于 3 与 5 之间的情形',
        5: '需要发现非标准构造或不变量，事先看不出方向',
    },
    generality: {
        1: '只问一个具体实例',
        2: '有限个情形，逐例处理，属于 1 与 3 之间的情形',
        3: '对含参数的族成立，需要讨论参数范围',
        4: '对一族对象统一成立，且要说明适用范围，属于 3 与 5 之间的情形',
        5: '广泛的一般性结论，或要求推广到更抽象的结构',
    },
};
export function isDifficultyLevel(n) {
    return typeof n === 'number' && Number.isInteger(n) && n >= 1 && n <= 5;
}
/** 校验六维剖面；返回错误列表（空数组即通过） */
export function validateDimensionalProfile(profile) {
    const errors = [];
    if (!profile)
        return ['缺少 difficultyProfile'];
    if (profile.rubricVersion !== 1) {
        errors.push(`rubricVersion 必须是 1，当前 ${String(profile.rubricVersion)}`);
    }
    for (const dim of DIFFICULTY_DIMENSIONS) {
        const rating = profile.dimensions?.[dim];
        if (!rating) {
            errors.push(`缺维度 ${dim}（${DIMENSION_LABELS[dim]}）`);
            continue;
        }
        if (!isDifficultyLevel(rating.level)) {
            errors.push(`${dim}.level 必须是 1–5 的整数`);
        }
        if (!rating.rationale || !rating.rationale.trim()) {
            errors.push(`${dim} 缺少 rationale：评分必须写理由`);
        }
    }
    if (profile.overall != null && !isDifficultyLevel(profile.overall)) {
        errors.push('overall 必须是 1–5 的整数（可选字段）');
    }
    if (!['human', 'model', 'empirical'].includes(profile.assessedBy)) {
        errors.push('assessedBy 必须是 human / model / empirical');
    }
    if (!['pending', 'reviewed'].includes(profile.reviewStatus)) {
        errors.push('reviewStatus 必须是 pending / reviewed');
    }
    if (profile.assessedBy === 'model' && profile.reviewStatus === 'reviewed') {
        errors.push('模型初评不得直接标记 reviewed：必须经过人工审核');
    }
    if (profile.reviewStatus === 'reviewed' && !profile.reviewedBy) {
        errors.push('reviewed 状态必须记录 reviewedBy');
    }
    return errors;
}
export function compareProfiles(aId, bId, a, b) {
    const dimensions = DIFFICULTY_DIMENSIONS.map((dim) => {
        const ra = a?.dimensions?.[dim]?.level;
        const rb = b?.dimensions?.[dim]?.level;
        return {
            dimension: dim,
            label: DIMENSION_LABELS[dim],
            a: ra,
            b: rb,
            delta: ra != null && rb != null ? rb - ra : undefined,
        };
    });
    const harder = dimensions
        .filter((d) => (d.delta ?? 0) > 0)
        .map((d) => d.dimension);
    const easier = dimensions
        .filter((d) => (d.delta ?? 0) < 0)
        .map((d) => d.dimension);
    const missing = dimensions.filter((d) => d.delta == null).length;
    const note = missing === DIFFICULTY_DIMENSIONS.length
        ? '两题都没有六维剖面，无法比较'
        : `逐维比较（正数表示 ${bId} 更难）；未做加权平均——不同维度不可互相补偿`;
    return { aId, bId, dimensions, harderDimensions: harder, easierDimensions: easier, note };
}
/** 槽位硬约束：任一维度越界即拒绝，不做加权抵消 */
export function checkSlotConstraints(profile, target) {
    if (!target || Object.keys(target).length === 0) {
        return { ok: true, failed: [], missingProfile: false };
    }
    if (!profile) {
        return { ok: false, failed: ['缺少 difficultyProfile，无法校验六维约束'], missingProfile: true };
    }
    const failed = [];
    for (const dim of DIFFICULTY_DIMENSIONS) {
        const range = target[dim];
        if (!range)
            continue;
        const rating = profile.dimensions?.[dim];
        if (!rating) {
            failed.push(`${DIMENSION_LABELS[dim]}: 未评分`);
            continue;
        }
        if (range.min != null && rating.level < range.min) {
            failed.push(`${DIMENSION_LABELS[dim]}: ${rating.level} < 下限 ${range.min}`);
        }
        if (range.max != null && rating.level > range.max) {
            failed.push(`${DIMENSION_LABELS[dim]}: ${rating.level} > 上限 ${range.max}`);
        }
    }
    return { ok: failed.length === 0, failed, missingProfile: false };
}
/** 给工具输出用的 rubric 摘要 */
export function rubricSummary() {
    return {
        version: 1,
        dimensions: DIFFICULTY_DIMENSIONS.map((dim) => ({
            id: dim,
            label: DIMENSION_LABELS[dim],
            anchors: { 1: RUBRIC[dim][1], 3: RUBRIC[dim][3], 5: RUBRIC[dim][5] },
        })),
        note: '2/4 级定义为相邻锚点之间的中间情形；六维不做加权平均，评分必须写 rationale',
    };
}
