/**
 * 轻量知识图谱 + 题型骨架近重复 + 强制迁移采样 + 技巧层（同技巧异题面）
 */
import type { KnowledgeNode, KnowledgeRelation, KnowledgeSubgraph, AbilityLevel, RelationType, RelationLayer, SubgraphSimilarity, GenerationSample, Problem, ProblemSkeleton, Technique } from './types.js';
export declare class KnowledgeGraph {
    private root;
    private nodes;
    private relations;
    private techniques;
    private loaded;
    constructor(bankRoot: string);
    private ensureDir;
    private nodesPath;
    private relationsPath;
    private techniquesPath;
    load(): Promise<void>;
    private persist;
    addNode(node: Omit<KnowledgeNode, 'createdAt' | 'updatedAt'> & {
        createdAt?: string;
        updatedAt?: string;
    }): Promise<KnowledgeNode>;
    addRelation(rel: Omit<KnowledgeRelation, 'id' | 'createdAt'> & {
        id?: string;
    }): Promise<KnowledgeRelation>;
    addTechnique(tech: Omit<Technique, 'createdAt' | 'updatedAt'> & {
        createdAt?: string;
        updatedAt?: string;
    }): Promise<Technique>;
    /**
     * 若 techniques 为空，从插件内置 seed-techniques.json 灌入。
     * 返回新写入条数（已有数据则 0）。
     */
    ensureTechniqueSeed(): Promise<number>;
    getTechnique(id: string): Promise<Technique | null>;
    listTechniques(): Promise<Technique[]>;
    getNode(id: string): Promise<KnowledgeNode | null>;
    listNodes(filter?: {
        subject?: string;
        grade?: string;
    }): Promise<KnowledgeNode[]>;
    getRelations(from?: string, type?: RelationType): Promise<KnowledgeRelation[]>;
    getPrerequisites(nodeId: string, maxDepth?: number): Promise<string[]>;
    getContrastPoints(nodeId: string): Promise<string[]>;
    getApplicationTargets(nodeId: string): Promise<string[]>;
    /** 纯子图相似度 0~1 */
    computeSubgraphSimilarity(a: KnowledgeSubgraph, b: KnowledgeSubgraph): number;
    /** 骨架相似度：patternId 相同则高分；keyMoves Jaccard 作补充 */
    computeSkeletonSimilarity(a?: ProblemSkeleton, b?: ProblemSkeleton): {
        score: number;
        patternIdSame: boolean;
    };
    /**
     * 多信号近重复：
     * score = 0.4*subgraph + 0.35*skeleton + 0.15*abilityPath + 0.1*mainBonus
     * 一票否决：同 patternId
     */
    findNearDuplicates(target: KnowledgeSubgraph, problems: Problem[], threshold?: number, targetSkeleton?: ProblemSkeleton): SubgraphSimilarity[];
    /**
     * 可控采样：强制 contrast/application 迁移 + 禁止已有骨架
     */
    sampleForGeneration(mainId: string, options?: {
        maxSupporting?: number;
        abilities?: AbilityLevel[];
        existingProblems?: Problem[];
        negativeTopK?: number;
        minEstimatedSteps?: number;
        preferMigration?: 'contrast' | 'application' | 'auto';
    }): Promise<GenerationSample>;
    /**
     * 同技巧异题面采样（可叠加创新算子 / 第二技巧）
     */
    sampleByTechnique(techniqueId: string, options?: {
        main?: string;
        abilities?: AbilityLevel[];
        existingProblems?: Problem[];
        minEstimatedSteps?: number;
        operator?: import('./types.js').InnovationOperator;
        secondaryTechniqueId?: string;
    }): Promise<GenerationSample>;
    /** 显式技巧组合：主 TECH + 副 TECH，算子固定为 couple */
    sampleTechniqueCombo(primaryId: string, secondaryId: string, options?: {
        main?: string;
        abilities?: AbilityLevel[];
        existingProblems?: Problem[];
        minEstimatedSteps?: number;
    }): Promise<GenerationSample>;
    /**
     * v0.6 图谱一致性校验
     * - 引用节点必须存在
     * - 禁止重复关系
     * - prerequisite / part-of 不得形成环（DAG）
     * - equivalent / dual-to 应可对称查询
     * - weight 合法范围
     * - 数学关系应有 evidenceStatus
     */
    validateGraph(): Promise<{
        ok: boolean;
        errors: string[];
        warnings: string[];
    }>;
    /** 查询邻居（按关系类型过滤） */
    getNeighbors(nodeId: string, options?: {
        type?: RelationType;
        layer?: RelationLayer;
        direction?: 'out' | 'in' | 'both';
    }): Promise<{
        nodeId: string;
        relation: KnowledgeRelation;
    }[]>;
    /**
     * 学习路径：从 from 到 to 的 prerequisite 最短路径（BFS）
     * 返回节点 id 序列，找不到则空数组
     */
    findLearningPath(fromId: string, toId: string, maxDepth?: number): Promise<string[]>;
    /** 查找推广 / 特例 / 对偶等数学关系 */
    findRelatedConcepts(nodeId: string, types?: RelationType[]): Promise<{
        type: RelationType;
        nodeId: string;
        relation: KnowledgeRelation;
    }[]>;
}
