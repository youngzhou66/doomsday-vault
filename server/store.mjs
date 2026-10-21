/**
 * 电影库存储：单个 JSON 文件 + 内存索引，写入去抖 + 原子落盘。
 * 1 万条记录量级下读写都在毫秒级，无需数据库。
 */
import path from 'node:path';
import { mediaId, pathKey, readJson, writeJsonAtomic } from './fsx.mjs';

const SCHEMA_VERSION = 1;
const SAVE_DEBOUNCE_MS = 300;

export class Library {
  /** @param {string} dataDir */
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.file = path.join(dataDir, 'library.json');
    /** @type {Map<string, any>} */
    this.movies = new Map();
    /** @type {Map<string, string>} pathKey -> id */
    this.byPath = new Map();
    this.saveTimer = null;
    this.saving = null;
    this.dirty = false;
  }

  async load() {
    const data = await readJson(this.file, null);
    this.movies.clear();
    this.byPath.clear();
    if (data && Array.isArray(data.movies)) {
      for (const movie of data.movies) {
        if (!movie?.id || !movie?.path) continue;
        // 旧版本曾把机器名写进探测结果，属于隐私残留：加载时顺手清掉
        if (movie.probe && 'host' in movie.probe) {
          delete movie.probe.host;
          this.dirty = true;
        }
        this.movies.set(movie.id, movie);
        this.byPath.set(pathKey(movie.path), movie.id);
      }
    }
    const fileVersion = Number(data?.version) || 0;
    // 清理过隐私字段就立即落盘，避免机器名一直留在 library.json 里
    if (this.dirty) await this.flush();
    return { count: this.movies.size, version: fileVersion || SCHEMA_VERSION, migrated: fileVersion < SCHEMA_VERSION };
  }

  get(id) {
    return this.movies.get(id) ?? null;
  }

  byAbsolutePath(absPath) {
    const id = this.byPath.get(pathKey(absPath));
    return id ? this.movies.get(id) : null;
  }

  list() {
    return [...this.movies.values()];
  }

  get size() {
    return this.movies.size;
  }

  /** 新增或整体替换。 */
  upsert(movie) {
    const now = new Date().toISOString();
    const previous = this.movies.get(movie.id);
    if (previous && previous.path !== movie.path) this.byPath.delete(pathKey(previous.path));
    const next = {
      ...movie,
      addedAt: previous?.addedAt ?? movie.addedAt ?? now,
      updatedAt: now,
      lastSeenAt: movie.lastSeenAt ?? previous?.lastSeenAt ?? now,
    };
    this.movies.set(next.id, next);
    this.byPath.set(pathKey(next.path), next.id);
    this.dirty = true;
    this.scheduleSave();
    return next;
  }

  /** 局部更新，返回更新后的记录。 */
  patch(id, changes) {
    const current = this.movies.get(id);
    if (!current) return null;
    return this.upsert({ ...current, ...changes });
  }

  /** 只从库里移除记录，绝不删除磁盘文件。 */
  remove(id) {
    const current = this.movies.get(id);
    if (!current) return false;
    this.movies.delete(id);
    this.byPath.delete(pathKey(current.path));
    this.dirty = true;
    this.scheduleSave();
    return true;
  }

  /**
   * 批量迁移路径前缀（换盘符 / 移动硬盘挂载点变化时用）。
   *
   * 只改路径派生字段（path/dir/relPath/folderPath）与 id，
   * 标签、合集、备注、已看、播放记录、封面等全部原样保留。
   *
   * @param {string} oldPrefix 旧根目录（绝对路径）
   * @param {string} newPrefix 新根目录（绝对路径）
   * @returns {{changed: number, skipped: Array<{id: string, path: string, reason: string}>}}
   */
  rebasePath(oldPrefix, newPrefix) {
    const oldKey = pathKey(oldPrefix);
    const newBase = path.resolve(newPrefix);
    const skipped = [];
    const updates = [];

    for (const movie of this.movies.values()) {
      const key = pathKey(movie.path);
      const inside = key === oldKey || key.startsWith(`${oldKey}${path.sep}`);
      if (!inside) continue;

      const suffix = movie.path.slice(path.resolve(oldPrefix).length);
      const nextPath = `${newBase}${suffix}`;
      const nextId = mediaId(nextPath);
      if (nextId !== movie.id && this.movies.has(nextId)) {
        skipped.push({ id: movie.id, path: movie.path, reason: '目标路径已存在同一条记录' });
        continue;
      }
      const nextDir = path.dirname(nextPath);
      updates.push({
        oldId: movie.id,
        record: {
          ...movie,
          id: nextId,
          path: nextPath,
          dir: nextDir,
          relPath: path.relative(newBase, nextPath) || movie.fileName,
          // folderPath 就是「一片一目录」时的那个目录，与 dir 一致
          folderPath: movie.folderPath ? nextDir : movie.folderPath,
          rebasedAt: new Date().toISOString(),
        },
      });
    }

    for (const { oldId, record } of updates) {
      const previous = this.movies.get(oldId);
      if (previous) this.byPath.delete(pathKey(previous.path));
      this.movies.delete(oldId);
      this.movies.set(record.id, record);
      this.byPath.set(pathKey(record.path), record.id);
    }
    if (updates.length) {
      this.dirty = true;
      this.scheduleSave();
    }
    return { changed: updates.length, skipped };
  }

  scheduleSave() {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.flush().catch((err) => console.error('[library] 保存失败:', err.message));
    }, SAVE_DEBOUNCE_MS);
    this.saveTimer.unref?.();
  }

  /** 立即落盘。 */
  async flush() {
    if (this.saving) return this.saving;
    if (!this.dirty) return null;
    this.dirty = false;
    const payload = {
      version: SCHEMA_VERSION,
      savedAt: new Date().toISOString(),
      count: this.movies.size,
      movies: this.list(),
    };
    this.saving = writeJsonAtomic(this.file, payload)
      .catch((err) => {
        this.dirty = true;
        throw err;
      })
      .finally(() => {
        this.saving = null;
      });
    return this.saving;
  }

  /** 统计信息，供前端侧栏与健康检查使用。 */
  stats() {
    let missing = 0;
    let pending = 0;
    let confirmed = 0;
    let unmatched = 0;
    let totalBytes = 0;
    let episodes = 0;
    let watched = 0;
    const tags = new Map();
    const collections = new Map();
    for (const movie of this.movies.values()) {
      if (movie.missing) missing += 1;
      if (movie.kind === 'episode') episodes += 1;
      if (movie.watchedAt) watched += 1;
      totalBytes += Number(movie.size) || 0;
      if (movie.matchState === 'pending') pending += 1;
      else if (movie.matchState === 'confirmed' || movie.matchState === 'auto') confirmed += 1;
      else unmatched += 1;
      for (const tag of movie.tags ?? []) tags.set(tag, (tags.get(tag) ?? 0) + 1);
      for (const name of movie.collections ?? []) collections.set(name, (collections.get(name) ?? 0) + 1);
    }
    return {
      total: this.movies.size,
      missing,
      pending,
      confirmed,
      unmatched,
      episodes,
      totalBytes,
      watched,
      unwatched: this.movies.size - watched,
      tags: [...tags.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)),
      collections: [...collections.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)),
    };
  }
}
