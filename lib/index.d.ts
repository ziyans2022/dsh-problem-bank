/**
 * problem-bank v0.4 —— 节约 token + 知识图谱 + 题型骨架
 *
 * 核心价值：
 * 1. id 引用节约 token
 * 2. 知识子图结构化分类
 * 3. ProblemSkeleton：同 patternId 一票否决换皮
 * 4. 多信号近重复 + 强制 contrast/application 迁移采样
 */
import type { Context } from '@deepseek-ai/cordis';
import { type ProblemBankConfig } from './service.js';
export declare const name = "problem-bank";
export declare const inject: string[];
export interface Config extends ProblemBankConfig {
}
export declare const Config: any;
export declare function apply(ctx: Context, rawConfig: Config): void;
