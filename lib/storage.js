/**
 * 工程加固：原子写、文件锁、ID 序列
 * - 单进程内：Promise 队列串行化关键段
 * - 跨进程：lock 目录 / lock 文件（O_EXCL 忙等）
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
const LOCK_TIMEOUT_MS = 15_000;
const LOCK_RETRY_MS = 25;
/** 进程内互斥（同 bankRoot 共享） */
const queues = new Map();
export function withQueue(key, fn) {
    const prev = queues.get(key) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    queues.set(key, next.then(() => undefined, () => undefined));
    return next;
}
async function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}
/**
 * 跨进程文件锁：创建 lockPath（wx），失败则重试直至超时
 */
export async function withFileLock(lockPath, fn, timeoutMs = LOCK_TIMEOUT_MS) {
    const start = Date.now();
    await fs.mkdir(path.dirname(lockPath), { recursive: true });
    while (true) {
        let handle = null;
        try {
            handle = await fs.open(lockPath, 'wx');
            await handle.writeFile(`${process.pid}\n${Date.now()}\n`, 'utf8');
            try {
                return await fn();
            }
            finally {
                await handle.close().catch(() => { });
                await fs.unlink(lockPath).catch(() => { });
            }
        }
        catch (e) {
            if (handle)
                await handle.close().catch(() => { });
            if (e && (e.code === 'EEXIST' || e.code === 'EACCES')) {
                if (Date.now() - start > timeoutMs) {
                    // 过期锁：尝试强制清理后重试一次逻辑由超时错误表达
                    try {
                        const st = await fs.stat(lockPath);
                        if (Date.now() - st.mtimeMs > timeoutMs) {
                            await fs.unlink(lockPath).catch(() => { });
                            continue;
                        }
                    }
                    catch {
                        // ignore
                    }
                    throw new Error(`获取文件锁超时: ${lockPath}`);
                }
                await sleep(LOCK_RETRY_MS);
                continue;
            }
            throw e;
        }
    }
}
/** 原子写：写 .tmp 再 rename */
export async function atomicWriteFile(filePath, content) {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    try {
        await fs.writeFile(tmp, content, 'utf8');
        await fs.rename(tmp, filePath);
    }
    catch (e) {
        await fs.unlink(tmp).catch(() => { });
        throw e;
    }
}
/**
 * 在 bankRoot 下用序列文件分配下一个题号
 * 文件：.problem-bank-id-seq 内容为整数
 * 全程文件锁 + 进程内队列
 */
export async function allocateNextId(bankRoot, idPrefix, scanFallback) {
    const seqPath = path.join(bankRoot, '.problem-bank-id-seq');
    const lockPath = path.join(bankRoot, '.problem-bank-id-seq.lock');
    return withQueue(`id:${bankRoot}`, () => withFileLock(lockPath, async () => {
        let current = 0;
        try {
            const raw = await fs.readFile(seqPath, 'utf8');
            current = parseInt(raw.trim(), 10) || 0;
        }
        catch {
            current = await scanFallback();
        }
        // 与磁盘扫描再取一次 max，防止序列落后于已有文件
        const scanned = await scanFallback();
        current = Math.max(current, scanned);
        const next = current + 1;
        await atomicWriteFile(seqPath, String(next));
        return `${idPrefix}-${String(next).padStart(4, '0')}`;
    }));
}
/** 带锁的原子写任意文件 */
export async function lockedAtomicWrite(filePath, content, bankRoot) {
    const lockPath = path.join(bankRoot, '.problem-bank-write.lock');
    await withQueue(`write:${bankRoot}`, () => withFileLock(lockPath, () => atomicWriteFile(filePath, content)));
}
