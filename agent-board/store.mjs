// agent-board: Claude Code と Codex が共有する 1 つのタスク状態。
// データは tasks.json 1 ファイル。git に乗せれば端末間もそのまま同期できる。

import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync, rmdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

export const DATA_PATH = process.env.AGENT_BOARD_FILE
  ? resolve(process.env.AGENT_BOARD_FILE)
  : join(HERE, 'tasks.json');

export const COLUMNS = [
  { id: 'doing',     title: '進行中',           hint: '今、進めているタスク' },
  { id: 'needs_you', title: 'あなたの判断待ち', hint: 'あなたの判断・選択が必要' },
  { id: 'agent',     title: 'エージェント待ち', hint: 'エージェントの作業完了を待っています' },
  { id: 'hold',      title: '保留',             hint: '一時的に保留しているタスク' },
  { id: 'done',      title: '完了',             hint: '完了したタスク' },
];

export const STATUSES = COLUMNS.map((c) => c.id);
export const OWNERS = ['claude-code', 'codex', 'you', 'both', 'other'];

// AI がどう書いてきても受け取れるように、よくある言い換えを吸収する。
const STATUS_ALIASES = {
  wip: 'doing', in_progress: 'doing', 'in-progress': 'doing', progress: 'doing', 進行中: 'doing',
  review: 'needs_you', decision: 'needs_you', ask: 'needs_you', blocked_on_you: 'needs_you', 判断待ち: 'needs_you',
  waiting: 'agent', agent_waiting: 'agent', delegated: 'agent', エージェント待ち: 'agent',
  hold_on: 'hold', paused: 'hold', blocked: 'hold', backlog: 'hold', todo: 'hold', 保留: 'hold',
  complete: 'done', completed: 'done', finished: 'done', closed: 'done', 完了: 'done',
};

const OWNER_ALIASES = {
  claude: 'claude-code', 'claude code': 'claude-code', claudecode: 'claude-code', anthropic: 'claude-code',
  openai: 'codex', 'codex-cli': 'codex', gpt: 'codex',
  me: 'you', user: 'you', human: 'you', 自分: 'you', あなた: 'you',
  both: 'both', 両方: 'both',
};

export function normalizeStatus(value, fallback = 'hold') {
  if (!value) return fallback;
  const key = String(value).trim().toLowerCase();
  if (STATUSES.includes(key)) return key;
  if (STATUS_ALIASES[key]) return STATUS_ALIASES[key];
  throw new Error(`unknown status: ${value} (使えるのは ${STATUSES.join(', ')})`);
}

export function normalizeOwner(value, fallback = 'you') {
  if (!value) return fallback;
  const key = String(value).trim().toLowerCase();
  if (OWNERS.includes(key)) return key;
  if (OWNER_ALIASES[key]) return OWNER_ALIASES[key];
  return 'other';
}

export function now() {
  return new Date().toISOString();
}

function emptyDb() {
  return { version: 1, updatedAt: now(), tasks: [] };
}

export function load() {
  if (!existsSync(DATA_PATH)) return emptyDb();
  const raw = readFileSync(DATA_PATH, 'utf8').trim();
  if (!raw) return emptyDb();
  const db = JSON.parse(raw);
  if (!Array.isArray(db.tasks)) db.tasks = [];
  return db;
}

// 一時ファイル + rename で書く。Claude と Codex が同時に触っても
// 半端に壊れた JSON は残らない。
export function save(db) {
  db.updatedAt = now();
  const tmp = `${DATA_PATH}.tmp-${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(db, null, 2)}\n`, 'utf8');
  renameSync(tmp, DATA_PATH);
  return db;
}

// --- 排他ロック -----------------------------------------------------------
// Claude と Codex が同じ瞬間に書くと、読み込み→書き込みの間に相手の変更が
// 挟まって消える。mkdir は同一ファイルシステム上で原子的なので、それを鍵に使う。

const LOCK_PATH = `${DATA_PATH}.lock`;
const LOCK_STALE_MS = 10_000;

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function acquireLock() {
  const deadline = Date.now() + 5_000;
  for (;;) {
    try {
      mkdirSync(LOCK_PATH);
      return;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      // 異常終了で残った鍵は一定時間で無効にする。
      try {
        if (Date.now() - statSync(LOCK_PATH).mtimeMs > LOCK_STALE_MS) {
          rmdirSync(LOCK_PATH);
          continue;
        }
      } catch { /* 相手が先に解放した */ }
      if (Date.now() > deadline) throw new Error('tasks.json のロックを取得できませんでした');
      sleepSync(20 + Math.floor(Math.random() * 30));
    }
  }
}

function releaseLock() {
  try { rmdirSync(LOCK_PATH); } catch { /* すでに解放済み */ }
}

// 読み込み→変更→保存をロックの中でまとめて行う。書き込みは必ずこれを通す。
export function mutate(fn) {
  acquireLock();
  try {
    const db = load();
    const out = fn(db);
    save(db);
    return out;
  } finally {
    releaseLock();
  }
}

function newId(db) {
  for (;;) {
    const id = `t_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
    if (!db.tasks.some((t) => t.id === id)) return id;
  }
}

// 先頭一致でも引けるようにする（AI が id を端折って渡してきても通る）。
export function findTask(db, idOrPrefix) {
  if (!idOrPrefix) throw new Error('id が指定されていません');
  const needle = String(idOrPrefix).trim();
  const exact = db.tasks.find((t) => t.id === needle);
  if (exact) return exact;
  const hits = db.tasks.filter((t) => t.id.startsWith(needle));
  if (hits.length === 1) return hits[0];
  if (hits.length > 1) throw new Error(`id "${needle}" が複数のタスクに一致します`);
  const byTitle = db.tasks.filter((t) => t.title.includes(needle));
  if (byTitle.length === 1) return byTitle[0];
  throw new Error(`タスクが見つかりません: ${needle}`);
}

export function addTask(db, input) {
  const task = {
    id: newId(db),
    title: String(input.title || '').trim(),
    body: input.body ? String(input.body) : '',
    status: normalizeStatus(input.status, 'doing'),
    owner: normalizeOwner(input.owner, 'you'),
    project: input.project ? String(input.project) : '',
    tags: Array.isArray(input.tags) ? input.tags.map(String) : [],
    progress: clampProgress(input.progress),
    due: input.due ? String(input.due) : '',
    notes: [],
    createdAt: now(),
    updatedAt: now(),
  };
  if (!task.title) throw new Error('title は必須です');
  db.tasks.push(task);
  return task;
}

function clampProgress(value) {
  if (value === undefined || value === null || value === '') return null;
  const n = Number(value);
  if (Number.isNaN(n)) return null;
  return Math.max(0, Math.min(100, Math.round(n)));
}

export function updateTask(db, idOrPrefix, patch) {
  const task = findTask(db, idOrPrefix);
  if (patch.title !== undefined) task.title = String(patch.title);
  if (patch.body !== undefined) task.body = String(patch.body);
  if (patch.status !== undefined) task.status = normalizeStatus(patch.status, task.status);
  if (patch.owner !== undefined) task.owner = normalizeOwner(patch.owner, task.owner);
  if (patch.project !== undefined) task.project = String(patch.project);
  if (patch.due !== undefined) task.due = String(patch.due);
  if (patch.progress !== undefined) task.progress = clampProgress(patch.progress);
  if (patch.tags !== undefined) task.tags = (patch.tags || []).map(String);
  if (patch.addTags) task.tags = [...new Set([...task.tags, ...patch.addTags.map(String)])];
  if (patch.removeTags) task.tags = task.tags.filter((t) => !patch.removeTags.includes(t));
  if (task.status === 'done' && task.progress !== null) task.progress = 100;
  task.updatedAt = now();
  return task;
}

// 付箋（引き継ぎメモ）。このツールの本体はここ。
export function addNote(db, idOrPrefix, text, by = 'you') {
  const task = findTask(db, idOrPrefix);
  const note = { at: now(), by: normalizeOwner(by, 'you'), text: String(text).trim() };
  if (!note.text) throw new Error('メモが空です');
  task.notes.push(note);
  task.updatedAt = now();
  return { task, note };
}

export function removeTask(db, idOrPrefix) {
  const task = findTask(db, idOrPrefix);
  db.tasks = db.tasks.filter((t) => t.id !== task.id);
  return task;
}

export function filterTasks(db, filter = {}) {
  let tasks = [...db.tasks];
  if (filter.status) {
    const wanted = [].concat(filter.status).map((s) => normalizeStatus(s));
    tasks = tasks.filter((t) => wanted.includes(t.status));
  }
  if (filter.owner) {
    const wanted = [].concat(filter.owner).map((o) => normalizeOwner(o));
    tasks = tasks.filter((t) => wanted.includes(t.owner) || t.owner === 'both');
  }
  if (filter.project) tasks = tasks.filter((t) => t.project === filter.project);
  if (filter.tag) tasks = tasks.filter((t) => t.tags.includes(filter.tag));
  if (filter.query) {
    const q = String(filter.query).toLowerCase();
    tasks = tasks.filter((t) =>
      [t.title, t.body, t.project, t.tags.join(' '), t.notes.map((n) => n.text).join(' ')]
        .join(' ').toLowerCase().includes(q));
  }
  const order = new Map(STATUSES.map((s, i) => [s, i]));
  tasks.sort((a, b) =>
    (order.get(a.status) - order.get(b.status)) || (b.updatedAt < a.updatedAt ? -1 : 1));
  return tasks;
}

export function columnTitle(status) {
  return COLUMNS.find((c) => c.id === status)?.title ?? status;
}
