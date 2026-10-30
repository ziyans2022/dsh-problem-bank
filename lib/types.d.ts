/**
 * problem-bank 核心类型 v0.6 — Structured Problem Intelligence
 * - 多解法结构化（Multi-Solution Architecture）
 * - 数学知识依赖图谱（Learning Graph + Mathematical Graph）
 * - 多维难度评价（Six-dimensional Difficulty Profile）
 * - 保留 v0.5：知识子图 + 题型骨架 + 技巧层 + 变式质量门
 */
export type ProblemStatus = 'draft' | 'pending_review' | 'approved' | 'rejected';
export type SourceType = 'pdf' | 'screenshot' | 'wechat' | 'lecture' | 'manual' | 'other';
export type AbilityLevel = '识记' | '理解' | '应用' | '分析' | '综合' | '评价' | '运算' | '推理' | '建模' | '直观想象' | '其他';
export type RelationType = 'prerequisite' | 'part-of' | 'equivalence' | 'equivalent' | 'contrast' | 'application' | 'implies' | 'generalizes' | 'specializes' | 'dual-to' | 'counterexample-to';
export type RelationLayer = 'learning' | 'mathematical';
export type EvidenceStatus = 'unreviewed' | 'source_supported' | 'human_verified';
/** 关键变形 / 解法动作 */
export type KeyMove = '分段讨论' | '换元' | '平方求和' | '积化和差' | '和差化积' | '构造辅助量' | '参数分离' | '数形结合' | '放缩' | '数学归纳' | '反证' | '分类讨论' | '对称性' | '最值转化为几何' | '待定系数' | '其他';
export type AnswerType = '数值' | '区间' | '表达式' | '参数范围' | '证明' | '存在性' | '计数' | '概率' | '其他';
export interface FigureSpec {
    type: 'tikz' | 'description' | 'image_path';
    content: string;
    caption?: string;
}
export interface ProblemSource {
    type: SourceType;
    originalRef?: string;
    uploader?: string;
    capturedAt?: string;
}
/**
 * 题型骨架：区分「同知识点换皮」与「真正结构创新」的关键
 * patternId 相同 + 参数级编辑 → 近重复一票否决
 */
export interface ProblemSkeleton {
    /** 稳定骨架 ID，如 ABS-RATIONAL-RANGE、TRIG-SUM-TO-PRODUCT */
    patternId: string;
    /** 关键变形步骤 */
    keyMoves: KeyMove[];
    /** 条件结构简述，如「双和条件→求和角正弦」 */
    conditionStructure: string;
    /** 答案形态 */
    answerType: AnswerType;
    /** 预估推理步数（1=直接套公式，≥3=需多步耦合） */
    estimatedSteps?: number;
    /** 是否要求多知识点在关键一步耦合 */
    requiresCoupling?: boolean;
}
/**
 * 技巧/思路节点：比知识点更「方法论」，比骨架更抽象
 * 用途：固定同一思路，强制题面/领域/条件结构完全不同 → 真正的结构创新
 * 例：TECH-PROJ-LINE（投影到直线）、TECH-COMPLETE-SQUARE、TECH-SYM-SUM-PRODUCT
 */
export interface Technique {
    id: string;
    name: string;
    /** 一句话说明核心思想 */
    idea: string;
    /** 常见关键动作 */
    typicalMoves: KeyMove[];
    /** 适用学科/主题提示 */
    domains?: string[];
    /** 示例说明（给生成模型看「什么叫同技巧」） */
    exemplarNote?: string;
    createdAt: string;
    updatedAt: string;
}
/** 单步证明 / 解题步骤 */
export interface SolutionStep {
    order: number;
    statement: string;
    justification?: string;
    knowledgeNodeIds?: string[];
    techniqueIds?: string[];
    theoremRefs?: string[];
}
export type SolutionVerification = 'unverified' | 'reviewed' | 'verified';
export type SolutionApproach = 'algebraic' | 'geometric' | 'analytic' | 'combinatorial' | 'synthetic' | 'other';
/** 一道题的一种独立解法；审核状态与主解法解耦 */
export interface ProblemSolution {
    id: string;
    title: string;
    approach: SolutionApproach;
    keyIdea: string;
    steps: SolutionStep[];
    /** 可选完整 Markdown 正文（与 steps 并存） */
    body?: string;
    techniqueIds: string[];
    verification: {
        status: SolutionVerification;
        reviewer?: string;
        notes?: string;
        checkedAt?: string;
    };
}
export interface ProblemContent {
    stem: string;
    /**
     * 兼容旧版：始终对应主解法的 Markdown 表示。
     * 写入时若存在 primarySolutionId，应与主解法同步。
     */
    solution: string;
    /** 多解法列表；缺省时由 solution 自动生成兼容单解法对象 */
    solutions?: ProblemSolution[];
    /** 主解法 id；缺省时取 solutions[0] 或 legacy 合成 id */
    primarySolutionId?: string;
    figures?: FigureSpec[];
    knowledgePoints: string[];
    difficulty: 1 | 2 | 3 | 4 | 5;
    /** 六维难度剖面（v0.6）；缺省为空，不自动推测旧题 */
    difficultyProfile?: DimensionalDifficultyProfile;
    tags?: string[];
    abilityLevels?: AbilityLevel[];
}
export interface ProblemReview {
    reviewer?: string;
    notes?: string;
    reviewedAt?: string;
    /** 审核时内容的哈希；内容再改动后该审核自动失效 */
    contentHash?: string;
    decision?: 'approve' | 'reject';
}
/** 创新审核留痕：commit 时校验它存在、通过且针对当前内容 */
export interface InnovationRecord {
    passed: boolean;
    notes: string[];
    reviewedAt: string;
    contentHash: string;
}
export interface ProblemLinks {
    lectureIds?: string[];
    backgroundArticleIds?: string[];
    relatedProblemIds?: string[];
}
export interface ProblemMeta {
    createdAt: string;
    updatedAt: string;
    version: number;
}
/** frontmatter 格式版本：用于兼容迁移与往返校验 */
export declare const PROBLEM_SCHEMA_VERSION = 6;
export declare const KNOWLEDGE_GRAPH_SCHEMA_VERSION = 2;
export interface KnowledgeNode {
    id: string;
    name: string;
    /** 精确定义，避免仅靠名称判断对象同一性 */
    definition?: string;
    /** 标准记号，如 Av = λv */
    notation?: string;
    subject?: string;
    domain?: string;
    grade?: string;
    semester?: string;
    difficultyRange?: [number, number];
    commonQuestionTypes?: string[];
    typicalErrors?: string[];
    curriculumRef?: string;
    sourceRefs?: string[];
    aliases?: string[];
    createdAt: string;
    updatedAt: string;
}
export interface KnowledgeRelation {
    id: string;
    from: string;
    to: string;
    type: RelationType;
    /** learning = 教学依赖；mathematical = 数学逻辑关系。二者不得混为一谈 */
    layer?: RelationLayer;
    weight?: number;
    evidenceStatus?: EvidenceStatus;
    sourceRefs?: string[];
    note?: string;
    createdAt: string;
    updatedAt?: string;
}
export interface KnowledgeSubgraph {
    main: string;
    supporting: string[];
    abilities: AbilityLevel[];
    intent?: string;
    pathSummary?: string;
}
export interface Problem {
    id: string;
    status: ProblemStatus;
    source: ProblemSource;
    content: ProblemContent;
    subgraph?: KnowledgeSubgraph;
    /** 题型骨架：抑制肤浅换皮 */
    skeleton?: ProblemSkeleton;
    /** 所用技巧/思路 ID 列表（同技巧异题面创新的锚点） */
    techniques?: string[];
    review?: ProblemReview;
    links?: ProblemLinks;
    /** 变式记录：类型、目标、难度剖面与质量门审计 */
    variation?: VariationRecord;
    /** 创新审核留痕（commit 前置条件之一） */
    innovation?: InnovationRecord;
    meta: ProblemMeta;
}
export interface RawInput {
    text?: string;
    imageDescription?: string;
    imagePath?: string;
    filePath?: string;
    sourceType?: SourceType;
    uploader?: string;
}
export interface SearchQuery {
    keyword?: string;
    knowledgePoint?: string;
    difficulty?: 1 | 2 | 3 | 4 | 5;
    status?: ProblemStatus;
    tag?: string;
    ability?: AbilityLevel;
    mainKnowledge?: string;
    mustIncludeSupporting?: string[];
    /** 必须全部出现在 K(P)=主知识点∪支撑∪knowledgePoints 里 */
    mustIncludeKnowledge?: string[];
    excludeKnowledge?: string[];
    /** 六维难度范围过滤（逐维硬约束） */
    difficultyProfile?: PaperSlot['targetDifficultyProfile'];
    patternId?: string;
    limit?: number;
}
/** 多信号近重复结果 */
export interface SubgraphSimilarity {
    problemId: string;
    score: number;
    mainMatch: boolean;
    supportingOverlap: number;
    abilityOverlap: number;
    skeletonMatch: boolean;
    patternIdSame: boolean;
    isNearDuplicate: boolean;
    /** 一票否决原因 */
    vetoReason?: string;
}
/**
 * 创新算子：固定技巧核，强制换皮以外的维度
 * - transfer_domain 换载体（代数↔几何↔概率…）
 * - change_goal 换目标（求值→范围/存在/计数）
 * - couple 与第二技巧或知识点耦合
 * - inverse 逆问题（结论→条件/参数）
 * - critical 临界化（常数是否可改进）
 */
export type InnovationOperator = 'transfer_domain' | 'change_goal' | 'couple' | 'inverse' | 'critical';
export declare const INNOVATION_OPERATOR_HINTS: Record<InnovationOperator, string>;
/**
 * 变式类型：把「改题面」与「数学创新」分开
 * - original    原始题（非变式），仍需声明难度剖面
 * - isomorphic  同构变式：保持推理深度，只改表述/参数
 * - structural  结构变式：保留核心思想，换掉关键结构
 * - harder      增难变式：新增推理障碍（不得靠减少一般性换难度）
 * - extension   拓展变式：推广结论或研究边界
 * - simplified  降难变式：仅作明确的教学模式，不算创新
 */
export type VariationType = 'original' | 'isomorphic' | 'structural' | 'harder' | 'extension' | 'simplified';
export declare const VARIATION_TYPE_LABELS: Record<VariationType, string>;
/** 一般性要求：变式不得靠「一般 → 有限」来掩盖降难 */
export type Generality = 'general-n' | 'finite-case' | 'single-instance';
/** 六维难度等级 1–5 */
export type DifficultyLevel = 1 | 2 | 3 | 4 | 5;
export type DifficultyDimension = 'conceptual' | 'technical' | 'proofDepth' | 'prerequisiteLoad' | 'ingenuity' | 'generality';
export interface DimensionRating {
    level: DifficultyLevel;
    rationale: string;
    evidence?: string[];
}
/**
 * 六维难度剖面（v0.6 Multi-dimensional Difficulty Assessment）
 * 与变式质量门中的 DifficultyProfile（核心结论/关键技巧/最难一步）并存，职责不同。
 */
export interface DimensionalDifficultyProfile {
    rubricVersion: 1;
    dimensions: Record<DifficultyDimension, DimensionRating>;
    overall?: DifficultyLevel;
    assessedBy: 'human' | 'model' | 'empirical';
    reviewStatus: 'pending' | 'reviewed';
    reviewedBy?: string;
    reviewNotes?: string;
    assessedAt: string;
}
/**
 * 难度剖面：只记录可核对的结构性事实，
 * 步数与长度只能作为辅助指标，不能单独代表难度。
 */
export interface DifficultyProfile {
    /** 核心定理 / 目标结论 */
    coreClaim: string;
    /** 关键技巧（Technique id 或一句话） */
    keyTechniques: string[];
    /** 最难的一步（必须具体到「要想到什么」） */
    hardestStep: string;
    /** 一般性要求 */
    generality: Generality;
    /** 必须完成的证明义务 */
    proofObligations: string[];
}
/** 变式的数学证据：由生成者填写，由门禁逐项核对 */
export interface VariationEvidence {
    /** 保留了什么核心难点（至少一条） */
    preserved: string[];
    /** 新增了什么推理障碍（harder / structural / extension 必填） */
    added: string[];
    /** 削弱了什么（非 simplified 必须为空） */
    weakened?: string[];
    /** 独立求解核验 */
    solving: {
        conditionsCompatible: boolean;
        solutionExists: boolean;
        boundaryChecked: boolean;
        proofComplete: boolean;
        notes?: string;
    };
}
export interface QualityCheck {
    id: string;
    label: string;
    passed: boolean;
    detail: string;
}
export interface VariationAudit {
    variationType: VariationType;
    originalProblemId?: string;
    checks: QualityCheck[];
    passed: boolean;
    auditedAt: string;
}
/** 题目上的变式记录：意图在生成前写，审计在入库前写 */
export interface VariationRecord {
    type: VariationType;
    originalProblemId?: string;
    /** 本次变式的目标（保持难度 / 增难 / 结构迁移 / 推广） */
    target?: string;
    /** 候选题的难度剖面 */
    profile?: DifficultyProfile;
    /** 原题难度剖面快照（record 时从原题复制） */
    originalProfile?: DifficultyProfile;
    audit?: VariationAudit;
}
/** 生成采样：强制迁移与深度约束 */
export interface GenerationSample {
    main: string;
    supporting: string[];
    abilities: AbilityLevel[];
    prerequisites: string[];
    contrastPoints: string[];
    applicationTargets: string[];
    suggestedDifficulty: number;
    pathSummary: string;
    negativePatterns: string[];
    forbiddenPatternIds: string[];
    requiredMigration?: {
        type: 'contrast' | 'application';
        from: string;
        to: string;
        note?: string;
    };
    hardConstraints: string[];
    suggestedPatternHint?: string;
    minEstimatedSteps?: number;
    /** 同技巧异题面 / 技巧组合 */
    techniqueMode?: {
        techniqueId: string;
        techniqueName: string;
        idea: string;
        exemplarProblemIds: string[];
        exemplarSurfaceHints: string[];
        surfaceDiversityRule: string;
        /** 选用的创新算子 */
        operator: InnovationOperator;
        operatorHint: string;
        /** 第二技巧（组合模式） */
        secondaryTechniqueId?: string;
        secondaryTechniqueName?: string;
        secondaryIdea?: string;
        /** 生成前必写的迁移说明模板 */
        migrationStatementTemplate: string;
        /** 入库后人工门禁两问 */
        humanGateQuestions: string[];
    };
    /** 变式质量门契约：生成前后都必须遵守 */
    variationContract?: VariationContract;
}
/** 变式质量门契约：随采样一起返回，防止「看起来不同、数学上更简单」 */
export interface VariationContract {
    required: boolean;
    allowedTypes: VariationType[];
    /** 明确禁止的降难手法（默认含「一般 n 截成有限项」） */
    forbiddenSimplifications: string[];
    /** 生成后必须依次完成的门禁步骤 */
    steps: string[];
    /** 原题（若已知）的一般性要求；变式不得低于它 */
    originalGenerality?: Generality;
}
/** 创新审阅清单（自动 + 给人） */
export interface InnovationReview {
    problemId: string;
    auto: {
        hasSkeleton: boolean;
        hasTechniques: boolean;
        patternIdForbidden: boolean;
        forbiddenHit?: string;
        estimatedStepsOk: boolean;
        couplingOk: boolean;
        notes: string[];
    };
    humanGateQuestions: string[];
    passAuto: boolean;
}
export interface PaperSlot {
    order: number;
    problemId?: string;
    targetMain?: string;
    targetDifficulty?: DifficultyLevel;
    /** 六维难度硬/软约束；硬约束不满足则拒绝填入 */
    targetDifficultyProfile?: Partial<Record<DifficultyDimension, {
        min?: DifficultyLevel;
        max?: DifficultyLevel;
    }>>;
    targetAbilities?: AbilityLevel[];
    section?: string;
    score?: number;
    generationHint?: string;
    forbiddenPatternIds?: string[];
    /** 强制填入时留下的记录：哪些维度不合格、为什么仍然接受 */
    forcedFill?: {
        problemId: string;
        failed: string[];
        reason: string;
        at: string;
    };
}
export interface PaperStyleProfile {
    id: string;
    name: string;
    sourcePaperIds: string[];
    totalQuestions: number;
    sectionDistribution: {
        section: string;
        count: number;
        avgScore?: number;
    }[];
    difficultyDistribution: Record<string, number>;
    abilityDistribution: Record<string, number>;
    mainKnowledgeFrequency: {
        id: string;
        count: number;
        name?: string;
    }[];
    frequentSubgraphPatterns: string[];
    /** 高频骨架 ID */
    frequentPatternIds: string[];
    styleNotes: string;
    createdAt: string;
}
export interface Paper {
    id: string;
    title: string;
    styleProfileId?: string;
    status: 'draft' | 'generating' | 'ready' | 'reviewed';
    slots: PaperSlot[];
    totalScore?: number;
    timeLimitMinutes?: number;
    notes?: string;
    meta: {
        createdAt: string;
        updatedAt: string;
        version: number;
    };
}
export interface MockPaperPlan {
    paperId: string;
    styleProfileId: string;
    slots: {
        order: number;
        section?: string;
        sample: GenerationSample;
        avoidProblemIds: string[];
    }[];
    overallGuidance: string;
}
