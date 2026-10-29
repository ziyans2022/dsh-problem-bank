/**
 * 工程加固：原子写、文件锁、ID 序列
 * - 单进程内：Promise 队列串行化关键段
 * - 跨进程：lock 目录 / lock 文件（O_EXCL 忙等）
 */
export declare function withQueue<T>(key: string, fn: () => Promise<T>): Promise<T>;
/**
 * 跨进程文件锁：创建 lockPath（wx），失败则重试直至超时
 */
export declare function withFileLock<T>(lockPath: string, fn: () => Promise<T>, timeoutMs?: number): Promise<T>;
/** 原子写：写 .tmp 再 rename */
export declare function atomicWriteFile(filePath: string, content: string | Uint8Array): Promise<void>;
/**
 * 在 bankRoot 下用序列文件分配下一个题号
 * 文件：.problem-bank-id-seq 内容为整数
 * 全程文件锁 + 进程内队列
 */
export declare function allocateNextId(bankRoot: string, idPrefix: string, scanFallback: () => Promise<number>): Promise<string>;
/** 带锁的原子写任意文件 */
export declare function lockedAtomicWrite(filePath: string, content: string, bankRoot: string): Promise<void>;
