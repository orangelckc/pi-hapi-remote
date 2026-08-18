/**
 * Entry Log（深模块）：按插入序维护的条目日志，支持原地更新、
 * 整体重建与有序快照。服务端 Transcript Projector 与 PWA 连接归约
 * 共用，保证「条目集合 + 顺序」的唯一实现。
 *
 * 不感知条目内容：任何带稳定 id 的记录皆可存入。
 * 浏览器与 Node 双运行时可用（零依赖）。
 */
export class EntryLog<T extends { id: string }> {
  private items = new Map<string, T>();
  private order: string[] = [];

  /** 插入或原地更新；返回是否为新增条目。 */
  put(entry: T): boolean {
    const isNew = !this.items.has(entry.id);
    this.items.set(entry.id, entry);
    if (isNew) this.order.push(entry.id);
    return isNew;
  }

  get(id: string): T | undefined {
    return this.items.get(id);
  }

  has(id: string): boolean {
    return this.items.has(id);
  }

  clear(): void {
    this.items.clear();
    this.order = [];
  }

  /** 整体重建（快照恢复 / resync 场景）。 */
  replace(entries: T[]): void {
    this.clear();
    for (const entry of entries) this.put(entry);
  }

  /** 按插入序快照（条目对象引用稳定，便于上层 memo）。 */
  entries(): T[] {
    const result: T[] = [];
    for (const id of this.order) {
      const item = this.items.get(id);
      if (item !== undefined) result.push(item);
    }
    return result;
  }
}
