/**
 * 后台任务：扫描、刮削、校验、重复检测都跑在这里。
 * 单进程、内存态、保留最近 30 条，前端轮询进度。
 */

const MAX_JOBS = 30;

export class Jobs {
  constructor() {
    /** @type {Map<string, any>} */
    this.jobs = new Map();
    this.seq = 0;
  }

  /**
   * 启动一个任务。
   * @param {string} name 任务显示名
   * @param {(ctx: {progress: Function, signal: AbortSignal, isCancelled: () => boolean}) => Promise<any>} fn
   * @returns {{id: string}}
   */
  start(name, fn) {
    this.seq += 1;
    const id = `job_${Date.now().toString(36)}_${this.seq.toString(36)}`;
    const controller = new AbortController();
    const job = {
      id,
      name,
      status: 'running',
      phase: '准备中',
      total: 0,
      done: 0,
      current: '',
      message: '',
      warnings: [],
      errors: [],
      result: null,
      startedAt: new Date().toISOString(),
      endedAt: null,
    };
    this.jobs.set(id, { ...job, controller });
    this.prune();

    const progress = (patch = {}) => {
      const target = this.jobs.get(id);
      if (!target) return;
      Object.assign(target, patch);
      if (patch.warning) {
        target.warnings.push(String(patch.warning));
        if (target.warnings.length > 200) target.warnings.shift();
      }
      if (patch.error) {
        target.errors.push(String(patch.error));
        if (target.errors.length > 200) target.errors.shift();
      }
    };

    const ctx = {
      progress,
      signal: controller.signal,
      isCancelled: () => controller.signal.aborted,
    };

    queueMicrotask(async () => {
      try {
        const result = await fn(ctx);
        const target = this.jobs.get(id);
        if (target) {
          target.status = controller.signal.aborted ? 'cancelled' : 'done';
          target.result = result ?? null;
          target.phase = '完成';
          target.endedAt = new Date().toISOString();
        }
      } catch (err) {
        const target = this.jobs.get(id);
        if (target) {
          target.status = controller.signal.aborted || err?.name === 'AbortError' ? 'cancelled' : 'error';
          target.message = err?.message ?? String(err);
          target.endedAt = new Date().toISOString();
        }
      } finally {
        this.jobs.get(id)?.controller?.abort?.();
        if (this.jobs.get(id)) this.jobs.get(id).controller = null;
      }
    });

    return { id };
  }

  prune() {
    const ids = [...this.jobs.keys()];
    while (ids.length > MAX_JOBS) {
      const victim = ids.shift();
      const job = this.jobs.get(victim);
      if (job?.status === 'running') continue;
      this.jobs.delete(victim);
    }
  }

  /** 对外快照（去掉 AbortController）。 */
  snapshot(job) {
    if (!job) return null;
    const { controller, ...rest } = job;
    return {
      ...rest,
      done: Math.min(Number(rest.done) || 0, Number(rest.total) || Number(rest.done) || 0),
      percent: rest.total > 0 ? Math.min(100, Math.round((rest.done / rest.total) * 100)) : rest.status === 'done' ? 100 : 0,
    };
  }

  get(id) {
    return this.snapshot(this.jobs.get(id));
  }

  list(limit = 10) {
    return [...this.jobs.values()].slice(-limit).reverse().map((job) => this.snapshot(job));
  }

  running() {
    return [...this.jobs.values()].filter((job) => job.status === 'running').map((job) => this.snapshot(job));
  }

  cancel(id) {
    const job = this.jobs.get(id);
    if (!job) return false;
    if (job.status !== 'running') return false;
    job.controller?.abort();
    job.phase = '正在取消…';
    return true;
  }

  cancelAll() {
    for (const job of this.jobs.values()) if (job.status === 'running') job.controller?.abort();
  }
}
