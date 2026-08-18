/**
 * Event Journal（深模块）：单调递增游标、有限容量事件环形缓冲、
 * 长轮询等待者与重同步判定。不感知 HTTP、PWA 或 Pi API。
 */
import { LIMITS, type EventBatch, type RemoteEvent } from "../../shared/protocol.js";

interface Waiter {
  cursor: number;
  resolve: (batch: EventBatch) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class EventJournal {
  private buffer: Array<{ seq: number; event: RemoteEvent }> = [];
  private nextSeq = 1;
  private waiters = new Set<Waiter>();
  private capacity: number;
  private waiterCountListener: ((count: number) => void) | undefined;

  constructor(capacity: number = LIMITS.eventBufferCapacity) {
    this.capacity = capacity;
  }

  /** 观察长轮询连接数量变化。 */
  setWaiterCountListener(listener: ((count: number) => void) | undefined): void {
    this.waiterCountListener = listener;
  }

  /** 新分享开始前清空旧游标与事件。 */
  reset(): void {
    this.wakeAll();
    this.buffer = [];
    this.nextSeq = 1;
    this.notifyWaiterCount();
  }

  /** 当前最新游标（已分配的最大 seq；无事件时为 0）。 */
  get cursor(): number {
    return this.nextSeq - 1;
  }

  /** 追加事件，唤醒所有等待者。返回分配的 seq。 */
  append(event: RemoteEvent): number {
    const seq = this.nextSeq++;
    this.buffer.push({ seq, event });
    if (this.buffer.length > this.capacity) {
      this.buffer.splice(0, this.buffer.length - this.capacity);
    }
    this.wakeAll();
    return seq;
  }

  /** 当前等待中的长轮询数量。 */
  get waiterCount(): number {
    return this.waiters.size;
  }

  /**
   * 长轮询：返回 seq > cursor 的事件；无事件时最多等待 waitMs。
   * 游标落后于缓冲区最早事件时返回 resyncRequired。
   * 游标超前（未来值）视为无效，同样要求重同步。
   */
  async poll(cursor: number, waitMs: number): Promise<EventBatch> {
    const immediate = this.collect(cursor);
    if (immediate) return immediate;

    if (cursor > this.cursor || cursor < this.oldestSeq() - 1) {
      return {
        events: [],
        cursor: this.cursor,
        resyncRequired: true,
      };
    }

    return await new Promise<EventBatch>((resolve) => {
      const waiter: Waiter = {
        cursor,
        resolve,
        timer: setTimeout(() => {
          this.waiters.delete(waiter);
          this.notifyWaiterCount();
          resolve({ events: [], cursor: this.cursor });
        }, waitMs),
      };
      this.waiters.add(waiter);
      this.notifyWaiterCount();
    });
  }

  /** 关闭 Journal：立即以空结果唤醒所有等待者（分享停止）。 */
  close(): void {
    this.wakeAll();
  }

  /** 使后续 poll 立即返回 resyncRequired（投影全量重建后调用）。 */
  invalidate(): void {
    // 丢弃旧事件并推进游标：任何持有旧游标的观察者都会判定需要重同步，
    // 避免将重建前的旧事件应用到重建后的新快照上。
    this.buffer = [];
    this.nextSeq += 1;
    this.wakeAll();
  }

  private wakeAll(): void {
    for (const waiter of this.waiters) {
      clearTimeout(waiter.timer);
      this.waiters.delete(waiter);
      const batch = this.collect(waiter.cursor);
      waiter.resolve(batch ?? { events: [], cursor: this.cursor });
    }
    this.notifyWaiterCount();
  }

  private notifyWaiterCount(): void {
    this.waiterCountListener?.(this.waiters.size);
  }

  /** 若有 seq > cursor 的事件则收集为批；否则返回 null。 */
  private collect(cursor: number): EventBatch | null {
    if (cursor < this.oldestSeq() - 1) {
      return { events: [], cursor: this.cursor, resyncRequired: true };
    }
    if (cursor > this.cursor) {
      return { events: [], cursor: this.cursor, resyncRequired: true };
    }
    const events = this.buffer
      .filter((item) => item.seq > cursor)
      .map((item) => item.event);
    if (events.length === 0) return null;
    return { events, cursor: this.cursor };
  }

  /** 缓冲区中最早的 seq；空缓冲时为 nextSeq（即没有任何可回放事件）。 */
  private oldestSeq(): number {
    return this.buffer.length > 0 ? this.buffer[0]!.seq : this.nextSeq;
  }
}
