/**
 * v5 → v6 迁移（PR-4）
 *
 * 三条底线：
 * 1. 不自动生成第二种解法 —— 旧题只有一个 solution 就只迁出一个 legacy 主解法；
 * 2. 不自动推测六维难度 —— 没有可靠证据就留空，reviewStatus 保持 pending；
 * 3. 不自动创建数学关系 —— 语义不明的边只标注待审，不猜它是等价还是蕴含。
 *
 * 迁移可重复运行（第二次应 migrated=0）、可回滚（备份目录）、不丢原始字节。
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { parseProblem, serializeProblem } from './markdown.js';
import { PROBLEM_SCHEMA_VERSION } from './types.js';
async function copyDir(src, dst) {
    await fs.mkdir(dst, { recursive: true });
    for (const entry of await fs.readdir(src, { withFileTypes: true })) {
        const from = path.join(src, entry.name);
        const to = path.join(dst, entry.name);
        if (entry.isDirectory())
            await copyDir(from, to);
        else if (entry.isFile())
            await fs.copyFile(from, to);
    }
}
function schemaVersionOf(raw) {
    const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    if (!m)
        return 1;
    const line = m[1].split(/\r?\n/).find((l) => l.trim().startsWith('schemaVersion:'));
    if (!line)
        return 1;
    const n = Number(line.slice(line.indexOf(':') + 1).trim());
    return Number.isFinite(n) ? n : 1;
}
async function normalizeRelations(bankRoot, backupDir) {
    const relPath = path.join(bankRoot, 'kg', 'relations.json');
    let relations;
    try {
        relations = JSON.parse(await fs.readFile(relPath, 'utf8'));
    }
    catch {
        return { unresolved: [], normalized: 0 };
    }
    // 备份已在 copyDir 阶段完成，这里只做标注，不删除任何边
    const unresolved = [];
    let normalized = 0;
    const LEGACY_EQUIV = 'equivalence';
    for (const r of relations) {
        let changed = false;
        if (r.type === LEGACY_EQUIV && !r.layer) {
            // 旧「equivalence」语义不明：保留边，但标记为待分类，不假设它是严格数学等价
            r.layer = 'learning';
            r.evidenceStatus = 'unreviewed';
            unresolved.push({
                id: r.id,
                from: r.from,
                to: r.to,
                type: r.type,
                reason: "legacy equivalence：旧等价边语义不明，保留待人工分类",
            });
            changed = true;
        }
        if (r.layer === 'mathematical' && !r.evidenceStatus) {
            // 数学关系必须有证据状态，缺了就降级为未审
            r.evidenceStatus = 'unreviewed';
            unresolved.push({
                id: r.id,
                from: r.from,
                to: r.to,
                type: r.type,
                reason: "数学关系缺少证据状态，已降级为 unreviewed",
            });
            changed = true;
        }
        if (changed)
            normalized += 1;
    }
    if (normalized) {
        await fs.writeFile(relPath, JSON.stringify(relations, null, 2), 'utf8');
    }
    await fs.writeFile(path.join(backupDir, '..', 'unresolved-relations.json'), JSON.stringify(unresolved, null, 2), 'utf8');
    return { unresolved, normalized };
}
export async function migrateBank(bankRoot, options = {}) {
    const dryRun = !!options.dryRun;
    const startedAt = new Date().toISOString();
    const stamp = (options.now ?? new Date())
        .toISOString()
        .replace(/[:.]/g, '-');
    const migrationRoot = path.join(bankRoot, 'migration', stamp);
    const backupDir = path.join(migrationRoot, 'backup');
    const reportPath = path.join(migrationRoot, 'migration-report.json');
    const failed = [];
    const notes = [];
    let scanned = 0;
    let migrated = 0;
    let skipped = 0;
    let unresolvedCount = 0;
    if (!dryRun) {
        // 只备份数据（年份目录 / kg / papers），不备份 migration 自身，否则会自我递归
        await fs.mkdir(backupDir, { recursive: true });
        for (const sub of ['kg', 'papers']) {
            const from = path.join(bankRoot, sub);
            if (await fs.stat(from).then((s) => s.isDirectory()).catch(() => false)) {
                await copyDir(from, path.join(backupDir, sub));
            }
        }
        for (const d of await fs.readdir(bankRoot).catch(() => [])) {
            if (!/^\d{4}$/.test(d))
                continue;
            await copyDir(path.join(bankRoot, d), path.join(backupDir, d));
        }
    }
    const years = (await fs.readdir(bankRoot).catch(() => [])).filter((d) => /^\d{4}$/.test(d));
    for (const year of years) {
        const dir = path.join(bankRoot, year);
        const files = (await fs.readdir(dir).catch(() => [])).filter((f) => f.endsWith('.md'));
        for (const f of files) {
            const id = f.replace(/\.md$/, '');
            scanned += 1;
            const file = path.join(dir, f);
            try {
                const raw = await fs.readFile(file, 'utf8');
                const version = schemaVersionOf(raw);
                if (version >= PROBLEM_SCHEMA_VERSION) {
                    skipped += 1;
                    continue;
                }
                const parsed = parseProblem(raw, id);
                if (!parsed.content.solutions?.length) {
                    // parseProblem 已为旧 solution 合成 legacy 主解法；这里只补默认标题
                    notes.push(`${id}: 旧格式只有一条解析，迁移为 legacy 主解法（未生成新解法）`);
                }
                if (!parsed.content.difficultyProfile) {
                    notes.push(`${id}: 没有六维难度证据，保持为空（不推测）`);
                }
                const out = serializeProblem(parsed);
                if (!dryRun) {
                    await fs.writeFile(file, out, 'utf8');
                }
                migrated += 1;
            }
            catch (e) {
                failed.push({ id, error: e?.message ?? String(e) });
            }
        }
    }
    let unresolved = [];
    if (!dryRun) {
        const rel = await normalizeRelations(bankRoot, backupDir);
        unresolved = rel.unresolved;
    }
    unresolvedCount = unresolved.length;
    const finishedAt = new Date().toISOString();
    const report = {
        dryRun,
        startedAt,
        finishedAt,
        backupId: stamp,
        backupDir: dryRun ? '' : backupDir,
        reportPath: dryRun ? '' : reportPath,
        scanned,
        migrated,
        skipped,
        failed,
        unresolvedRelations: unresolvedCount,
        unresolvedPath: dryRun
            ? ''
            : path.join(migrationRoot, 'unresolved-relations.json'),
        notes: [...new Set(notes)].slice(0, 200),
    };
    if (!dryRun) {
        await fs.mkdir(migrationRoot, { recursive: true });
        await fs.writeFile(reportPath, JSON.stringify(report, null, 2), 'utf8');
    }
    return report;
}
export async function rollbackMigration(bankRoot, backupId) {
    const backupDir = path.join(bankRoot, 'migration', backupId, 'backup');
    await fs.access(backupDir);
    let restored = 0;
    const walk = async (rel) => {
        const dir = path.join(backupDir, rel);
        for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
            const childRel = path.join(rel, entry.name);
            if (entry.isDirectory()) {
                if (childRel.split(path.sep)[0] === 'migration')
                    continue;
                await walk(childRel);
            }
            else if (entry.isFile()) {
                const target = path.join(bankRoot, childRel);
                await fs.mkdir(path.dirname(target), { recursive: true });
                await fs.copyFile(path.join(backupDir, childRel), target);
                restored += 1;
            }
        }
    };
    await walk('');
    return { restored };
}
