/**
 * ProblemBank Service
 * - 题目持久化（按年份 Markdown + frontmatter）
 * - 状态机 + 版本控制
 * - 可选 Git 自动 commit
 * - 集成轻量知识图谱（子图关联、近重复检测、生成采样）
 */
import type { Context } from '@deepseek-ai/cordis';
import { Service } from '@deepseek-ai/cordis';
import type { Problem, RawInput, SearchQuery, ProblemContent, ProblemLinks, KnowledgeSubgraph, AbilityLevel, SubgraphSimilarity, GenerationSample, Paper, PaperStyleProfile, MockPaperPlan, ProblemSkeleton, VariationType, VariationEvidence, VariationAudit, DifficultyProfile } from './types.js';
import { KnowledgeGraph } from './kg.js';
export interface ProblemBankConfig {
    bankRoot: string;
    idPrefix: string;
    autoGitCommit: boolean;
    requireHumanReview: boolean;
    defaultDifficulty: 1 | 2 | 3 | 4 | 5;
    gitAuthorName?: string;
    gitAuthorEmail?: string;
    /** 近重复判定阈值 */
    nearDuplicateThreshold?: number;
    /** 是否强制变式质量门（默认 true）：入库前必须声明变式类型并通过审计 */
    requireVariationGate?: boolean;
    /** 是否允许 simplified（降难）变式入库（默认 false） */
    allowSimplified?: boolean;
}
export declare class ProblemBankService extends Service {
    private config;
    readonly kg: KnowledgeGraph;
    constructor(ctx: Context, config: ProblemBankConfig);
    /** 启动时调用：确保目录、技巧种子、id 序列可用 */
    init(): Promise<{
        techniquesSeeded: number;
        bankRoot: string;
    }>;
    private ensureDir;
    private listYearDirs;
    private findProblemPath;
    private getNewProblemPath;
    /** 扫描已有题号最大值（序列文件落后时的兜底） */
    private scanMaxIdNum;
    private nextId;
    private toMarkdown;
    /**
     * 按顶级标题切分正文。识别：
     * - ## 题面
     * - ## 解析
     * - ## 图形…（与 toMarkdown 一致，兼容旧「## 配图」）
     * 题面/解析内部的 ## 小问 等不切换分段。
     */
    private splitBodySections;
    /**
     * 解析 frontmatter：每行 key: JSON
     * schemaVersion 缺失视为旧版（1），读入后不强制改写磁盘，下次 write 升到 PROBLEM_SCHEMA_VERSION
     */
    private fromMarkdown;
    private write;
    private read;
    private tryGitCommit;
    createDraft(raw: RawInput): Promise<Problem>;
    get(id: string): Promise<Problem | null>;
    updateContent(id: string, patch: Partial<ProblemContent>): Promise<Problem>;
    attachSubgraph(id: string, subgraph: KnowledgeSubgraph): Promise<Problem>;
    attachSkeleton(id: string, skeleton: ProblemSkeleton): Promise<Problem>;
    attachTechniques(id: string, techniqueIds: string[]): Promise<Problem>;
    private loadProblemsForSampling;
    sampleByTechnique(techniqueId: string, options?: {
        main?: string;
        abilities?: AbilityLevel[];
        minEstimatedSteps?: number;
        operator?: import('./types.js').InnovationOperator;
        secondaryTechniqueId?: string;
    }): Promise<GenerationSample>;
    sampleTechniqueCombo(primaryId: string, secondaryId: string, options?: {
        main?: string;
        abilities?: AbilityLevel[];
        minEstimatedSteps?: number;
    }): Promise<GenerationSample>;
    reviewInnovation(problemId: string, sample?: GenerationSample): Promise<import('./types.js').InnovationReview>;
    private assertProfile;
    /** 生成前：声明变式类型、目标与候选题的难度剖面 */
    recordVariationIntent(id: string, input: {
        variationType: VariationType;
        originalProblemId?: string;
        target?: string;
        profile: DifficultyProfile;
    }): Promise<Problem>;
    /** 入库前：逐项核对变式证据，通过才写入 audit */
    auditVariation(id: string, evidence: VariationEvidence): Promise<{
        problem: Problem;
        audit: VariationAudit;
        passed: boolean;
        nextAction: string;
    }>;
    private computeVariationChecks;
    private gateNextAction;
    private attachVariationContract;
    planTechniqueBatch(techniqueIds: string[], options?: {
        operator?: import('./types.js').InnovationOperator;
        pairWith?: Record<string, string>;
        main?: string;
    }): Promise<{
        items: GenerationSample[];
    }>;
    submitForReview(id: string): Promise<Problem>;
    review(id: string, decision: 'approve' | 'reject', notes?: string, reviewer?: string): Promise<Problem>;
    commit(id: string): Promise<{
        problem: Problem;
        git: {
            ok: boolean;
            detail: string;
        };
    }>;
    search(query: SearchQuery): Promise<Problem[]>;
    link(id: string, links: Partial<ProblemLinks>): Promise<Problem>;
    /** 近重复检测：子图 + 骨架多信号；同 patternId 一票否决。
     * 覆盖 draft/pending_review/approved，避免批量变体互不查重。
     */
    checkNearDuplicates(subgraph: KnowledgeSubgraph, threshold?: number, skeleton?: ProblemSkeleton): Promise<SubgraphSimilarity[]>;
    /** 为原创生成做可控采样（强制迁移 + 禁止已有骨架） */
    sampleForGeneration(mainId: string, options?: {
        maxSupporting?: number;
        abilities?: AbilityLevel[];
        negativeTopK?: number;
        minEstimatedSteps?: number;
        preferMigration?: 'contrast' | 'application' | 'auto';
    }): Promise<GenerationSample>;
    listAllBrief(): Promise<{
        id: string;
        status: string;
        year: string;
    }[]>;
    private papersDir;
    private ensurePapersDir;
    private paperPath;
    private stylePath;
    savePaper(paper: Paper): Promise<Paper>;
    getPaper(id: string): Promise<Paper | null>;
    saveStyleProfile(profile: PaperStyleProfile): Promise<PaperStyleProfile>;
    getStyleProfile(id: string): Promise<PaperStyleProfile | null>;
    /**
     * 分析一组题目的风格画像（用于模仿中科大少年班等真题风格）
     */
    analyzeStyle(name: string, problemIds: string[], styleId?: string): Promise<PaperStyleProfile>;
    /**
     * 根据风格画像生成「模拟卷计划」
     * 每道题给出 GenerationSample，模型按计划逐题生成后再入库组装
     */
    planMockPaper(styleProfileId: string, options?: {
        paperTitle?: string;
        questionCount?: number;
        preferMains?: string[];
    }): Promise<{
        paper: Paper;
        plan: MockPaperPlan;
    }>;
    /** 把已生成的题目填入试卷槽位 */
    fillPaperSlot(paperId: string, order: number, problemId: string): Promise<Paper>;
}
