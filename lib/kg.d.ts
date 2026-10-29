/**
 * 轻量知识图谱 + 题型骨架近重复 + 强制迁移采样 + 技巧层（同技巧异题面）
 */
import type { KnowledgeNode, KnowledgeRelation, KnowledgeSubgraph, AbilityLevel, RelationType, SubgraphSimilarity, GenerationSample, Problem, ProblemSkeleton, Technique } from './types.js';
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
}
