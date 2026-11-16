/**
 * 想看清单：本地还没有的片子也能先记下来，元数据从 TMDB 拉一次就落盘。
 *
 * 设计取舍：
 *   - 和主库（library.json）分开存：主库的每条记录都对应一个本地文件，
 *     这里的条目大多没有文件，混在一起会让扫描/校验/查重到处要判空。
 *   - id 优先用 tmdbId（`w_12345`），手动添加且没有 TMDB 的用标题哈希（`w_local_xxx`）。
 *   - 全量重写即可：清单通常几十到几百条，文件很小。
 */
import fs from 'node:fs/promises';
import path from 'node:path';

import { readJson, shortId, writeJsonAtomic } from './fsx.mjs';

const SCHEMA_VERSION = 1;

/** 状态：wish 想看 / watched 已看 / owned 已入库 */
export const WATCH_STATUS = new Set(['wish', 'watched', 'owned']);

function normalizeStatus(value) {
  return WATCH_STATUS.has(value) ? value : 'wish';
}

/** TMDB 详情 -> 清单条目里我们关心的字段。 */
export function pickMetadata(detail) {
  return {
    tmdbId: detail?.id ?? null,
    title: String(detail?.title ?? '').trim(),
    originalTitle: detail?.originalTitle ?? null,
    year: detail?.year ?? null,
    voteAverage: detail?.voteAverage ?? null,
    voteCount: detail?.voteCount ?? 0,
    genres: Array.isArray(detail?.genres) ? detail.genres.slice(0, 8) : [],
    overview: String(detail?.overview ?? ''),
    runtimeMin: detail?.runtimeMin ?? null,
    posterPath: detail?.posterPath ?? null,
    backdropPath: detail?.backdropPath ?? null,
    imdbId: detail?.imdbId ?? null,
    directors: Array.isArray(detail?.directors) ? detail.directors.slice(0, 3) : [],
    fetchedAt: new Date().toISOString(),
  };
}

export class Watchlist {
  /** @param {string} dataDir */
  constructor(dataDir) {
    this.file = path.join(dataDir, 'watchlist.json');
    /** @type {any[]} */
    this.items = [];
    this.dirty = false;
    this.saveTimer = null;
  }

  async load() {
    const data = await readJson(this.file, null);
    this.items = Array.isArray(data?.items) ? data.items.filter((item) => item?.id) : [];
    for (const item of this.items) {
      item.status = normalizeStatus(item.status);
    }
    return { count: this.items.length, version: Number(data?.version) || SCHEMA_VERSION };
  }

  list() {
    return [...this.items].sort((a, b) => String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? '')));
  }

  get(id) {
    return this.items.find((item) => item.id === id) ?? null;
  }

  findByTmdb(tmdbId) {
    if (!tmdbId) return null;
    return this.items.find((item) => Number(item.tmdbId) === Number(tmdbId)) ?? null;
  }

  /**
   * 新增条目。同 tmdbId（或同 id）已存在时返回既有条目，不重复添加。
   * @returns {{item: any, existed: boolean}}
   */
  add(entry) {
    const now = new Date().toISOString();
    const existing = entry.tmdbId ? this.findByTmdb(entry.tmdbId) : (entry.id ? this.get(entry.id) : null);
    if (existing) return { item: existing, existed: true };

    const tmdbId = entry.tmdbId ? Number(entry.tmdbId) : null;
    const title = String(entry.title ?? '').trim() || '未命名';
    const year = Number(entry.year) || null;
    const id = tmdbId ? `w_${tmdbId}` : `w_local_${shortId(`${title}|${year ?? ''}`, 12)}`;

    if (this.get(id)) return { item: this.get(id), existed: true };

    const item = {
      id,
      tmdbId,
      title,
      originalTitle: entry.originalTitle ?? null,
      year,
      voteAverage: entry.voteAverage ?? null,
      voteCount: entry.voteCount ?? 0,
      genres: Array.isArray(entry.genres) ? entry.genres : [],
      overview: String(entry.overview ?? ''),
      runtimeMin: entry.runtimeMin ?? null,
      posterPath: entry.posterPath ?? null,
      backdropPath: entry.backdropPath ?? null,
      imdbId: entry.imdbId ?? null,
      directors: Array.isArray(entry.directors) ? entry.directors : [],
      status: normalizeStatus(entry.status),
      note: String(entry.note ?? '').slice(0, 2000),
      createdAt: now,
      updatedAt: now,
      fetchedAt: entry.fetchedAt ?? null,
    };
    this.items.push(item);
    this.dirty = true;
    this.scheduleSave();
    return { item, existed: false };
  }

  patch(id, changes = {}) {
    const item = this.get(id);
    if (!item) return null;
    const next = { ...item };
    if (changes.status !== undefined) next.status = normalizeStatus(changes.status);
    if (typeof changes.note === 'string') next.note = changes.note.slice(0, 2000);
    if (typeof changes.title === 'string' && changes.title.trim()) next.title = changes.title.trim();
    if (changes.year !== undefined) next.year = Number(changes.year) || null;
    // 刷新元数据时整体覆盖
    if (changes.metadata && typeof changes.metadata === 'object') {
      Object.assign(next, changes.metadata);
      next.id = changes.metadata.tmdbId ? `w_${changes.metadata.tmdbId}` : next.id;
    }
    next.updatedAt = new Date().toISOString();
    const index = this.items.indexOf(item);
    this.items[index] = next;
    this.dirty = true;
    this.scheduleSave();
    return next;
  }

  remove(id) {
    const index = this.items.findIndex((item) => item.id === id);
    if (index < 0) return false;
    this.items.splice(index, 1);
    this.dirty = true;
    this.scheduleSave();
    return true;
  }

  scheduleSave() {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.flush().catch((err) => console.error('[watchlist] 保存失败:', err.message));
    }, 300);
    this.saveTimer.unref?.();
  }

  async flush() {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    this.dirty = false;
    await writeJsonAtomic(this.file, {
      version: SCHEMA_VERSION,
      savedAt: new Date().toISOString(),
      count: this.items.length,
      items: this.items,
    });
  }
}
