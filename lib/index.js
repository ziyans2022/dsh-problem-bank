/**
 * problem-bank v0.4 —— 节约 token + 知识图谱 + 题型骨架
 *
 * 核心价值：
 * 1. id 引用节约 token
 * 2. 知识子图结构化分类
 * 3. ProblemSkeleton：同 patternId 一票否决换皮
 * 4. 多信号近重复 + 强制 contrast/application 迁移采样
 */
import { readFileSync } from 'node:fs';
import { ProblemBankService } from './service.js';
import { migrateBank } from './migration.js';
import { PROMPT_ORDER, PROMPT_SECTION, promptText } from './prompt.js';
import { rubricSummary } from './difficulty.js';
// @deepseek-ai/dsh-tools 与 @deepseek-ai/schemastery 随 DSH 一起发布，但不保证能沿插件
// 自己的解析路径找到：插件装在 profile 的 node_modules 下，harness 的包在应用的 app.asar 里。
// 解析不到时降级——工具定义按原样注册（registry 只要求 parameters 是合法 JSON Schema），
// Config 则不再声明，apply 仍然拿得到配置对象。
let defineTool;
let Schema;
try {
    ;
    ({ defineTool } = await import('@deepseek-ai/dsh-tools'));
}
catch {
    // 降级路径：lib/tool-schemas.json 是构建期用真实 dsh-tools 编译好的 JSON Schema 快照。
    // 没有它就只能原样注册（parameters 是内部 spec，不是 JSON Schema），所以构建时必须生成。
    let baked = {};
    try {
        baked = JSON.parse(readFileSync(new URL('./tool-schemas.json', import.meta.url), 'utf8'));
    }
    catch {
        baked = {};
    }
    defineTool = (options) => {
        const hit = baked[options.name];
        return {
            ...options,
            parameters: hit?.parameters ?? options.parameters,
            output: { ...options.output, schema: hit?.output ?? options.output?.schema },
        };
    };
}
try {
    Schema = (await import('@deepseek-ai/schemastery')).default;
}
catch {
    Schema = undefined;
}
export const name = 'problem-bank';
export const inject = ['tools'];
const configShape = Schema
    ? Schema.object({
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
        requireVariationGate: Schema.boolean()
            .default(true)
            .description('是否强制变式质量门：入库前必须声明变式类型并通过 audit_variation（关闭后旧题库可直接 commit）'),
        requireInnovationReview: Schema.boolean()
            .default(true)
            .description('入库前是否必须通过创新审核（关闭后 commit 不再要求 innovation 记录，但人工审核与内容哈希校验仍生效）'),
        allowSimplified: Schema.boolean()
            .default(false)
            .description('是否允许 simplified（降难）变式通过质量门；默认禁止，降难只能作为显式教学模式'),
    })
    : undefined;
export const Config = configShape;
// schemastery 缺席时（安装环境解析不到）Config 不会被实例化，schema 默认值也就不会生效。
// 因此在进入 service 之前显式补一份默认值，保证降级路径下的行为与正常安装一致。
const DEFAULTS = {
    bankRoot: './problem-bank-data',
    idPrefix: 'ZH',
    autoGitCommit: false,
    requireHumanReview: true,
    defaultDifficulty: 3,
    gitAuthorName: 'problem-bank',
    gitAuthorEmail: 'problem-bank@local',
    nearDuplicateThreshold: 0.75,
    requireVariationGate: true,
    allowSimplified: false,
    requireInnovationReview: true,
};
function withDefaults(config) {
    const merged = { ...DEFAULTS };
    for (const [key, value] of Object.entries(config ?? {})) {
        if (value !== undefined)
            merged[key] = value;
    }
    return merged;
}
export function apply(ctx, rawConfig) {
    const config = withDefaults(rawConfig);
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
    // ==================== 变式质量门 ====================
    ctx.tools.register(defineTool({
        name: 'record_variation_intent',
        description: '变式质量门第 1 步（生成前必须先调用）：声明变式类型、目标，并写出原题与候选题的难度剖面（核心结论、关键技巧、最难的一步、一般性、证明义务）。非变式题请用 variationType=original。只替代数字或删掉最难一步的「简化改写」会在 audit_variation 被拦截。',
        parameters: {
            id: { type: 'string', required: true, description: '候选题 id' },
            variationType: {
                type: 'string',
                enum: [
                    'original',
                    'isomorphic',
                    'structural',
                    'harder',
                    'extension',
                    'simplified',
                ],
                required: true,
                description: 'original 原始题 / isomorphic 同构（保持深度换表述）/ structural 结构（换结构保思想）/ harder 增难（新增障碍）/ extension 拓展（推广或研究边界）/ simplified 降难（不计为创新，默认禁止）',
            },
            originalProblemId: {
                type: 'string',
                description: '原题 id（非 original 必填）',
            },
            target: {
                type: 'string',
                description: '本次变式目标：保持难度 / 增加难度 / 结构迁移 / 推广',
            },
            coreClaim: { type: 'string', required: true, description: '核心结论' },
            keyTechniques: {
                type: 'array',
                items: { type: 'string' },
                description: '关键技巧（Technique id 或一句话）',
            },
            hardestStep: {
                type: 'string',
                required: true,
                description: '最难的一步：要想到什么（不要只写步数）',
            },
            generality: {
                type: 'string',
                enum: ['general-n', 'finite-case', 'single-instance'],
                required: true,
                description: '一般性：general-n 对任意 n / finite-case 有限情形 / single-instance 单例',
            },
            proofObligations: {
                type: 'array',
                items: { type: 'string' },
                description: '必须完成的证明义务',
            },
        },
        output: {
            schema: {
                type: 'object',
                properties: {
                    id: { type: 'string' },
                    variationType: { type: 'string' },
                    originalProblemId: { type: 'string' },
                    target: { type: 'string' },
                    generality: { type: 'string' },
                    originalGenerality: { type: 'string' },
                },
                additionalProperties: false,
            },
            render: (_a, v) => [
                {
                    type: 'text',
                    text: `题目 ${v.id} 变式类型：${v.variationType}` +
                        (v.originalProblemId ? `（原题 ${v.originalProblemId}）` : '') +
                        `；一般性 ${v.generality}` +
                        (v.originalGenerality ? `（原题 ${v.originalGenerality}）` : '') +
                        '。下一步：写完题面与解析后调用 audit_variation。',
                },
            ],
        },
        async execute(args) {
            const p = await bank.recordVariationIntent(args.id, {
                variationType: args.variationType,
                originalProblemId: args.originalProblemId,
                target: args.target,
                profile: {
                    coreClaim: args.coreClaim,
                    keyTechniques: args.keyTechniques || [],
                    hardestStep: args.hardestStep,
                    generality: args.generality,
                    proofObligations: args.proofObligations || [],
                },
            });
            return {
                id: p.id,
                variationType: p.variation.type,
                originalProblemId: p.variation.originalProblemId || '',
                target: p.variation.target || '',
                generality: p.variation.profile.generality,
                originalGenerality: p.variation.originalProfile?.generality || '',
            };
        },
    }));
    ctx.tools.register(defineTool({
        name: 'audit_variation',
        description: '变式质量门第 2 步（入库前必须通过）：逐项核对「保留了什么难点 / 新增了什么障碍 / 削弱了什么 / 是否独立求解」，并检查一般性未被降低。任何一项不通过都会阻止 commit_problem。',
        parameters: {
            id: { type: 'string', required: true },
            preserved: {
                type: 'array',
                items: { type: 'string' },
                required: true,
                description: '保留了什么核心难点（至少一条，要具体）',
            },
            added: {
                type: 'array',
                items: { type: 'string' },
                description: '新增了什么推理障碍（harder/structural/extension 必填）',
            },
            weakened: {
                type: 'array',
                items: { type: 'string' },
                description: '削弱了什么（非 simplified 必须为空）',
            },
            conditionsCompatible: { type: 'boolean', required: true },
            solutionExists: { type: 'boolean', required: true },
            boundaryChecked: { type: 'boolean', required: true },
            proofComplete: { type: 'boolean', required: true },
            notes: { type: 'string', description: '求解与核验记录' },
        },
        output: {
            schema: {
                type: 'object',
                properties: {
                    id: { type: 'string' },
                    passed: { type: 'boolean' },
                    checks: {
                        type: 'array',
                        items: {
                            type: 'object',
                            properties: {
                                id: { type: 'string' },
                                label: { type: 'string' },
                                passed: { type: 'boolean' },
                                detail: { type: 'string' },
                            },
                            additionalProperties: false,
                        },
                    },
                    nextAction: { type: 'string' },
                },
                additionalProperties: false,
            },
            render: (_a, v) => {
                const checks = v.checks || [];
                const failed = checks.filter((c) => !c.passed);
                return [
                    {
                        type: 'text',
                        text: v.passed
                            ? `质量门通过（${checks.length} 项全绿），可以 submit_for_review。`
                            : `质量门未通过：${failed
                                .map((c) => `${c.label}（${c.detail}）`)
                                .join('；')}`,
                    },
                ];
            },
        },
        async execute(args) {
            const r = await bank.auditVariation(args.id, {
                preserved: args.preserved || [],
                added: args.added || [],
                weakened: args.weakened || [],
                solving: {
                    conditionsCompatible: args.conditionsCompatible,
                    solutionExists: args.solutionExists,
                    boundaryChecked: args.boundaryChecked,
                    proofComplete: args.proofComplete,
                    notes: args.notes,
                },
            });
            return {
                id: r.problem.id,
                passed: r.passed,
                checks: r.audit.checks,
                nextAction: r.nextAction,
            };
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
            force: {
                type: 'boolean',
                description: '难度硬约束不满足时强行填入（必须同时给 reason）',
            },
            reason: { type: 'string', description: '强行填入的理由，会记录在试卷槽位上' },
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
                    warnings: { type: 'array', items: { type: 'string' } },
                },
                additionalProperties: false,
            },
            render: (_a, v) => [
                {
                    type: 'text',
                    text: `试卷 ${v.paperId} 第 ${v.order} 题已填入 ${v.problemId}（${v.filled}/${v.total}），状态 ${v.status}` +
                        (v.warnings.length ? '\n' + v.warnings.join('\n') : ''),
                },
            ],
        },
        async execute(args) {
            const filled0 = await bank.fillPaperSlot(args.paperId, args.order, args.problemId, { force: args.force, reason: args.reason });
            const paper = filled0.paper;
            const filled = paper.slots.filter((s) => s.problemId).length;
            return {
                paperId: paper.id,
                order: args.order,
                problemId: args.problemId,
                status: paper.status,
                filled,
                total: paper.slots.length,
                warnings: filled0.warnings,
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
    // v0.6.0 新增工具注册块（插入到 index.ts 的 ctx.effect 之前）
    // ==================== 多解法（模块 A） ====================
    ctx.tools.register(defineTool({
        name: 'add_solution',
        description: '为题目追加一条解法。同一题可以有多条独立解法（代数/几何/解析/组合…），各自有独立的审核状态。第一条解法自动成为主解法。',
        parameters: {
            problemId: { type: 'string', required: true },
            title: { type: 'string', required: true, description: '解法标题，如「换元法」' },
            approach: {
                type: 'string',
                required: true,
                description: 'algebraic | geometric | analytic | combinatorial | synthetic | other',
            },
            keyIdea: { type: 'string', required: true, description: '这条路线的核心想法（一两句）' },
            techniqueIds: { type: 'array', description: '用到的技巧 id' },
            body: { type: 'string', description: '完整解法正文（Markdown）' },
            steps: { type: 'array', description: '结构化步骤 [{order, statement, justification?}]' },
            setAsPrimary: { type: 'boolean', description: '是否设为主解法' },
        },
        output: {
            schema: {
                type: 'object',
                properties: {
                    problemId: { type: 'string' },
                    solutionId: { type: 'string' },
                    primarySolutionId: { type: 'string' },
                    total: { type: 'number' },
                },
                additionalProperties: false,
            },
            render: (_a, v) => [
                {
                    type: 'text',
                    text: `已加入解法 ${v.solutionId}（主解法 ${v.primarySolutionId}，共 ${v.total} 条）`,
                },
            ],
        },
        async execute(args) {
            const p = await bank.addSolution(args.problemId, {
                title: args.title,
                approach: args.approach,
                keyIdea: args.keyIdea,
                techniqueIds: args.techniqueIds ?? [],
                body: args.body,
                steps: args.steps ?? [],
                verification: { status: 'unverified' },
            });
            if (args.setAsPrimary) {
                const sols = p.content.solutions ?? [];
                const last = sols[sols.length - 1];
                await bank.setPrimarySolution(args.problemId, last.id);
            }
            return {
                problemId: p.id,
                solutionId: (p.content.solutions ?? []).slice(-1)[0]?.id ?? '',
                primarySolutionId: p.content.primarySolutionId ?? '',
                total: (p.content.solutions ?? []).length,
            };
        },
    }));
    ctx.tools.register(defineTool({
        name: 'update_solution',
        description: '修改某条解法的内容或审核状态。改动正文会把审核状态打回 unverified（除非显式传 verificationStatus）。',
        parameters: {
            problemId: { type: 'string', required: true },
            solutionId: { type: 'string', required: true },
            title: { type: 'string' },
            keyIdea: { type: 'string' },
            body: { type: 'string' },
            steps: { type: 'array' },
            verificationStatus: {
                type: 'string',
                description: 'unverified | reviewed | verified',
            },
            verificationNotes: { type: 'string' },
            reviewer: { type: 'string' },
        },
        output: {
            schema: {
                type: 'object',
                properties: {
                    problemId: { type: 'string' },
                    solutionId: { type: 'string' },
                    verification: { type: 'string' },
                    summary: { type: 'string' },
                },
                additionalProperties: false,
            },
            render: (_a, v) => [{ type: 'text', text: v.summary }],
        },
        async execute(args) {
            const patch = {};
            if (args.title)
                patch.title = args.title;
            if (args.keyIdea)
                patch.keyIdea = args.keyIdea;
            if (args.body !== undefined)
                patch.body = args.body;
            if (args.steps)
                patch.steps = args.steps;
            if (args.verificationStatus) {
                patch.verification = {
                    status: args.verificationStatus,
                    reviewer: args.reviewer,
                    notes: args.verificationNotes,
                    checkedAt: new Date().toISOString(),
                };
            }
            const p = await bank.updateSolution(args.problemId, args.solutionId, patch);
            const sol = (p.content.solutions ?? []).find((s) => s.id === args.solutionId);
            const summary = `解法 ${args.solutionId} 已更新；状态 ${sol?.verification?.status ?? 'unverified'}；共 ${(p.content.solutions ?? []).length} 条解法`;
            return {
                problemId: p.id,
                solutionId: args.solutionId,
                verification: sol?.verification?.status ?? 'unverified',
                summary,
            };
        },
    }));
    ctx.tools.register(defineTool({
        name: 'remove_solution',
        description: '删除一条解法。删掉主解法时会把下一条提升为主解法；若一条不剩会保留 legacy 主解法。',
        parameters: {
            problemId: { type: 'string', required: true },
            solutionId: { type: 'string', required: true },
        },
        output: {
            schema: {
                type: 'object',
                properties: {
                    problemId: { type: 'string' },
                    removed: { type: 'string' },
                    primarySolutionId: { type: 'string' },
                    total: { type: 'number' },
                },
                additionalProperties: false,
            },
            render: (_a, v) => [
                {
                    type: 'text',
                    text: `已删除 ${v.removed}；当前主解法 ${v.primarySolutionId}，剩余 ${v.total} 条`,
                },
            ],
        },
        async execute(args) {
            const p = await bank.removeSolution(args.problemId, args.solutionId);
            return {
                problemId: p.id,
                removed: args.solutionId,
                primarySolutionId: p.content.primarySolutionId ?? '',
                total: (p.content.solutions ?? []).length,
            };
        },
    }));
    ctx.tools.register(defineTool({
        name: 'set_primary_solution',
        description: '切换主解法。主解法会被同步到旧的 solution 字段，保证兼容只读 solution 的调用方。',
        parameters: {
            problemId: { type: 'string', required: true },
            solutionId: { type: 'string', required: true },
        },
        output: {
            schema: {
                type: 'object',
                properties: {
                    problemId: { type: 'string' },
                    primarySolutionId: { type: 'string' },
                    title: { type: 'string' },
                },
                additionalProperties: false,
            },
            render: (_a, v) => [
                { type: 'text', text: `主解法已切换为 ${v.primarySolutionId}（${v.title}）` },
            ],
        },
        async execute(args) {
            const p = await bank.setPrimarySolution(args.problemId, args.solutionId);
            const sol = (p.content.solutions ?? []).find((s) => s.id === p.content.primarySolutionId);
            return {
                problemId: p.id,
                primarySolutionId: p.content.primarySolutionId ?? '',
                title: sol?.title ?? '',
            };
        },
    }));
    // ==================== 知识图谱 v2（模块 B） ====================
    ctx.tools.register(defineTool({
        name: 'kg_validate_graph',
        description: '检查知识图谱：缺失端点、重复边、权重越界、数学关系缺证据状态、prerequisite 成环。返回 errors / warnings 列表，不修改数据。',
        parameters: {},
        output: {
            schema: {
                type: 'object',
                properties: {
                    ok: { type: 'boolean' },
                    errors: { type: 'array', items: { type: 'string' } },
                    warnings: { type: 'array', items: { type: 'string' } },
                    summary: { type: 'string' },
                },
                additionalProperties: false,
            },
            render: (_a, v) => [
                {
                    type: 'text',
                    text: `${v.ok ? '✅' : '❌'} ${v.summary}\n` +
                        v.errors.map((e) => `错误: ${e}`).join('\n') +
                        (v.warnings.length
                            ? '\n' + v.warnings.map((w) => `警告: ${w}`).join('\n')
                            : ''),
                },
            ],
        },
        async execute() {
            const r = await bank.kg.validateGraph();
            const summary = `错误 ${r.errors.length} 条，警告 ${r.warnings.length} 条`;
            return { ok: r.ok, errors: r.errors, warnings: r.warnings, summary };
        },
    }));
    ctx.tools.register(defineTool({
        name: 'kg_get_neighbors',
        description: '按关系类型/层级取某个知识点的邻居（默认双向）。',
        parameters: {
            nodeId: { type: 'string', required: true },
            type: { type: 'string', description: '只看某一类关系，如 prerequisite' },
            layer: { type: 'string', description: 'learning | mathematical' },
            direction: { type: 'string', description: 'out | in | both（默认 both）' },
        },
        output: {
            schema: {
                type: 'object',
                properties: {
                    nodeId: { type: 'string' },
                    neighbors: { type: 'array' },
                    count: { type: 'number' },
                },
                additionalProperties: false,
            },
            render: (_a, v) => [
                {
                    type: 'text',
                    text: `${v.nodeId} 的邻居 ${v.count} 个：\n` +
                        v.neighbors
                            .map((n) => `- ${n.node?.id ?? '?'} ${n.node?.name ?? ''} [${n.relation?.type ?? ''}${n.direction === 'in' ? ' ←' : ' →'}]`)
                            .join('\n'),
                },
            ],
        },
        async execute(args) {
            const neighbors = await bank.kg.getNeighbors(args.nodeId, {
                type: args.type,
                layer: args.layer,
                direction: args.direction ?? 'both',
            });
            return {
                nodeId: args.nodeId,
                neighbors,
                count: neighbors.length,
            };
        },
    }));
    ctx.tools.register(defineTool({
        name: 'kg_get_prerequisites',
        description: '取某知识点的前置知识（沿 prerequisite 反向遍历，按深度排序）。',
        parameters: {
            nodeId: { type: 'string', required: true },
            maxDepth: { type: 'number', description: '默认 2' },
        },
        output: {
            schema: {
                type: 'object',
                properties: {
                    nodeId: { type: 'string' },
                    prerequisites: { type: 'array', items: { type: 'string' } },
                    count: { type: 'number' },
                },
                additionalProperties: false,
            },
            render: (_a, v) => [
                {
                    type: 'text',
                    text: `${v.nodeId} 的前置（${v.count}）：${v.prerequisites.join('、') || '无'}`,
                },
            ],
        },
        async execute(args) {
            const pre = await bank.kg.getPrerequisites(args.nodeId, args.maxDepth ?? 2);
            return { nodeId: args.nodeId, prerequisites: pre, count: pre.length };
        },
    }));
    ctx.tools.register(defineTool({
        name: 'kg_find_related_concepts',
        description: '找一个知识点在数学层/学习层上相邻的概念，用于出题时找迁移与对比素材。',
        parameters: {
            nodeId: { type: 'string', required: true },
            limit: { type: 'number', description: '默认 10' },
        },
        output: {
            schema: {
                type: 'object',
                properties: {
                    nodeId: { type: 'string' },
                    related: { type: 'array' },
                    count: { type: 'number' },
                },
                additionalProperties: false,
            },
            render: (_a, v) => [
                {
                    type: 'text',
                    text: `与 ${v.nodeId} 相关的概念 ${v.count} 个：` +
                        v.related.map((r) => r.name ?? r.id).join('、'),
                },
            ],
        },
        async execute(args) {
            const related = (await bank.kg.findRelatedConcepts(args.nodeId)).slice(0, args.limit ?? 10);
            return { nodeId: args.nodeId, related, count: related.length };
        },
    }));
    ctx.tools.register(defineTool({
        name: 'kg_find_learning_path',
        description: '在 prerequisite 图上找从起点到目标的学习路径（BFS，默认最多 8 层）。',
        parameters: {
            from: { type: 'string', required: true },
            to: { type: 'string', required: true },
            maxDepth: { type: 'number', description: '默认 8' },
        },
        output: {
            schema: {
                type: 'object',
                properties: {
                    found: { type: 'boolean' },
                    path: { type: 'array', items: { type: 'string' } },
                    summary: { type: 'string' },
                },
                additionalProperties: false,
            },
            render: (_a, v) => [{ type: 'text', text: v.summary }],
        },
        async execute(args) {
            const p = await bank.kg.findLearningPath(args.from, args.to, args.maxDepth ?? 8);
            const found = p.length > 0;
            return {
                found,
                path: p,
                summary: found
                    ? `路径（${p.length} 步）：${p.join(' → ')}`
                    : `未找到 ${args.from} → ${args.to} 的前置路径`,
            };
        },
    }));
    // ==================== 六维难度（模块 C） ====================
    ctx.tools.register(defineTool({
        name: 'get_difficulty_rubric',
        description: '返回六维难度的 rubric（每维 1–5 分的锚点说明），出题/评分前先读它。',
        parameters: {},
        output: {
            schema: {
                type: 'object',
                properties: {
                    rubricVersion: { type: 'number' },
                    dimensions: { type: 'array' },
                    text: { type: 'string' },
                },
                additionalProperties: false,
            },
            render: (_a, v) => [{ type: 'text', text: v.text }],
        },
        async execute() {
            const r = rubricSummary();
            return r;
        },
    }));
    ctx.tools.register(defineTool({
        name: 'assess_problem_difficulty',
        description: '给题目写六维难度初评（概念/技巧/证明深度/前置负担/洞察/一般性，各 1–5，必须写理由）。模型初评一律是 pending，需人工 review_difficulty_profile 才算数。overall 可选，会回写旧五级难度。',
        parameters: {
            problemId: { type: 'string', required: true },
            conceptual: { type: 'number', required: true, description: '概念理解 1–5' },
            technical: { type: 'number', required: true, description: '技巧执行 1–5' },
            proofDepth: { type: 'number', required: true, description: '证明深度 1–5' },
            prerequisiteLoad: { type: 'number', required: true, description: '前置负担 1–5' },
            ingenuity: { type: 'number', required: true, description: '洞察难度 1–5' },
            generality: { type: 'number', required: true, description: '一般性 1–5' },
            conceptualNote: { type: 'string', description: '概念维度的理由' },
            technicalNote: { type: 'string' },
            proofDepthNote: { type: 'string' },
            prerequisiteLoadNote: { type: 'string' },
            ingenuityNote: { type: 'string' },
            generalityNote: { type: 'string' },
            overall: { type: 'number', description: '总难度 1–5（可选）' },
            assessedBy: { type: 'string', description: 'human | model | empirical，默认 model' },
        },
        output: {
            schema: {
                type: 'object',
                properties: {
                    problemId: { type: 'string' },
                    overall: { type: 'number' },
                    reviewStatus: { type: 'string' },
                    warnings: { type: 'array', items: { type: 'string' } },
                },
                additionalProperties: false,
            },
            render: (_a, v) => [
                {
                    type: 'text',
                    text: `六维难度已写入 ${v.problemId}（overall=${v.overall ?? '-'}，状态 ${v.reviewStatus}）` +
                        (v.warnings.length
                            ? '\n' + v.warnings.join('\n')
                            : ''),
                },
            ],
        },
        async execute(args) {
            const mk = (level, note) => ({
                level: level,
                rationale: note ?? '',
            });
            const profile = {
                rubricVersion: 1,
                dimensions: {
                    conceptual: mk(args.conceptual, args.conceptualNote),
                    technical: mk(args.technical, args.technicalNote),
                    proofDepth: mk(args.proofDepth, args.proofDepthNote),
                    prerequisiteLoad: mk(args.prerequisiteLoad, args.prerequisiteLoadNote),
                    ingenuity: mk(args.ingenuity, args.ingenuityNote),
                    generality: mk(args.generality, args.generalityNote),
                },
                overall: args.overall,
                assessedBy: args.assessedBy ?? 'model',
                reviewStatus: 'pending',
                assessedAt: new Date().toISOString(),
            };
            const r = await bank.assessDifficulty(args.problemId, profile);
            return {
                problemId: r.problem.id,
                overall: r.problem.content.difficultyProfile?.overall ?? 0,
                reviewStatus: r.problem.content.difficultyProfile?.reviewStatus ?? 'pending',
                warnings: r.warnings,
            };
        },
    }));
    ctx.tools.register(defineTool({
        name: 'update_difficulty_profile',
        description: '只改六维中的一维（其余保留）。改分后 reviewStatus 自动回到 pending。',
        parameters: {
            problemId: { type: 'string', required: true },
            dimension: {
                type: 'string',
                required: true,
                description: 'conceptual | technical | proofDepth | prerequisiteLoad | ingenuity | generality',
            },
            rating: { type: 'number', required: true, description: '1–5' },
            rationale: { type: 'string', description: '这一维的打分理由' },
        },
        output: {
            schema: {
                type: 'object',
                properties: {
                    problemId: { type: 'string' },
                    dimension: { type: 'string' },
                    rating: { type: 'number' },
                    reviewStatus: { type: 'string' },
                },
                additionalProperties: false,
            },
            render: (_a, v) => [
                {
                    type: 'text',
                    text: `${v.problemId} 的 ${v.dimension} 改为 ${v.rating}（状态 ${v.reviewStatus}）`,
                },
            ],
        },
        async execute(args) {
            const p = await bank.patchDifficultyDimension(args.problemId, args.dimension, {
                level: args.rating,
                rationale: args.rationale ?? '',
            });
            return {
                problemId: p.id,
                dimension: args.dimension,
                rating: args.rating,
                reviewStatus: p.content.difficultyProfile?.reviewStatus ?? 'pending',
            };
        },
    }));
    ctx.tools.register(defineTool({
        name: 'review_difficulty_profile',
        description: '人工确认/驳回六维评分。只有这里能把 reviewStatus 变成 reviewed。',
        parameters: {
            problemId: { type: 'string', required: true },
            approve: { type: 'boolean', required: true },
            reviewer: { type: 'string', description: '审核人，默认 human' },
            notes: { type: 'string' },
        },
        output: {
            schema: {
                type: 'object',
                properties: {
                    problemId: { type: 'string' },
                    reviewStatus: { type: 'string' },
                    reviewedBy: { type: 'string' },
                },
                additionalProperties: false,
            },
            render: (_a, v) => [
                {
                    type: 'text',
                    text: `${v.problemId} 难度评分 ${v.reviewStatus}${v.reviewedBy ? `（${v.reviewedBy}）` : ''}`,
                },
            ],
        },
        async execute(args) {
            const p = await bank.reviewDifficultyProfile(args.problemId, args.reviewer ?? 'human', args.approve, args.notes);
            return {
                problemId: p.id,
                reviewStatus: p.content.difficultyProfile?.reviewStatus ?? 'pending',
                reviewedBy: p.content.difficultyProfile?.reviewedBy ?? '',
            };
        },
    }));
    ctx.tools.register(defineTool({
        name: 'compare_problem_difficulty',
        description: '逐维比较两道题（给出每维差值，不做加权平均）。用于检查「变式是不是变简单了」。',
        parameters: {
            a: { type: 'string', required: true, description: '原题 id' },
            b: { type: 'string', required: true, description: '变式 id' },
        },
        output: {
            schema: {
                type: 'object',
                properties: {
                    a: { type: 'string' },
                    b: { type: 'string' },
                    totalDelta: { type: 'number' },
                    lower: { type: 'array', items: { type: 'string' } },
                    text: { type: 'string' },
                },
                additionalProperties: true,
            },
            render: (_a, v) => [{ type: 'text', text: v.text }],
        },
        async execute(args) {
            const cmp = await bank.compareDifficulty(args.a, args.b);
            const lower = (cmp.dimensions ?? [])
                .filter((d) => d.delta < 0)
                .map((d) => `${d.dimension}(${d.a}→${d.b})`);
            return {
                ...cmp,
                lower,
                text: `${args.a} → ${args.b}\n` +
                    (cmp.dimensions ?? [])
                        .map((d) => `${d.dimension}: ${d.a} → ${d.b} (${d.delta >= 0 ? '+' : ''}${d.delta})`)
                        .join('\n') +
                    (lower.length ? `\n⚠️ 变简单的维度：${lower.join('、')}` : '\n✅ 没有维度下降'),
            };
        },
    }));
    // ==================== 迁移（PR-4） ====================
    ctx.tools.register(defineTool({
        name: 'migrate_bank',
        description: '把 v5 题库迁移到 v6（多解法 / 六维难度 / 关系分层）。默认先 dryRun 看影响面。迁移前自动备份，可 rollback。不自动生成解法、不自动推测难度、不自动创建关系。',
        parameters: {
            dryRun: { type: 'boolean', description: '默认 true' },
        },
        output: {
            schema: {
                type: 'object',
                properties: {
                    dryRun: { type: 'boolean' },
                    scanned: { type: 'number' },
                    migrated: { type: 'number' },
                    skipped: { type: 'number' },
                    failed: { type: 'number' },
                    unresolvedRelations: { type: 'number' },
                    backupId: { type: 'string' },
                    reportPath: { type: 'string' },
                    summary: { type: 'string' },
                },
                additionalProperties: false,
            },
            render: (_a, v) => [{ type: 'text', text: v.summary }],
        },
        async execute(args) {
            const dryRun = args.dryRun !== false;
            const r = await migrateBank(bank.config.bankRoot, { dryRun });
            const summary = `扫描 ${r.scanned} 题：迁移 ${r.migrated}，跳过 ${r.skipped}，失败 ${r.failed.length}` +
                `，待审关系 ${r.unresolvedRelations}` +
                (dryRun ? '（dryRun，未写入）' : `；备份 ${r.backupId}，报告 ${r.reportPath}`);
            return {
                dryRun,
                scanned: r.scanned,
                migrated: r.migrated,
                skipped: r.skipped,
                failed: r.failed.length,
                unresolvedRelations: r.unresolvedRelations,
                backupId: r.backupId,
                reportPath: r.reportPath,
                summary,
            };
        },
    }));
    // 往系统提示里加一段摘要。systemPrompt 是可选服务：拿不到就静默跳过，
    // 免得插件因为一个非关键能力缺失而整体加载失败。
    const systemPrompt = ctx
        .systemPrompt;
    if (typeof systemPrompt?.section === 'function') {
        ctx.effect(() => systemPrompt.section({ name: PROMPT_SECTION, order: PROMPT_ORDER, text: promptText() }));
    }
    // 不依赖可能不存在的 ready 事件；插件激活时 effect 初始化
    ctx.effect(() => {
        void bank
            .init()
            .then(({ techniquesSeeded, bankRoot }) => {
            console.log(`[problem-bank] init ok. bankRoot=${bankRoot}, techniquesSeeded=${techniquesSeeded}, schemaVersion=6`);
        })
            .catch((e) => {
            console.error(`[problem-bank] init failed: ${e?.message || e}`);
        });
    });
}
