/**
 * problem-bank v0.4 —— 节约 token + 知识图谱 + 题型骨架
 *
 * 核心价值：
 * 1. id 引用节约 token
 * 2. 知识子图结构化分类
 * 3. ProblemSkeleton：同 patternId 一票否决换皮
 * 4. 多信号近重复 + 强制 contrast/application 迁移采样
 */
import Schema from '@deepseek-ai/schemastery';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { ProblemBankService } from './service.js';
export const name = 'problem-bank';
export const inject = ['tools'];
export const Config = Schema.object({
    bankRoot: Schema.string()
        .default('./problem-bank-data')
        .description('题库根目录（绝对路径更佳）'),
    idPrefix: Schema.string().default('ZH').description('题号前缀'),
    autoGitCommit: Schema.boolean()
        .default(false)
        .description('入库时是否自动 git add + commit'),
    requireHumanReview: Schema.boolean()
        .default(true)
        .description('是否强制人工审核后才能 commit'),
    defaultDifficulty: Schema.union([
        Schema.const(1),
        Schema.const(2),
        Schema.const(3),
        Schema.const(4),
        Schema.const(5),
    ])
        .default(3)
        .description('默认难度'),
    gitAuthorName: Schema.string()
        .default('problem-bank')
        .description('Git 提交作者名'),
    gitAuthorEmail: Schema.string()
        .default('problem-bank@local')
        .description('Git 提交作者邮箱'),
    nearDuplicateThreshold: Schema.number()
        .default(0.75)
        .description('子图相似度近重复阈值 (0~1)'),
});
export function apply(ctx, config) {
    const bank = new ProblemBankService(ctx, config);
    ctx.problemBank = bank;
    // ==================== 采集与结构化 ====================
    ctx.tools.register(defineTool({
        name: 'ingest_raw',
        description: '接收原始题目素材并创建草稿。图片题推荐：多模态模型先读图得到 imageDescription，再调用本工具。',
        parameters: {
            text: { type: 'string', description: '题目纯文本或 OCR 结果' },
            imageDescription: {
                type: 'string',
                description: '多模态模型对截图的完整文字描述（推荐）',
            },
            imagePath: { type: 'string', description: '本地图片绝对路径' },
            filePath: { type: 'string', description: 'PDF 或其他文件路径' },
            sourceType: {
                type: 'string',
                description: 'pdf | screenshot | wechat | lecture | manual | other',
            },
            uploader: { type: 'string' },
        },
        output: {
            schema: {
                type: 'object',
                properties: {
                    id: { type: 'string' },
                    status: { type: 'string' },
                    hasImage: { type: 'boolean' },
                    message: { type: 'string' },
                    nextStep: { type: 'string' },
                },
                additionalProperties: false,
            },
            render: (_a, v) => [
                {
                    type: 'text',
                    text: `已创建草稿 ${v.id}（${v.status}）。${v.message}\n下一步：${v.nextStep}`,
                },
            ],
        },
        async execute(args) {
            const raw = {
                text: args.text,
                imageDescription: args.imageDescription,
                imagePath: args.imagePath,
                filePath: args.filePath,
                sourceType: args.sourceType,
                uploader: args.uploader,
            };
            if (!raw.text && !raw.imageDescription && !raw.imagePath && !raw.filePath) {
                throw new Error('至少提供 text / imageDescription / imagePath / filePath 之一');
            }
            const p = await bank.createDraft(raw);
            const hasImage = !!(raw.imagePath || raw.imageDescription);
            let nextStep = '调用 structure_problem 完善题面、解析、知识点；再调用 attach_subgraph 挂知识子图。';
            if (raw.imagePath && !raw.imageDescription && !raw.text) {
                nextStep =
                    '仅有 imagePath。请先用视觉能力读图，再调用 structure_problem。';
            }
            return {
                id: p.id,
                status: p.status,
                hasImage,
                message: hasImage ? '已记录图片来源。' : '草稿已创建。',
                nextStep,
            };
        },
    }));
    ctx.tools.register(defineTool({
        name: 'structure_problem',
        description: '将题目整理为标准结构并写入（可新建或更新）。完成后建议再 attach_subgraph 挂知识子图，以启用近重复检测与原创约束。',
        parameters: {
            id: { type: 'string', description: '已有草稿 id，不传则新建' },
            stem: { type: 'string', required: true, description: '题面（Markdown + KaTeX）' },
            solution: { type: 'string', required: true, description: '解析' },
            knowledgePoints: {
                type: 'array',
                items: { type: 'string' },
                description: '扁平知识点（兼容旧用法，建议同时用 attach_subgraph）',
            },
            difficulty: { type: 'number', description: '难度 1-5' },
            tags: { type: 'array', items: { type: 'string' } },
            abilityLevels: {
                type: 'array',
                items: { type: 'string' },
                description: '能力层级：识记/理解/应用/分析/综合/评价/运算/推理/建模/直观想象',
            },
            sourceType: { type: 'string' },
        },
        output: {
            schema: {
                type: 'object',
                properties: {
                    id: { type: 'string' },
                    status: { type: 'string' },
                    version: { type: 'number' },
                    difficulty: { type: 'number' },
                },
                additionalProperties: false,
            },
            render: (_a, v) => [
                {
                    type: 'text',
                    text: `题目 ${v.id} 已结构化（v${v.version}，难度 ${v.difficulty}）。建议继续 attach_subgraph。`,
                },
            ],
        },
        async execute(args) {
            let id = args.id;
            if (!id) {
                const draft = await bank.createDraft({
                    text: args.stem,
                    sourceType: args.sourceType || 'manual',
                });
                id = draft.id;
            }
            const difficulty = Math.min(5, Math.max(1, Number(args.difficulty) || config.defaultDifficulty));
            const p = await bank.updateContent(id, {
                stem: args.stem,
                solution: args.solution,
                knowledgePoints: args.knowledgePoints || [],
                difficulty,
                tags: args.tags || [],
                abilityLevels: args.abilityLevels || [],
            });
            return {
                id: p.id,
                status: p.status,
                version: p.meta.version,
                difficulty: p.content.difficulty,
            };
        },
    }));
    ctx.tools.register(defineTool({
        name: 'revise_problem',
        description: '增量修订已有题目，只传需要修改的字段，显著节约 token。',
        parameters: {
            id: { type: 'string', required: true },
            stem: { type: 'string' },
            solution: { type: 'string' },
            knowledgePoints: { type: 'array', items: { type: 'string' } },
            difficulty: { type: 'number' },
            tags: { type: 'array', items: { type: 'string' } },
            abilityLevels: { type: 'array', items: { type: 'string' } },
        },
        output: {
            schema: {
                type: 'object',
                properties: {
                    id: { type: 'string' },
                    version: { type: 'number' },
                    status: { type: 'string' },
                    updatedFields: { type: 'array', items: { type: 'string' } },
                },
                additionalProperties: false,
            },
            render: (_a, v) => [
                {
                    type: 'text',
                    text: `题目 ${v.id} 已修订至 v${v.version}。更新：${v.updatedFields.join(', ')}`,
                },
            ],
        },
        async execute(args) {
            const id = args.id;
            const patch = {};
            const updatedFields = [];
            for (const key of [
                'stem',
                'solution',
                'knowledgePoints',
                'difficulty',
                'tags',
                'abilityLevels',
            ]) {
                if (args[key] !== undefined) {
                    patch[key] =
                        key === 'difficulty'
                            ? Math.min(5, Math.max(1, Number(args[key])))
                            : args[key];
                    updatedFields.push(key);
                }
            }
            if (updatedFields.length === 0)
                throw new Error('至少提供一个要修改的字段');
            const p = await bank.updateContent(id, patch);
            return {
                id: p.id,
                version: p.meta.version,
                status: p.status,
                updatedFields,
            };
        },
    }));
    // ==================== 知识图谱核心 ====================
    ctx.tools.register(defineTool({
        name: 'kg_add_node',
        description: '向知识图谱添加知识点节点。建议用稳定 ID（如 KP-QUAD-VERTEX）。',
        parameters: {
            id: { type: 'string', required: true, description: '稳定知识点 ID' },
            name: { type: 'string', required: true, description: '显示名称' },
            subject: { type: 'string', description: '学科，如 数学' },
            grade: { type: 'string', description: '年级' },
            semester: { type: 'string' },
            curriculumRef: { type: 'string', description: '课标条目' },
            typicalErrors: { type: 'array', items: { type: 'string' } },
            aliases: { type: 'array', items: { type: 'string' } },
        },
        output: {
            schema: {
                type: 'object',
                properties: { id: { type: 'string' }, name: { type: 'string' } },
                additionalProperties: false,
            },
            render: (_a, v) => [
                { type: 'text', text: `知识点节点已添加：${v.id} — ${v.name}` },
            ],
        },
        async execute(args) {
            const node = await bank.kg.addNode({
                id: args.id,
                name: args.name,
                subject: args.subject,
                grade: args.grade,
                semester: args.semester,
                curriculumRef: args.curriculumRef,
                typicalErrors: args.typicalErrors,
                aliases: args.aliases,
            });
            return { id: node.id, name: node.name };
        },
    }));
    ctx.tools.register(defineTool({
        name: 'kg_add_relation',
        description: '添加知识点关系。type: prerequisite | part-of | equivalence | contrast | application',
        parameters: {
            from: { type: 'string', required: true },
            to: { type: 'string', required: true },
            type: {
                type: 'string',
                required: true,
                description: 'prerequisite | part-of | equivalence | contrast | application',
            },
            note: { type: 'string' },
            weight: { type: 'number' },
        },
        output: {
            schema: {
                type: 'object',
                properties: {
                    id: { type: 'string' },
                    from: { type: 'string' },
                    to: { type: 'string' },
                    type: { type: 'string' },
                },
                additionalProperties: false,
            },
            render: (_a, v) => [
                {
                    type: 'text',
                    text: `关系已添加：${v.from} --[${v.type}]--> ${v.to}`,
                },
            ],
        },
        async execute(args) {
            const rel = await bank.kg.addRelation({
                from: args.from,
                to: args.to,
                type: args.type,
                note: args.note,
                weight: args.weight,
            });
            return { id: rel.id, from: rel.from, to: rel.to, type: rel.type };
        },
    }));
    ctx.tools.register(defineTool({
        name: 'kg_add_technique',
        description: '添加技巧/思路节点。用于「同技巧、异题面」创新：固定核心思想，强制题面与骨架不同。',
        parameters: {
            id: {
                type: 'string',
                required: true,
                description: '如 TECH-PROJ-LINE、TECH-COMPLETE-SQUARE',
            },
            name: { type: 'string', required: true, description: '显示名' },
            idea: {
                type: 'string',
                required: true,
                description: '核心思想一句话',
            },
            typicalMoves: {
                type: 'array',
                items: { type: 'string' },
                description: '典型关键动作',
            },
            domains: {
                type: 'array',
                items: { type: 'string' },
                description: '适用主题提示',
            },
            exemplarNote: { type: 'string', description: '何谓同技巧的说明' },
        },
        output: {
            schema: {
                type: 'object',
                properties: { id: { type: 'string' }, name: { type: 'string' } },
                additionalProperties: false,
            },
            render: (_a, v) => [
                { type: 'text', text: `技巧已添加：${v.id} — ${v.name}` },
            ],
        },
        async execute(args) {
            const t = await bank.kg.addTechnique({
                id: args.id,
                name: args.name,
                idea: args.idea,
                typicalMoves: args.typicalMoves || [],
                domains: args.domains,
                exemplarNote: args.exemplarNote,
            });
            return { id: t.id, name: t.name };
        },
    }));
    ctx.tools.register(defineTool({
        name: 'attach_subgraph',
        description: '为题目挂载知识子图（主知识点 + 支撑 + 能力）。建议同时调用 attach_skeleton 标注题型骨架，否则近重复检测无法一票否决换皮题。',
        parameters: {
            id: { type: 'string', required: true, description: '题目 id' },
            main: { type: 'string', required: true, description: '主知识点 ID' },
            supporting: {
                type: 'array',
                items: { type: 'string' },
                description: '支撑知识点 ID 列表',
            },
            abilities: {
                type: 'array',
                items: { type: 'string' },
                description: '能力层级列表',
            },
            intent: { type: 'string', description: '考察意图简述' },
            pathSummary: { type: 'string', description: '知识路径简述' },
        },
        output: {
            schema: {
                type: 'object',
                properties: {
                    id: { type: 'string' },
                    main: { type: 'string' },
                    supporting: { type: 'array', items: { type: 'string' } },
                    abilities: { type: 'array', items: { type: 'string' } },
                },
                additionalProperties: false,
            },
            render: (_a, v) => [
                {
                    type: 'text',
                    text: `题目 ${v.id} 已挂载子图：主=${v.main}，支撑=[${v.supporting.join(', ')}]，能力=[${v.abilities.join(', ')}]`,
                },
            ],
        },
        async execute(args) {
            const subgraph = {
                main: args.main,
                supporting: args.supporting || [],
                abilities: args.abilities || ['应用'],
                intent: args.intent,
                pathSummary: args.pathSummary,
            };
            const p = await bank.attachSubgraph(args.id, subgraph);
            return {
                id: p.id,
                main: p.subgraph.main,
                supporting: p.subgraph.supporting,
                abilities: p.subgraph.abilities,
            };
        },
    }));
    ctx.tools.register(defineTool({
        name: 'attach_skeleton',
        description: '为题目挂载题型骨架（patternId + keyMoves + conditionStructure + answerType）。同 patternId 的换皮题会被 check_near_duplicates 一票否决。这是抑制肤浅改编的关键。',
        parameters: {
            id: { type: 'string', required: true },
            patternId: {
                type: 'string',
                required: true,
                description: '稳定骨架ID，如 ABS-RATIONAL-RANGE、TRIG-SUM-TO-PRODUCT',
            },
            keyMoves: {
                type: 'array',
                items: { type: 'string' },
                required: true,
                description: '关键变形：分段讨论/换元/平方求和/积化和差/构造辅助量/…',
            },
            conditionStructure: {
                type: 'string',
                required: true,
                description: '条件结构，如「双和条件→求和角正弦」',
            },
            answerType: {
                type: 'string',
                required: true,
                description: '数值|区间|表达式|参数范围|证明|存在性|计数|概率|其他',
            },
            estimatedSteps: {
                type: 'number',
                description: '预估推理步数，≥3 表示多步耦合',
            },
            requiresCoupling: {
                type: 'boolean',
                description: '是否要求多知识点在关键一步耦合',
            },
        },
        output: {
            schema: {
                type: 'object',
                properties: {
                    id: { type: 'string' },
                    patternId: { type: 'string' },
                    keyMoves: { type: 'array', items: { type: 'string' } },
                    answerType: { type: 'string' },
                },
                additionalProperties: false,
            },
            render: (_a, v) => [
                {
                    type: 'text',
                    text: `题目 ${v.id} 骨架：${v.patternId} | 动作=[${v.keyMoves.join(', ')}] | 答案形态=${v.answerType}`,
                },
            ],
        },
        async execute(args) {
            const skeleton = {
                patternId: args.patternId,
                keyMoves: args.keyMoves || [],
                conditionStructure: args.conditionStructure,
                answerType: args.answerType,
                estimatedSteps: args.estimatedSteps,
                requiresCoupling: args.requiresCoupling,
            };
            const p = await bank.attachSkeleton(args.id, skeleton);
            return {
                id: p.id,
                patternId: p.skeleton.patternId,
                keyMoves: p.skeleton.keyMoves,
                answerType: p.skeleton.answerType,
            };
        },
    }));
    ctx.tools.register(defineTool({
        name: 'attach_techniques',
        description: '为题目标注所用技巧/思路 ID。同技巧异题面生成时，exemplar 靠此字段检索。',
        parameters: {
            id: { type: 'string', required: true },
            techniqueIds: {
                type: 'array',
                items: { type: 'string' },
                required: true,
            },
        },
        output: {
            schema: {
                type: 'object',
                properties: {
                    id: { type: 'string' },
                    techniques: { type: 'array', items: { type: 'string' } },
                },
                additionalProperties: false,
            },
            render: (_a, v) => [
                {
                    type: 'text',
                    text: `题目 ${v.id} 技巧：${v.techniques.join(', ')}`,
                },
            ],
        },
        async execute(args) {
            const p = await bank.attachTechniques(args.id, args.techniqueIds);
            return { id: p.id, techniques: p.techniques || [] };
        },
    }));
    ctx.tools.register(defineTool({
        name: 'check_near_duplicates',
        description: '多信号近重复检测：子图相似度 + 题型骨架。同 patternId 一票否决（换皮题直接判近重复）。生成后必须调用。',
        parameters: {
            main: { type: 'string', required: true },
            supporting: { type: 'array', items: { type: 'string' } },
            abilities: { type: 'array', items: { type: 'string' } },
            patternId: {
                type: 'string',
                description: '候选题的骨架 ID（强烈建议提供，否则无法一票否决）',
            },
            keyMoves: { type: 'array', items: { type: 'string' } },
            conditionStructure: { type: 'string' },
            answerType: { type: 'string' },
            threshold: {
                type: 'number',
                description: '相似度阈值，默认配置值',
            },
        },
        output: {
            schema: {
                type: 'object',
                properties: {
                    count: { type: 'number' },
                    items: {
                        type: 'array',
                        items: {
                            type: 'object',
                            properties: {
                                problemId: { type: 'string' },
                                score: { type: 'number' },
                                mainMatch: { type: 'boolean' },
                                patternIdSame: { type: 'boolean' },
                                vetoReason: { type: 'string' },
                                isNearDuplicate: { type: 'boolean' },
                            },
                            additionalProperties: false,
                        },
                    },
                },
                additionalProperties: false,
            },
            render: (_a, v) => {
                if (v.count === 0) {
                    return [
                        {
                            type: 'text',
                            text: '未发现近重复，子图与骨架原创性通过。',
                        },
                    ];
                }
                const lines = v.items
                    .map((it) => `- ${it.problemId} ${(it.score * 100).toFixed(1)}%` +
                    (it.patternIdSame ? ' [骨架一票否决]' : '') +
                    (it.vetoReason ? ` (${it.vetoReason})` : ''))
                    .join('\n');
                return [
                    {
                        type: 'text',
                        text: `发现 ${v.count} 道近重复（须重写）：\n${lines}`,
                    },
                ];
            },
        },
        async execute(args) {
            const subgraph = {
                main: args.main,
                supporting: args.supporting || [],
                abilities: args.abilities || [],
            };
            const skeleton = args.patternId
                ? {
                    patternId: args.patternId,
                    keyMoves: args.keyMoves || [],
                    conditionStructure: args.conditionStructure || '',
                    answerType: args.answerType || '其他',
                }
                : undefined;
            const list = await bank.checkNearDuplicates(subgraph, args.threshold, skeleton);
            return {
                count: list.length,
                items: list.map((r) => ({
                    problemId: r.problemId,
                    score: r.score,
                    mainMatch: r.mainMatch,
                    patternIdSame: r.patternIdSame,
                    vetoReason: r.vetoReason,
                    isNearDuplicate: r.isNearDuplicate,
                })),
            };
        },
    }));
    ctx.tools.register(defineTool({
        name: 'sample_for_generation',
        description: '原创出题可控采样：支撑/前置/易混淆/应用迁移 + 禁止已有 patternId + 硬约束列表。生成前必调；须遵守 hardConstraints 与 requiredMigration。',
        parameters: {
            main: { type: 'string', required: true, description: '目标主知识点 ID' },
            maxSupporting: { type: 'number' },
            abilities: { type: 'array', items: { type: 'string' } },
            negativeTopK: { type: 'number' },
            minEstimatedSteps: {
                type: 'number',
                description: '最低推理步数，默认 2',
            },
            preferMigration: {
                type: 'string',
                description: 'contrast | application | auto',
            },
        },
        output: {
            schema: {
                type: 'object',
                properties: {
                    main: { type: 'string' },
                    supporting: { type: 'array', items: { type: 'string' } },
                    abilities: { type: 'array', items: { type: 'string' } },
                    prerequisites: { type: 'array', items: { type: 'string' } },
                    contrastPoints: { type: 'array', items: { type: 'string' } },
                    applicationTargets: { type: 'array', items: { type: 'string' } },
                    suggestedDifficulty: { type: 'number' },
                    pathSummary: { type: 'string' },
                    negativePatterns: { type: 'array', items: { type: 'string' } },
                    forbiddenPatternIds: { type: 'array', items: { type: 'string' } },
                    hardConstraints: { type: 'array', items: { type: 'string' } },
                    suggestedPatternHint: { type: 'string' },
                    minEstimatedSteps: { type: 'number' },
                },
                additionalProperties: true,
            },
            render: (_a, v) => [
                {
                    type: 'text',
                    text: `采样：${v.pathSummary}\n` +
                        `难度建议 ${v.suggestedDifficulty} | 最少步数 ${v.minEstimatedSteps}\n` +
                        `禁止骨架: ${v.forbiddenPatternIds.join(', ') || '无'}\n` +
                        `硬约束:\n- ${v.hardConstraints.join('\n- ')}\n` +
                        `骨架提示: ${v.suggestedPatternHint}`,
                },
            ],
        },
        async execute(args) {
            return bank.sampleForGeneration(args.main, {
                maxSupporting: args.maxSupporting,
                abilities: args.abilities,
                negativeTopK: args.negativeTopK,
                minEstimatedSteps: args.minEstimatedSteps,
                preferMigration: args.preferMigration,
            });
        },
    }));
    ctx.tools.register(defineTool({
        name: 'sample_by_technique',
        description: '同技巧异题面采样。operator: transfer_domain|change_goal|couple|inverse|critical。可传 secondaryTechniqueId 做技巧组合。返回硬规则五条、迁移说明模板、人工门禁两问。',
        parameters: {
            techniqueId: { type: 'string', required: true },
            main: { type: 'string', description: '可选主知识点（跨章节包装）' },
            abilities: { type: 'array', items: { type: 'string' } },
            minEstimatedSteps: { type: 'number' },
            operator: {
                type: 'string',
                description: 'transfer_domain | change_goal | couple | inverse | critical',
            },
            secondaryTechniqueId: {
                type: 'string',
                description: '第二技巧；operator=couple 时建议提供',
            },
        },
        output: {
            schema: {
                type: 'object',
                properties: {
                    pathSummary: { type: 'string' },
                    forbiddenPatternIds: { type: 'array', items: { type: 'string' } },
                    hardConstraints: { type: 'array', items: { type: 'string' } },
                    techniqueMode: { type: 'object', additionalProperties: true },
                },
                additionalProperties: true,
            },
            render: (_a, v) => {
                const tm = v.techniqueMode;
                return [
                    {
                        type: 'text',
                        text: `【创新采样】算子=${tm?.operator} | ${tm?.techniqueName}` +
                            (tm?.secondaryTechniqueName
                                ? ` + ${tm.secondaryTechniqueName}`
                                : '') +
                            `\n${v.pathSummary}\n` +
                            `${tm?.migrationStatementTemplate || ''}\n` +
                            `禁止骨架: ${v.forbiddenPatternIds.join(', ') || '无'}\n` +
                            `硬约束:\n- ${v.hardConstraints.join('\n- ')}\n` +
                            `人工门禁:\n- ${(tm?.humanGateQuestions || []).join('\n- ')}`,
                    },
                ];
            },
        },
        async execute(args) {
            return bank.sampleByTechnique(args.techniqueId, {
                main: args.main,
                abilities: args.abilities,
                minEstimatedSteps: args.minEstimatedSteps,
                operator: args.operator,
                secondaryTechniqueId: args.secondaryTechniqueId,
            });
        },
    }));
    ctx.tools.register(defineTool({
        name: 'sample_technique_combo',
        description: '技巧组合采样：主技巧 + 副技巧，算子固定 couple。两技巧须在同一解题路径的关键步耦合，禁止拼盘。',
        parameters: {
            primaryTechniqueId: { type: 'string', required: true },
            secondaryTechniqueId: { type: 'string', required: true },
            main: { type: 'string' },
            abilities: { type: 'array', items: { type: 'string' } },
            minEstimatedSteps: { type: 'number', description: '默认 4' },
        },
        output: {
            schema: {
                type: 'object',
                properties: {
                    pathSummary: { type: 'string' },
                    hardConstraints: { type: 'array', items: { type: 'string' } },
                    techniqueMode: { type: 'object', additionalProperties: true },
                },
                additionalProperties: true,
            },
            render: (_a, v) => {
                const tm = v.techniqueMode;
                return [
                    {
                        type: 'text',
                        text: `【技巧组合】${tm?.techniqueName} × ${tm?.secondaryTechniqueName}\n` +
                            `${tm?.migrationStatementTemplate}\n` +
                            `硬约束:\n- ${v.hardConstraints.join('\n- ')}`,
                    },
                ];
            },
        },
        async execute(args) {
            return bank.sampleTechniqueCombo(args.primaryTechniqueId, args.secondaryTechniqueId, {
                main: args.main,
                abilities: args.abilities,
                minEstimatedSteps: args.minEstimatedSteps,
            });
        },
    }));
    ctx.tools.register(defineTool({
        name: 'plan_technique_batch',
        description: '对一组 TECH 批量产出创新采样计划（不写题）。operator 默认 transfer_domain；couple 时自动与列表中下一个技巧配对。',
        parameters: {
            techniqueIds: {
                type: 'array',
                items: { type: 'string' },
                required: true,
            },
            operator: { type: 'string' },
            main: { type: 'string' },
        },
        output: {
            schema: {
                type: 'object',
                properties: {
                    count: { type: 'number' },
                    summaries: { type: 'array', items: { type: 'string' } },
                },
                additionalProperties: true,
            },
            render: (_a, v) => [
                {
                    type: 'text',
                    text: `批量计划 ${v.count} 条:\n${v.summaries.map((s, i) => `${i + 1}. ${s}`).join('\n')}`,
                },
            ],
        },
        async execute(args) {
            const { items } = await bank.planTechniqueBatch(args.techniqueIds, {
                operator: args.operator,
                main: args.main,
            });
            return {
                count: items.length,
                summaries: items.map((s) => s.pathSummary),
                items,
            };
        },
    }));
    ctx.tools.register(defineTool({
        name: 'review_innovation',
        description: '创新门禁：自动检查骨架/技巧/禁止 patternId/步数/组合标注/近重复，并返回人工两问。生成入库后调用。',
        parameters: {
            problemId: { type: 'string', required: true },
            forbiddenPatternIds: {
                type: 'array',
                items: { type: 'string' },
                description: '来自采样结果的禁止列表（可选）',
            },
            minEstimatedSteps: { type: 'number' },
            primaryTechniqueId: { type: 'string' },
            secondaryTechniqueId: { type: 'string' },
            operator: { type: 'string' },
        },
        output: {
            schema: {
                type: 'object',
                properties: {
                    problemId: { type: 'string' },
                    passAuto: { type: 'boolean' },
                    humanGateQuestions: { type: 'array', items: { type: 'string' } },
                },
                additionalProperties: true,
            },
            render: (_a, v) => [
                {
                    type: 'text',
                    text: `创新审阅 ${v.problemId}: 自动门禁 ${v.passAuto ? '通过' : '未通过'}\n` +
                        `人工确认:\n- ${v.humanGateQuestions.join('\n- ')}`,
                },
            ],
        },
        async execute(args) {
            const sampleStub = {
                forbiddenPatternIds: args.forbiddenPatternIds || [],
                minEstimatedSteps: args.minEstimatedSteps || 3,
                techniqueMode: {
                    techniqueId: args.primaryTechniqueId,
                    secondaryTechniqueId: args.secondaryTechniqueId,
                    operator: args.operator || 'transfer_domain',
                },
            };
            return bank.reviewInnovation(args.problemId, sampleStub);
        },
    }));
    // ==================== 审核与入库 ====================
    ctx.tools.register(defineTool({
        name: 'submit_for_review',
        description: '将草稿提交审核（draft → pending_review）。',
        parameters: { id: { type: 'string', required: true } },
        output: {
            schema: {
                type: 'object',
                properties: { id: { type: 'string' }, status: { type: 'string' } },
                additionalProperties: false,
            },
            render: (_a, v) => [
                { type: 'text', text: `题目 ${v.id} 已进入待审核状态。` },
            ],
        },
        async execute(args) {
            const p = await bank.submitForReview(args.id);
            return { id: p.id, status: p.status };
        },
    }));
    ctx.tools.register(defineTool({
        name: 'review_problem',
        description: '审核题目。decision: approve | reject',
        parameters: {
            id: { type: 'string', required: true },
            decision: { type: 'string', required: true },
            notes: { type: 'string' },
            reviewer: { type: 'string' },
        },
        output: {
            schema: {
                type: 'object',
                properties: {
                    id: { type: 'string' },
                    status: { type: 'string' },
                    decision: { type: 'string' },
                },
                additionalProperties: false,
            },
            render: (_a, v) => [
                {
                    type: 'text',
                    text: `题目 ${v.id} 审核结果：${v.decision} → ${v.status}`,
                },
            ],
        },
        async execute(args) {
            const decision = args.decision;
            if (decision !== 'approve' && decision !== 'reject') {
                throw new Error('decision 必须是 approve 或 reject');
            }
            const p = await bank.review(args.id, decision, args.notes, args.reviewer);
            return { id: p.id, status: p.status, decision };
        },
    }));
    ctx.tools.register(defineTool({
        name: 'commit_problem',
        description: '正式入库。requireHumanReview=true 时必须先 approve。autoGitCommit=true 时自动 git commit。',
        parameters: { id: { type: 'string', required: true } },
        output: {
            schema: {
                type: 'object',
                properties: {
                    id: { type: 'string' },
                    status: { type: 'string' },
                    version: { type: 'number' },
                    gitOk: { type: 'boolean' },
                    gitDetail: { type: 'string' },
                },
                additionalProperties: false,
            },
            render: (_a, v) => [
                {
                    type: 'text',
                    text: `题目 ${v.id} 已入库（v${v.version}）。Git: ${v.gitOk ? v.gitDetail : '未提交 — ' + v.gitDetail}`,
                },
            ],
        },
        async execute(args) {
            const { problem: p, git } = await bank.commit(args.id);
            return {
                id: p.id,
                status: p.status,
                version: p.meta.version,
                gitOk: git.ok,
                gitDetail: git.detail,
            };
        },
    }));
    // ==================== 检索与引用（核心省 token） ====================
    ctx.tools.register(defineTool({
        name: 'get_problem',
        description: '按 id 获取题目完整结构化内容。后续对话请优先用此工具引用，而不是重新粘贴全文。',
        parameters: { id: { type: 'string', required: true } },
        output: {
            schema: {
                type: 'object',
                properties: {
                    id: { type: 'string' },
                    status: { type: 'string' },
                    stem: { type: 'string' },
                    solution: { type: 'string' },
                    knowledgePoints: { type: 'array', items: { type: 'string' } },
                    difficulty: { type: 'number' },
                    subgraph: { type: 'object', additionalProperties: true },
                    version: { type: 'number' },
                },
                additionalProperties: true,
            },
            render: (_a, v) => [
                {
                    type: 'text',
                    text: `【${v.id}】难度 ${v.difficulty}\n题面：\n${v.stem}\n\n解析：\n${v.solution}`,
                },
            ],
        },
        async execute(args) {
            const p = await bank.get(args.id);
            if (!p)
                throw new Error(`题目不存在: ${args.id}`);
            return {
                id: p.id,
                status: p.status,
                stem: p.content.stem,
                solution: p.content.solution,
                knowledgePoints: p.content.knowledgePoints,
                difficulty: p.content.difficulty,
                abilityLevels: p.content.abilityLevels,
                subgraph: p.subgraph,
                version: p.meta.version,
                source: p.source,
                links: p.links,
            };
        },
    }));
    ctx.tools.register(defineTool({
        name: 'search_problems',
        description: '检索题库。支持知识点、难度、能力、主知识点、必须包含/排除的支撑知识点等图谱约束。',
        parameters: {
            keyword: { type: 'string' },
            knowledgePoint: { type: 'string' },
            difficulty: { type: 'number' },
            status: { type: 'string' },
            tag: { type: 'string' },
            ability: { type: 'string' },
            mainKnowledge: { type: 'string', description: '主知识点必须匹配' },
            mustIncludeSupporting: {
                type: 'array',
                items: { type: 'string' },
                description: '必须包含的支撑知识点',
            },
            excludeKnowledge: {
                type: 'array',
                items: { type: 'string' },
                description: '排除的知识点',
            },
            limit: { type: 'number' },
        },
        output: {
            schema: {
                type: 'object',
                properties: {
                    total: { type: 'number' },
                    items: {
                        type: 'array',
                        items: {
                            type: 'object',
                            properties: {
                                id: { type: 'string' },
                                status: { type: 'string' },
                                difficulty: { type: 'number' },
                                main: { type: 'string' },
                                stemPreview: { type: 'string' },
                            },
                            additionalProperties: false,
                        },
                    },
                },
                additionalProperties: false,
            },
            render: (_a, v) => {
                const lines = v.items.map((it) => `- ${it.id} [${it.status}] 难${it.difficulty} 主=${it.main || '-'} | ${it.stemPreview}`);
                return [
                    {
                        type: 'text',
                        text: `找到 ${v.total} 道题：\n${lines.join('\n') || '（无结果）'}`,
                    },
                ];
            },
        },
        async execute(args) {
            const query = {
                keyword: args.keyword,
                knowledgePoint: args.knowledgePoint,
                difficulty: args.difficulty,
                status: args.status,
                tag: args.tag,
                ability: args.ability,
                mainKnowledge: args.mainKnowledge,
                mustIncludeSupporting: args.mustIncludeSupporting,
                excludeKnowledge: args.excludeKnowledge,
                limit: args.limit || 20,
            };
            const list = await bank.search(query);
            return {
                total: list.length,
                items: list.map((p) => ({
                    id: p.id,
                    status: p.status,
                    difficulty: p.content.difficulty,
                    main: p.subgraph?.main,
                    stemPreview: p.content.stem.slice(0, 80).replace(/\n/g, ' ') +
                        (p.content.stem.length > 80 ? '…' : ''),
                })),
            };
        },
    }));
    ctx.tools.register(defineTool({
        name: 'link_problem',
        description: '为题目关联讲义、背景文章或其他题目。',
        parameters: {
            id: { type: 'string', required: true },
            lectureIds: { type: 'array', items: { type: 'string' } },
            backgroundArticleIds: { type: 'array', items: { type: 'string' } },
            relatedProblemIds: { type: 'array', items: { type: 'string' } },
        },
        output: {
            schema: {
                type: 'object',
                properties: { id: { type: 'string' }, links: { type: 'object', additionalProperties: true } },
                additionalProperties: true,
            },
            render: (_a, v) => [
                { type: 'text', text: `题目 ${v.id} 关联已更新。` },
            ],
        },
        async execute(args) {
            const p = await bank.link(args.id, {
                lectureIds: args.lectureIds,
                backgroundArticleIds: args.backgroundArticleIds,
                relatedProblemIds: args.relatedProblemIds,
            });
            return { id: p.id, links: p.links };
        },
    }));
    // ==================== 试卷风格分析 + 模拟卷生成 ====================
    ctx.tools.register(defineTool({
        name: 'analyze_paper_style',
        description: '分析一组真题（如中科大少年班历年题）的风格画像：难度分布、能力分布、主知识点频率、高频子图模式、结构分节。结果用于后续模仿出模拟卷。',
        parameters: {
            name: {
                type: 'string',
                required: true,
                description: '风格名称，如「中科大少年班2018-2024」',
            },
            problemIds: {
                type: 'array',
                items: { type: 'string' },
                required: true,
                description: '用于分析的题目 id 列表',
            },
            styleId: {
                type: 'string',
                description: '可选自定义风格 id',
            },
        },
        output: {
            schema: {
                type: 'object',
                properties: {
                    styleId: { type: 'string' },
                    name: { type: 'string' },
                    totalQuestions: { type: 'number' },
                    difficultyDistribution: { type: 'object', additionalProperties: true },
                    topMains: { type: 'array', items: { type: 'string' } },
                    styleNotes: { type: 'string' },
                },
                additionalProperties: true,
            },
            render: (_a, v) => [
                {
                    type: 'text',
                    text: `风格画像已生成：${v.name}（${v.styleId}），共 ${v.totalQuestions} 题。\n${v.styleNotes}`,
                },
            ],
        },
        async execute(args) {
            const profile = await bank.analyzeStyle(args.name, args.problemIds, args.styleId);
            return {
                styleId: profile.id,
                name: profile.name,
                totalQuestions: profile.totalQuestions,
                difficultyDistribution: profile.difficultyDistribution,
                abilityDistribution: profile.abilityDistribution,
                topMains: profile.mainKnowledgeFrequency.slice(0, 10).map((m) => m.id),
                frequentPatterns: profile.frequentSubgraphPatterns.slice(0, 8),
                styleNotes: profile.styleNotes,
            };
        },
    }));
    ctx.tools.register(defineTool({
        name: 'plan_mock_paper',
        description: '根据风格画像生成模拟卷计划：为每一题槽位采样主知识点、支撑、能力、负样本与难度。模型应按计划逐题生成，再填回试卷。',
        parameters: {
            styleProfileId: {
                type: 'string',
                required: true,
                description: 'analyze_paper_style 返回的 styleId',
            },
            paperTitle: { type: 'string', description: '模拟卷标题' },
            questionCount: {
                type: 'number',
                description: '题量，默认与风格画像一致',
            },
            preferMains: {
                type: 'array',
                items: { type: 'string' },
                description: '优先使用的主知识点 id 列表（可选）',
            },
        },
        output: {
            schema: {
                type: 'object',
                properties: {
                    paperId: { type: 'string' },
                    title: { type: 'string' },
                    slotCount: { type: 'number' },
                    overallGuidance: { type: 'string' },
                    slots: { type: 'array' },
                },
                additionalProperties: true,
            },
            render: (_a, v) => [
                {
                    type: 'text',
                    text: `模拟卷计划已生成：${v.title}（${v.paperId}），共 ${v.slotCount} 题。\n` +
                        `请按 slots 逐题生成，生成后 structure + attach_subgraph + check_near_duplicates，再 fill_paper_slot。\n` +
                        v.overallGuidance,
                },
            ],
        },
        async execute(args) {
            const { paper, plan } = await bank.planMockPaper(args.styleProfileId, {
                paperTitle: args.paperTitle,
                questionCount: args.questionCount,
                preferMains: args.preferMains,
            });
            return {
                paperId: paper.id,
                title: paper.title,
                slotCount: paper.slots.length,
                overallGuidance: plan.overallGuidance,
                slots: plan.slots.map((s) => ({
                    order: s.order,
                    section: s.section,
                    main: s.sample.main,
                    supporting: s.sample.supporting,
                    abilities: s.sample.abilities,
                    suggestedDifficulty: s.sample.suggestedDifficulty,
                    pathSummary: s.sample.pathSummary,
                    negativePatterns: s.sample.negativePatterns,
                    avoidProblemIds: s.avoidProblemIds,
                })),
            };
        },
    }));
    ctx.tools.register(defineTool({
        name: 'fill_paper_slot',
        description: '将已生成并入库的题目填入模拟卷的指定槽位。全部填完后试卷状态变为 ready。',
        parameters: {
            paperId: { type: 'string', required: true },
            order: { type: 'number', required: true, description: '题号/槽位序号' },
            problemId: { type: 'string', required: true },
        },
        output: {
            schema: {
                type: 'object',
                properties: {
                    paperId: { type: 'string' },
                    order: { type: 'number' },
                    problemId: { type: 'string' },
                    status: { type: 'string' },
                    filled: { type: 'number' },
                    total: { type: 'number' },
                },
                additionalProperties: false,
            },
            render: (_a, v) => [
                {
                    type: 'text',
                    text: `试卷 ${v.paperId} 第 ${v.order} 题已填入 ${v.problemId}（${v.filled}/${v.total}），状态 ${v.status}`,
                },
            ],
        },
        async execute(args) {
            const paper = await bank.fillPaperSlot(args.paperId, args.order, args.problemId);
            const filled = paper.slots.filter((s) => s.problemId).length;
            return {
                paperId: paper.id,
                order: args.order,
                problemId: args.problemId,
                status: paper.status,
                filled,
                total: paper.slots.length,
            };
        },
    }));
    ctx.tools.register(defineTool({
        name: 'get_paper',
        description: '获取试卷详情（含各槽位与已填题目 id）。',
        parameters: {
            paperId: { type: 'string', required: true },
        },
        output: {
            schema: {
                type: 'object',
                properties: {
                    id: { type: 'string' },
                    title: { type: 'string' },
                    status: { type: 'string' },
                    slots: { type: 'array' },
                },
                additionalProperties: true,
            },
            render: (_a, v) => {
                const lines = v.slots
                    .map((s) => `${s.order}. [${s.section || ''}] ${s.problemId || '（空）'} 目标:${s.targetMain || '-'} 难${s.targetDifficulty || '-'}`)
                    .join('\n');
                return [
                    {
                        type: 'text',
                        text: `试卷 ${v.title}（${v.id}）状态 ${v.status}\n${lines}`,
                    },
                ];
            },
        },
        async execute(args) {
            const paper = await bank.getPaper(args.paperId);
            if (!paper)
                throw new Error(`试卷不存在: ${args.paperId}`);
            return {
                id: paper.id,
                title: paper.title,
                status: paper.status,
                styleProfileId: paper.styleProfileId,
                slots: paper.slots,
                totalScore: paper.totalScore,
                notes: paper.notes,
            };
        },
    }));
    // 不依赖可能不存在的 ready 事件；插件激活时 effect 初始化
    ctx.effect(() => {
        void bank
            .init()
            .then(({ techniquesSeeded, bankRoot }) => {
            console.log(`[problem-bank] init ok. bankRoot=${bankRoot}, techniquesSeeded=${techniquesSeeded}, schemaVersion=5`);
        })
            .catch((e) => {
            console.error(`[problem-bank] init failed: ${e?.message || e}`);
        });
    });
}
