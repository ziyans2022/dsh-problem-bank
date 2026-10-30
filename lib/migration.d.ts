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
export interface MigrationReport {
    dryRun: boolean;
    startedAt: string;
    finishedAt: string;
    backupId: string;
    backupDir: string;
    reportPath: string;
    scanned: number;
    migrated: number;
    skipped: number;
    failed: {
        id: string;
        error: string;
    }[];
    unresolvedRelations: number;
    unresolvedPath: string;
    notes: string[];
}
export declare function migrateBank(bankRoot: string, options?: {
    dryRun?: boolean;
    now?: Date;
}): Promise<MigrationReport>;
export declare function rollbackMigration(bankRoot: string, backupId: string): Promise<{
    restored: number;
}>;
