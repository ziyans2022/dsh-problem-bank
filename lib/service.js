/**
 * ProblemBank Service
 * - 题目持久化（按年份 Markdown + frontmatter）
 * - 状态机 + 版本控制
 * - 可选 Git 自动 commit
 * - 集成轻量知识图谱（子图关联、近重复检测、生成采样）
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Service } from '@deepseek-ai/cordis';
import { PROBLEM_SCHEMA_VERSION } from './types.js';
import { KnowledgeGraph } from './kg.js';
import { allocateNextId, lockedAtomicWrite, } from './storage.js';
const execFileAsync = promisify(execFile);
export class ProblemBankService extends Service {
    config;
    kg;
    constructor(ctx, config) {
        super(ctx, 'problemBank');
        this.config = {
            nearDuplicateThreshold: 0.75,
            ...config,
        };
        this.kg = new KnowledgeGraph(config.bankRoot);
    }
    /** 启动时调用：确保目录、技巧种子、id 序列可用 */
    async init() {
        const bankRoot = path.resolve(this.config.bankRoot);
        this.config.bankRoot = bankRoot;
        await this.ensureDir(bankRoot);
        await this.ensureDir(path.join(bankRoot, 'kg'));
        await this.ensureDir(path.join(bankRoot, 'papers'));
        const techniquesSeeded = await this.kg.ensureTechniqueSeed();
        return { techniquesSeeded, bankRoot };
    }
    async ensureDir(dir) {
        await fs.mkdir(dir, { recursive: true });
    }
    async listYearDirs() {
        try {
            const entries = await fs.readdir(this.config.bankRoot, { withFileTypes: true });
            return entries
                .filter((e) => e.isDirectory() && /^\d{4}$/.test(e.name))
                .map((e) => e.name)
                .sort();
        }
        catch {
            return [];
        }
    }
    async findProblemPath(id) {
        const years = await this.listYearDirs();
        const currentYear = String(new Date().getFullYear());
        const ordered = [currentYear, ...years.filter((y) => y !== currentYear)].reverse();
        for (const year of ordered) {
            const candidate = path.join(this.config.bankRoot, year, `${id}.md`);
            try {
                await fs.access(candidate);
                return candidate;
            }
            catch {
                // continue
            }
        }
        return null;
    }
    getNewProblemPath(id) {
        const year = new Date().getFullYear();
        return path.join(this.config.bankRoot, String(year), `${id}.md`);
    }
    /** 扫描已有题号最大值（序列文件落后时的兜底） */
    async scanMaxIdNum() {
        const years = await this.listYearDirs();
        const currentYear = String(new Date().getFullYear());
        let max = 0;
        for (const year of [...years, currentYear]) {
            const yearDir = path.join(this.config.bankRoot, year);
            try {
                const files = await fs.readdir(yearDir);
                for (const f of files) {
                    const m = f.match(new RegExp(`^${this.config.idPrefix}-(\\d+)\\.md$`));
                    if (m)
                        max = Math.max(max, parseInt(m[1], 10));
                }
            }
            catch {
                // ignore
            }
        }
        return max;
    }
    async nextId() {
        await this.ensureDir(this.config.bankRoot);
        const currentYear = String(new Date().getFullYear());
        await this.ensureDir(path.join(this.config.bankRoot, currentYear));
        return allocateNextId(this.config.bankRoot, this.config.idPrefix, () => this.scanMaxIdNum());
    }
    toMarkdown(p) {
        const fm = {
            schemaVersion: PROBLEM_SCHEMA_VERSION,
            id: p.id,
            status: p.status,
            source: p.source,
            knowledgePoints: p.content.knowledgePoints,
            difficulty: p.content.difficulty,
            tags: p.content.tags ?? [],
            abilityLevels: p.content.abilityLevels ?? [],
            figures: p.content.figures ?? [],
            subgraph: p.subgraph ?? null,
            skeleton: p.skeleton ?? null,
            techniques: p.techniques ?? [],
            review: p.review ?? null,
            links: p.links ?? null,
            meta: p.meta,
        };
        const yamlLines = Object.entries(fm).map(([k, v]) => `${k}: ${JSON.stringify(v)}`);
        const figuresSection = (p.content.figures ?? [])
            .map((f, i) => {
            const caption = f.caption ? `> ${f.caption}\n\n` : '';
            return `## 【配图】${i + 1} (${f.type})\n\n${caption}${f.content}`;
        })
            .join('\n\n');
        return `---
${yamlLines.join('\n')}
---

## 题面

${p.content.stem}

## 解析

${p.content.solution}

${figuresSection}
`;
    }
    /**
     * 按顶级标题切分正文。识别：
     * - ## 题面
     * - ## 解析
     * - ## 图形…（与 toMarkdown 一致，兼容旧「## 配图」）
     * 题面/解析内部的 ## 小问 等不切换分段。
     */
    splitBodySections(body) {
        const lines = body.split(/\r?\n/);
        let mode = 'none';
        const stemLines = [];
        const solutionLines = [];
        for (const line of lines) {
            if (/^## 题面\s*$/.test(line)) {
                mode = 'stem';
                continue;
            }
            if (/^## 解析\s*$/.test(line)) {
                mode = 'solution';
                continue;
            }
            // 仅匹配 toMarkdown 的「## 【配图】」；兼容 0.5.4「## 图形 N (type)」整行（须带括号类型）
            // 新格式 ## 【配图】N；兼容 0.5.4 整行「## 图形 N (type)」（须带括号类型，避免切走题面「## 图形 1 示意」）
            if (/^## 【配图】/.test(line) ||
                /^## (?:图形|配图)\s+\d+\s*\([^)]*\)\s*$/.test(line) ||
                /^## (?:图形|配图)\s*$/.test(line)) {
                mode = 'other';
                continue;
            }
            if (mode === 'stem')
                stemLines.push(line);
            else if (mode === 'solution')
                solutionLines.push(line);
        }
        return {
            stem: stemLines.join('\n').trim(),
            solution: solutionLines.join('\n').trim(),
        };
    }
    /**
     * 解析 frontmatter：每行 key: JSON
     * schemaVersion 缺失视为旧版（1），读入后不强制改写磁盘，下次 write 升到 PROBLEM_SCHEMA_VERSION
     */
    fromMarkdown(raw, id) {
        const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
        if (!match)
            throw new Error(`Invalid problem file format: ${id}`);
        const fm = {};
        for (const line of match[1].split(/\r?\n/)) {
            if (!line.trim() || line.trim().startsWith('#'))
                continue;
            const idx = line.indexOf(':');
            if (idx === -1)
                continue;
            const key = line.slice(0, idx).trim();
            const val = line.slice(idx + 1).trim();
            if (!key)
                continue;
            try {
                fm[key] = JSON.parse(val);
            }
            catch {
                // 非 JSON 标量兜底，避免偶发坏行整文件失败
                fm[key] = val;
            }
        }
        const schemaVersion = typeof fm.schemaVersion === 'number' ? fm.schemaVersion : 1;
        if (schemaVersion > PROBLEM_SCHEMA_VERSION) {
            console.warn(`[problem-bank] ${id} schemaVersion=${schemaVersion} > 支持版本 ${PROBLEM_SCHEMA_VERSION}，按最佳努力解析`);
        }
        const body = match[2];
        // 行扫描分段：不依赖 \b（中文后 \b 永不成立），题面内「## 小问」保留
        const { stem, solution } = this.splitBodySections(body);
        return {
            id: fm.id ?? id,
            status: fm.status ?? 'draft',
            source: fm.source ?? { type: 'manual' },
            content: {
                stem,
                solution,
                figures: fm.figures ?? [],
                knowledgePoints: fm.knowledgePoints ?? [],
                difficulty: fm.difficulty ?? 3,
                tags: fm.tags ?? [],
                abilityLevels: fm.abilityLevels ?? [],
            },
            subgraph: fm.subgraph ?? undefined,
            skeleton: fm.skeleton ?? undefined,
            techniques: fm.techniques ?? undefined,
            review: fm.review ?? undefined,
            links: fm.links ?? undefined,
            meta: fm.meta ?? {
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
                version: 1,
            },
        };
    }
    async write(p) {
        let filePath = await this.findProblemPath(p.id);
        if (!filePath)
            filePath = this.getNewProblemPath(p.id);
        await this.ensureDir(path.dirname(filePath));
        await lockedAtomicWrite(filePath, this.toMarkdown(p), this.config.bankRoot);
    }
    async read(id) {
        const filePath = await this.findProblemPath(id);
        if (!filePath)
            return null;
        try {
            const raw = await fs.readFile(filePath, 'utf8');
            return this.fromMarkdown(raw, id);
        }
        catch {
            return null;
        }
    }
    async tryGitCommit(message) {
        if (!this.config.autoGitCommit) {
            return { ok: false, detail: 'autoGitCommit=false' };
        }
        const cwd = this.config.bankRoot;
        try {
            await execFileAsync('git', ['rev-parse', '--is-inside-work-tree'], { cwd });
        }
        catch {
            try {
                await execFileAsync('git', ['init'], { cwd });
                if (this.config.gitAuthorName) {
                    await execFileAsync('git', ['config', 'user.name', this.config.gitAuthorName], { cwd });
                }
                if (this.config.gitAuthorEmail) {
                    await execFileAsync('git', ['config', 'user.email', this.config.gitAuthorEmail], { cwd });
                }
            }
            catch (e) {
                return { ok: false, detail: `git init failed: ${e.message}` };
            }
        }
        try {
            await execFileAsync('git', ['add', '-A'], { cwd });
            const { stdout } = await execFileAsync('git', ['status', '--porcelain'], { cwd });
            if (!stdout.trim())
                return { ok: true, detail: 'nothing to commit' };
            await execFileAsync('git', ['commit', '-m', message], { cwd });
            return { ok: true, detail: 'committed' };
        }
        catch (e) {
            return { ok: false, detail: e.message || String(e) };
        }
    }
    // ---------- 题目 API ----------
    async createDraft(raw) {
        const id = await this.nextId();
        const now = new Date().toISOString();
        let stem = '';
        if (raw.text)
            stem = raw.text;
        else if (raw.imageDescription)
            stem = raw.imageDescription;
        else if (raw.imagePath)
            stem = `[图片待识别] ${raw.imagePath}`;
        else if (raw.filePath)
            stem = `[文件] ${raw.filePath}`;
        const problem = {
            id,
            status: 'draft',
            source: {
                type: raw.sourceType ?? (raw.imagePath ? 'screenshot' : 'manual'),
                originalRef: raw.imagePath || raw.filePath || raw.imageDescription,
                uploader: raw.uploader,
                capturedAt: now,
            },
            content: {
                stem,
                solution: '',
                knowledgePoints: [],
                difficulty: this.config.defaultDifficulty,
                figures: raw.imagePath ? [{ type: 'image_path', content: raw.imagePath }] : [],
            },
            meta: { createdAt: now, updatedAt: now, version: 1 },
        };
        await this.write(problem);
        this.ctx.emit('problem/draft-created', problem);
        return problem;
    }
    async get(id) {
        return this.read(id);
    }
    async updateContent(id, patch) {
        const p = await this.read(id);
        if (!p)
            throw new Error(`Problem not found: ${id}`);
        p.content = { ...p.content, ...patch };
        p.meta.updatedAt = new Date().toISOString();
        p.meta.version += 1;
        await this.write(p);
        this.ctx.emit('problem/structured', p);
        return p;
    }
    async attachSubgraph(id, subgraph) {
        const p = await this.read(id);
        if (!p)
            throw new Error(`Problem not found: ${id}`);
        p.subgraph = subgraph;
        p.content.knowledgePoints = [subgraph.main, ...subgraph.supporting];
        p.content.abilityLevels = subgraph.abilities;
        p.meta.updatedAt = new Date().toISOString();
        p.meta.version += 1;
        await this.write(p);
        this.ctx.emit('problem/subgraph-attached', p);
        return p;
    }
    async attachSkeleton(id, skeleton) {
        const p = await this.read(id);
        if (!p)
            throw new Error(`Problem not found: ${id}`);
        if (!skeleton.patternId?.trim()) {
            throw new Error('skeleton.patternId 不能为空');
        }
        if (!skeleton.keyMoves?.length) {
            throw new Error('skeleton.keyMoves 至少包含一个关键变形');
        }
        p.skeleton = skeleton;
        p.meta.updatedAt = new Date().toISOString();
        p.meta.version += 1;
        await this.write(p);
        this.ctx.emit('problem/skeleton-attached', p);
        return p;
    }
    async attachTechniques(id, techniqueIds) {
        const p = await this.read(id);
        if (!p)
            throw new Error(`Problem not found: ${id}`);
        if (!techniqueIds?.length)
            throw new Error('techniqueIds 不能为空');
        for (const tid of techniqueIds) {
            const t = await this.kg.getTechnique(tid);
            if (!t)
                throw new Error(`技巧不存在: ${tid}，请先 kg_add_technique`);
        }
        p.techniques = [...new Set([...(p.techniques || []), ...techniqueIds])];
        p.meta.updatedAt = new Date().toISOString();
        p.meta.version += 1;
        await this.write(p);
        this.ctx.emit('problem/techniques-attached', p);
        return p;
    }
    async loadProblemsForSampling() {
        const [a, b, c] = await Promise.all([
            this.search({ status: 'approved', limit: 400 }),
            this.search({ status: 'draft', limit: 400 }),
            this.search({ status: 'pending_review', limit: 400 }),
        ]);
        const seen = new Set();
        const all = [];
        for (const p of [...a, ...b, ...c]) {
            if (seen.has(p.id))
                continue;
            seen.add(p.id);
            all.push(p);
        }
        return all;
    }
    async sampleByTechnique(techniqueId, options) {
        const all = await this.loadProblemsForSampling();
        return this.kg.sampleByTechnique(techniqueId, {
            ...options,
            existingProblems: all,
        });
    }
    async sampleTechniqueCombo(primaryId, secondaryId, options) {
        const all = await this.loadProblemsForSampling();
        return this.kg.sampleTechniqueCombo(primaryId, secondaryId, {
            ...options,
            existingProblems: all,
        });
    }
    async reviewInnovation(problemId, sample) {
        const p = await this.read(problemId);
        if (!p)
            throw new Error(`Problem not found: ${problemId}`);
        const notes = [];
        const hasSkeleton = !!p.skeleton?.patternId;
        const hasTechniques = (p.techniques || []).length > 0;
        if (!hasSkeleton)
            notes.push('缺少 skeleton.patternId');
        if (!hasTechniques)
            notes.push('缺少 techniques 标注');
        const forbidden = sample?.forbiddenPatternIds || [];
        const patternIdForbidden = !!p.skeleton?.patternId && forbidden.includes(p.skeleton.patternId);
        if (patternIdForbidden) {
            notes.push(`patternId 落在禁止列表: ${p.skeleton.patternId}`);
        }
        const minSteps = sample?.minEstimatedSteps ?? 3;
        const estimatedStepsOk = !p.skeleton?.estimatedSteps || p.skeleton.estimatedSteps >= minSteps;
        if (!estimatedStepsOk) {
            notes.push(`estimatedSteps=${p.skeleton?.estimatedSteps} < 要求 ${minSteps}`);
        }
        const needCouple = sample?.techniqueMode?.operator === 'couple' ||
            !!sample?.techniqueMode?.secondaryTechniqueId;
        const techSet = new Set(p.techniques || []);
        const couplingOk = !needCouple ||
            (!!sample?.techniqueMode?.techniqueId &&
                !!sample?.techniqueMode?.secondaryTechniqueId &&
                techSet.has(sample.techniqueMode.techniqueId) &&
                techSet.has(sample.techniqueMode.secondaryTechniqueId));
        if (needCouple && !couplingOk) {
            notes.push('组合题未同时标注主/副技巧');
        }
        if (p.subgraph && p.skeleton) {
            const near = await this.checkNearDuplicates(p.subgraph, undefined, p.skeleton);
            if (near.length) {
                notes.push(`近重复命中: ${near
                    .map((n) => `${n.problemId}(${(n.score * 100).toFixed(0)}%)`)
                    .join(', ')}`);
            }
        }
        const humanGateQuestions = sample?.techniqueMode?.humanGateQuestions || [
            '去掉数字与字母后，是否仍能一眼看出与某道 exemplar 同构？若是则退回。',
            '核心一步是否仍是目标技巧，而不是漂成普通题？',
        ];
        const passAuto = hasSkeleton &&
            hasTechniques &&
            !patternIdForbidden &&
            estimatedStepsOk &&
            couplingOk &&
            !notes.some((n) => n.startsWith('近重复'));
        return {
            problemId,
            auto: {
                hasSkeleton,
                hasTechniques,
                patternIdForbidden,
                forbiddenHit: patternIdForbidden ? p.skeleton?.patternId : undefined,
                estimatedStepsOk,
                couplingOk,
                notes,
            },
            humanGateQuestions,
            passAuto,
        };
    }
    async planTechniqueBatch(techniqueIds, options) {
        const op = options?.operator || 'transfer_domain';
        const items = [];
        for (let i = 0; i < techniqueIds.length; i++) {
            const id = techniqueIds[i];
            let secondary = options?.pairWith?.[id] ||
                (op === 'couple'
                    ? techniqueIds[(i + 1) % techniqueIds.length]
                    : undefined);
            if (secondary === id)
                secondary = undefined;
            items.push(await this.sampleByTechnique(id, {
                main: options?.main,
                operator: op,
                secondaryTechniqueId: secondary,
            }));
        }
        return { items };
    }
    async submitForReview(id) {
        const p = await this.read(id);
        if (!p)
            throw new Error(`Problem not found: ${id}`);
        if (p.status !== 'draft' && p.status !== 'rejected') {
            throw new Error(`Cannot submit from status: ${p.status}`);
        }
        p.status = 'pending_review';
        p.meta.updatedAt = new Date().toISOString();
        p.meta.version += 1;
        await this.write(p);
        this.ctx.emit('problem/submitted-for-review', p);
        return p;
    }
    async review(id, decision, notes, reviewer) {
        const p = await this.read(id);
        if (!p)
            throw new Error(`Problem not found: ${id}`);
        // 人工审核：仅允许 pending_review；关闭 requireHumanReview 时允许 draft 直批
        const allowed = this.config.requireHumanReview
            ? ['pending_review']
            : ['pending_review', 'draft'];
        if (!allowed.includes(p.status)) {
            throw new Error(`Cannot review from status: ${p.status}（requireHumanReview=${this.config.requireHumanReview}）`);
        }
        if (p.status === 'rejected') {
            throw new Error('rejected 题目须先 submit_for_review 再审核，禁止直接 approve');
        }
        p.status = decision === 'approve' ? 'approved' : 'rejected';
        p.review = { reviewer, notes, reviewedAt: new Date().toISOString() };
        p.meta.updatedAt = new Date().toISOString();
        p.meta.version += 1;
        await this.write(p);
        this.ctx.emit('problem/reviewed', p, decision);
        return p;
    }
    async commit(id) {
        const p = await this.read(id);
        if (!p)
            throw new Error(`Problem not found: ${id}`);
        if (p.status === 'rejected') {
            throw new Error('rejected 状态禁止 commit；请修改后重新 submit_for_review');
        }
        if (this.config.requireHumanReview && p.status !== 'approved') {
            throw new Error(`requireHumanReview=true，当前状态 ${p.status} 不允许直接入库。请先 review 通过。`);
        }
        // 未开启人工审核时：draft/pending_review 可在 commit 时升为 approved；rejected 已拦截
        if (p.status !== 'approved') {
            if (p.status !== 'draft' && p.status !== 'pending_review') {
                throw new Error(`Cannot commit from status: ${p.status}`);
            }
            p.status = 'approved';
        }
        p.meta.updatedAt = new Date().toISOString();
        p.meta.version += 1;
        await this.write(p);
        this.ctx.emit('problem/committed', p);
        const git = await this.tryGitCommit(`problem-bank: commit ${p.id} (v${p.meta.version})`);
        if (git.ok)
            this.ctx.emit('problem/git-committed', p, git.detail);
        return { problem: p, git };
    }
    async search(query) {
        const years = await this.listYearDirs();
        const results = [];
        const limit = query.limit ?? 20;
        for (const year of years.reverse()) {
            const yearDir = path.join(this.config.bankRoot, year);
            let files = [];
            try {
                files = await fs.readdir(yearDir);
            }
            catch {
                continue;
            }
            for (const f of files) {
                if (!f.endsWith('.md'))
                    continue;
                const id = f.replace(/\.md$/, '');
                const p = await this.read(id);
                if (!p)
                    continue;
                if (query.status && p.status !== query.status)
                    continue;
                if (query.difficulty && p.content.difficulty !== query.difficulty)
                    continue;
                if (query.ability && !(p.content.abilityLevels ?? []).includes(query.ability))
                    continue;
                if (query.mainKnowledge && p.subgraph?.main !== query.mainKnowledge)
                    continue;
                if (query.mustIncludeSupporting?.length) {
                    const supporting = new Set(p.subgraph?.supporting ?? []);
                    if (!query.mustIncludeSupporting.every((k) => supporting.has(k)))
                        continue;
                }
                if (query.excludeKnowledge?.length) {
                    const all = new Set([
                        ...(p.subgraph ? [p.subgraph.main, ...p.subgraph.supporting] : []),
                        ...p.content.knowledgePoints,
                    ]);
                    if (query.excludeKnowledge.some((k) => all.has(k)))
                        continue;
                }
                if (query.knowledgePoint &&
                    !p.content.knowledgePoints.some((k) => k.toLowerCase().includes(query.knowledgePoint.toLowerCase())) &&
                    p.subgraph?.main !== query.knowledgePoint &&
                    !(p.subgraph?.supporting ?? []).includes(query.knowledgePoint))
                    continue;
                if (query.tag &&
                    !(p.content.tags ?? []).some((t) => t.toLowerCase().includes(query.tag.toLowerCase())))
                    continue;
                if (query.keyword) {
                    const kw = query.keyword.toLowerCase();
                    const text = `${p.content.stem} ${p.content.solution} ${p.content.knowledgePoints.join(' ')}`.toLowerCase();
                    if (!text.includes(kw))
                        continue;
                }
                results.push(p);
                if (results.length >= limit)
                    return results;
            }
        }
        return results;
    }
    async link(id, links) {
        const p = await this.read(id);
        if (!p)
            throw new Error(`Problem not found: ${id}`);
        p.links = { ...p.links, ...links };
        p.meta.updatedAt = new Date().toISOString();
        p.meta.version += 1;
        await this.write(p);
        return p;
    }
    /** 近重复检测：子图 + 骨架多信号；同 patternId 一票否决。
     * 覆盖 draft/pending_review/approved，避免批量变体互不查重。
     */
    async checkNearDuplicates(subgraph, threshold, skeleton) {
        const [a, b, c] = await Promise.all([
            this.search({ status: 'approved', limit: 400 }),
            this.search({ status: 'draft', limit: 400 }),
            this.search({ status: 'pending_review', limit: 400 }),
        ]);
        const seen = new Set();
        const all = [];
        for (const p of [...a, ...b, ...c]) {
            if (seen.has(p.id))
                continue;
            seen.add(p.id);
            all.push(p);
        }
        return this.kg.findNearDuplicates(subgraph, all, threshold ?? this.config.nearDuplicateThreshold, skeleton);
    }
    /** 为原创生成做可控采样（强制迁移 + 禁止已有骨架） */
    async sampleForGeneration(mainId, options) {
        const existing = await this.search({
            mainKnowledge: mainId,
            status: 'approved',
            limit: 200,
        });
        // 也纳入同库其它已挂骨架的题，用于 forbiddenPatternIds
        const withSkeleton = await this.search({ status: 'approved', limit: 300 });
        const merged = [...existing];
        for (const p of withSkeleton) {
            if (!merged.find((x) => x.id === p.id))
                merged.push(p);
        }
        return this.kg.sampleForGeneration(mainId, {
            ...options,
            existingProblems: merged,
        });
    }
    async listAllBrief() {
        const years = await this.listYearDirs();
        const out = [];
        for (const year of years) {
            const yearDir = path.join(this.config.bankRoot, year);
            try {
                const files = await fs.readdir(yearDir);
                for (const f of files) {
                    if (!f.endsWith('.md'))
                        continue;
                    const id = f.replace(/\.md$/, '');
                    const p = await this.read(id);
                    if (p)
                        out.push({ id: p.id, status: p.status, year });
                }
            }
            catch {
                // ignore
            }
        }
        return out;
    }
    // ---------- 试卷 / 风格分析 / 模拟卷 ----------
    papersDir() {
        return path.join(this.config.bankRoot, 'papers');
    }
    async ensurePapersDir() {
        await this.ensureDir(this.papersDir());
    }
    paperPath(id) {
        return path.join(this.papersDir(), `${id}.json`);
    }
    stylePath(id) {
        return path.join(this.papersDir(), `style-${id}.json`);
    }
    async savePaper(paper) {
        await this.ensurePapersDir();
        paper.meta.updatedAt = new Date().toISOString();
        paper.meta.version += 1;
        await lockedAtomicWrite(this.paperPath(paper.id), JSON.stringify(paper, null, 2), this.config.bankRoot);
        return paper;
    }
    async getPaper(id) {
        try {
            const raw = await fs.readFile(this.paperPath(id), 'utf8');
            return JSON.parse(raw);
        }
        catch {
            return null;
        }
    }
    async saveStyleProfile(profile) {
        await this.ensurePapersDir();
        await lockedAtomicWrite(this.stylePath(profile.id), JSON.stringify(profile, null, 2), this.config.bankRoot);
        return profile;
    }
    async getStyleProfile(id) {
        try {
            const raw = await fs.readFile(this.stylePath(id), 'utf8');
            return JSON.parse(raw);
        }
        catch {
            return null;
        }
    }
    /**
     * 分析一组题目的风格画像（用于模仿中科大少年班等真题风格）
     */
    async analyzeStyle(name, problemIds, styleId) {
        const problems = [];
        for (const id of problemIds) {
            const p = await this.read(id);
            if (p)
                problems.push(p);
        }
        if (problems.length === 0) {
            throw new Error('没有找到有效题目，无法分析风格');
        }
        const diffCount = { '1': 0, '2': 0, '3': 0, '4': 0, '5': 0 };
        const abilityCount = {};
        const mainCount = new Map();
        const patternCount = new Map();
        const patternIdCount = new Map();
        const sectionCount = new Map();
        for (const p of problems) {
            const d = String(p.content.difficulty || 3);
            diffCount[d] = (diffCount[d] || 0) + 1;
            for (const ab of p.content.abilityLevels || p.subgraph?.abilities || []) {
                abilityCount[ab] = (abilityCount[ab] || 0) + 1;
            }
            if (p.subgraph?.main) {
                mainCount.set(p.subgraph.main, (mainCount.get(p.subgraph.main) || 0) + 1);
                const key = [p.subgraph.main, ...[...p.subgraph.supporting].sort()].join('+');
                patternCount.set(key, (patternCount.get(key) || 0) + 1);
            }
            if (p.skeleton?.patternId) {
                patternIdCount.set(p.skeleton.patternId, (patternIdCount.get(p.skeleton.patternId) || 0) + 1);
            }
            const section = (p.content.tags || []).find((t) => /选择|填空|解答|计算|证明|实验/.test(t)) || '未分节';
            sectionCount.set(section, (sectionCount.get(section) || 0) + 1);
        }
        const total = problems.length;
        const difficultyDistribution = {};
        for (const [k, v] of Object.entries(diffCount)) {
            difficultyDistribution[k] = +(v / total).toFixed(3);
        }
        const abilityDistribution = {};
        const abTotal = Object.values(abilityCount).reduce((a, b) => a + b, 0) || 1;
        for (const [k, v] of Object.entries(abilityCount)) {
            abilityDistribution[k] = +(v / abTotal).toFixed(3);
        }
        const mainKnowledgeFrequency = [...mainCount.entries()]
            .sort((a, b) => b[1] - a[1])
            .map(([id, count]) => ({ id, count }));
        const frequentSubgraphPatterns = [...patternCount.entries()]
            .sort((a, b) => b[1] - a[1])
            .slice(0, 15)
            .map(([k]) => k);
        const frequentPatternIds = [...patternIdCount.entries()]
            .sort((a, b) => b[1] - a[1])
            .slice(0, 20)
            .map(([k]) => k);
        const sectionDistribution = [...sectionCount.entries()].map(([section, count]) => ({
            section,
            count,
        }));
        const topMains = mainKnowledgeFrequency
            .slice(0, 8)
            .map((m) => m.id)
            .join('、');
        const styleNotes = [
            `共分析 ${total} 道题。`,
            `难度分布：${Object.entries(difficultyDistribution)
                .map(([k, v]) => `${k}星${(v * 100).toFixed(0)}%`)
                .join('，')}`,
            `能力侧重：${Object.entries(abilityDistribution)
                .sort((a, b) => b[1] - a[1])
                .slice(0, 5)
                .map(([k, v]) => `${k}${(v * 100).toFixed(0)}%`)
                .join('，')}`,
            `高频主知识点：${topMains || '（尚未挂载子图）'}`,
            `高频骨架：${frequentPatternIds.slice(0, 8).join('、') || '（尚未标注 skeleton）'}`,
            `结构：${sectionDistribution.map((s) => `${s.section}×${s.count}`).join('；')}`,
            '出题风格要求：保持相近难度与知识覆盖；禁止同 patternId 换参；须沿 contrast/application 做结构迁移；推理步数与真题相当或更深。',
        ].join('\n');
        const profile = {
            id: styleId || `style-${Date.now()}`,
            name,
            sourcePaperIds: problemIds,
            totalQuestions: total,
            sectionDistribution,
            difficultyDistribution,
            abilityDistribution,
            mainKnowledgeFrequency,
            frequentSubgraphPatterns,
            frequentPatternIds,
            styleNotes,
            createdAt: new Date().toISOString(),
        };
        await this.saveStyleProfile(profile);
        this.ctx.emit('paper/style-analyzed', profile);
        return profile;
    }
    /**
     * 根据风格画像生成「模拟卷计划」
     * 每道题给出 GenerationSample，模型按计划逐题生成后再入库组装
     */
    async planMockPaper(styleProfileId, options) {
        const profile = await this.getStyleProfile(styleProfileId);
        if (!profile)
            throw new Error(`风格画像不存在: ${styleProfileId}`);
        const count = options?.questionCount || profile.totalQuestions || 10;
        const mainsPool = options?.preferMains?.length
            ? options.preferMains
            : profile.mainKnowledgeFrequency.map((m) => m.id);
        if (mainsPool.length === 0) {
            throw new Error('风格画像中没有主知识点频率数据。请先为真题挂载 subgraph，再重新 analyze_style。');
        }
        // 按难度分布分配目标难度
        const diffTargets = [];
        for (let d = 1; d <= 5; d++) {
            const ratio = profile.difficultyDistribution[String(d)] || 0;
            const n = Math.round(ratio * count);
            for (let i = 0; i < n; i++)
                diffTargets.push(d);
        }
        while (diffTargets.length < count)
            diffTargets.push(3);
        while (diffTargets.length > count)
            diffTargets.pop();
        // 能力偏好
        const topAbilities = Object.entries(profile.abilityDistribution)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 3)
            .map(([k]) => k);
        const slots = [];
        const planSlots = [];
        for (let i = 0; i < count; i++) {
            const main = mainsPool[i % mainsPool.length];
            const targetDifficulty = diffTargets[i];
            const sample = await this.sampleForGeneration(main, {
                abilities: topAbilities.length ? topAbilities : ['应用'],
                maxSupporting: 2 + (targetDifficulty > 3 ? 1 : 0),
                negativeTopK: 5,
            });
            // 把风格中的高频模式也并入负样本
            const neg = new Set([
                ...sample.negativePatterns,
                ...profile.frequentSubgraphPatterns.slice(0, 8),
            ]);
            sample.negativePatterns = [...neg];
            const section = profile.sectionDistribution[i % Math.max(1, profile.sectionDistribution.length)]
                ?.section || '解答题';
            slots.push({
                order: i + 1,
                targetMain: main,
                targetDifficulty,
                targetAbilities: sample.abilities,
                section,
                generationHint: sample.pathSummary,
            });
            planSlots.push({
                order: i + 1,
                section,
                sample,
                avoidProblemIds: profile.sourcePaperIds,
            });
        }
        const paperId = `PAPER-${Date.now()}`;
        const paper = {
            id: paperId,
            title: options?.paperTitle || `${profile.name} · 模拟卷`,
            styleProfileId,
            status: 'generating',
            slots,
            meta: {
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
                version: 1,
            },
        };
        await this.savePaper(paper);
        const plan = {
            paperId,
            styleProfileId,
            slots: planSlots,
            overallGuidance: [
                profile.styleNotes,
                '请严格按每个 slot 的 sample 生成题目：',
                '- 主知识点与支撑组合尽量贴近 sample，但避开 negativePatterns',
                '- 难度与能力与目标一致',
                '- 生成后立即 structure_problem + attach_subgraph，并 check_near_duplicates',
                '- 通过后把 problemId 写回试卷对应 slot',
            ].join('\n'),
        };
        this.ctx.emit('paper/mock-planned', paper, plan);
        return { paper, plan };
    }
    /** 把已生成的题目填入试卷槽位 */
    async fillPaperSlot(paperId, order, problemId) {
        const paper = await this.getPaper(paperId);
        if (!paper)
            throw new Error(`试卷不存在: ${paperId}`);
        const slot = paper.slots.find((s) => s.order === order);
        if (!slot)
            throw new Error(`槽位 ${order} 不存在`);
        const problem = await this.read(problemId);
        if (!problem)
            throw new Error(`题目不存在: ${problemId}`);
        const dup = paper.slots.find((s) => s.order !== order && s.problemId === problemId);
        if (dup) {
            throw new Error(`题目 ${problemId} 已占用槽位 ${dup.order}，禁止重复填入`);
        }
        slot.problemId = problemId;
        const allFilled = paper.slots.every((s) => s.problemId);
        if (allFilled)
            paper.status = 'ready';
        paper.meta.updatedAt = new Date().toISOString();
        paper.meta.version += 1;
        return this.savePaper(paper);
    }
}
