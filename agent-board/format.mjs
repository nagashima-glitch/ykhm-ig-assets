// CLI と MCP サーバーの両方が使う、テキスト整形。
// AI が読んで迷わない形（id が必ず行頭に出る）を優先する。

import { COLUMNS, columnTitle, filterTasks } from './store.mjs';

const OWNER_LABEL = {
  'claude-code': 'claude-code',
  codex: 'codex',
  you: 'あなた',
  both: '両方',
  other: 'その他',
};

export function short(task) {
  const bits = [`[${task.id}]`, task.title];
  const meta = [];
  meta.push(OWNER_LABEL[task.owner] ?? task.owner);
  if (task.project) meta.push(`proj:${task.project}`);
  if (task.tags.length) meta.push(task.tags.map((t) => `#${t}`).join(' '));
  if (task.progress !== null && task.progress !== undefined) meta.push(`${task.progress}%`);
  if (task.due) meta.push(`期限 ${task.due}`);
  return `${bits.join(' ')}  (${meta.join(' / ')})`;
}

export function detail(task) {
  const lines = [
    `${task.title}`,
    `id: ${task.id}`,
    `状態: ${columnTitle(task.status)} (${task.status})`,
    `担当: ${OWNER_LABEL[task.owner] ?? task.owner}`,
  ];
  if (task.project) lines.push(`プロジェクト: ${task.project}`);
  if (task.tags.length) lines.push(`タグ: ${task.tags.join(', ')}`);
  if (task.progress !== null && task.progress !== undefined) lines.push(`進捗: ${task.progress}%`);
  if (task.due) lines.push(`期限: ${task.due}`);
  lines.push(`更新: ${task.updatedAt}`);
  if (task.body) lines.push('', task.body);
  if (task.notes.length) {
    lines.push('', '--- 付箋 ---');
    for (const n of task.notes) lines.push(`(${n.at} / ${OWNER_LABEL[n.by] ?? n.by}) ${n.text}`);
  }
  return lines.join('\n');
}

export function board(db, filter = {}) {
  const tasks = filterTasks(db, filter);
  const out = [];
  for (const col of COLUMNS) {
    const items = tasks.filter((t) => t.status === col.id);
    out.push(`## ${col.title} (${items.length})`);
    if (!items.length) out.push('  なし');
    for (const t of items) out.push(`  ${short(t)}`);
    out.push('');
  }
  return out.join('\n').trimEnd();
}

// 新しいセッションが最初に読む「今どうなっているか」。
// このツールで一番価値があるのはこの 1 コマンド。
export function handoff(db) {
  const out = ['# 引き継ぎ（agent-board）', `生成: ${new Date().toISOString()}`, ''];
  const pick = (status) => filterTasks(db, { status });

  const decisions = pick('needs_you');
  out.push(`## あなたの判断待ち (${decisions.length}) ← まずここ`);
  if (!decisions.length) out.push('  なし');
  for (const t of decisions) {
    out.push(`  ${short(t)}`);
    if (t.body) out.push(`    ${t.body.split('\n')[0]}`);
    const last = t.notes.at(-1);
    if (last) out.push(`    最後の付箋: (${last.by}) ${last.text}`);
  }
  out.push('');

  for (const status of ['doing', 'agent']) {
    const items = pick(status);
    out.push(`## ${columnTitle(status)} (${items.length})`);
    if (!items.length) out.push('  なし');
    for (const t of items) {
      out.push(`  ${short(t)}`);
      const last = t.notes.at(-1);
      if (last) out.push(`    最後の付箋: (${last.by}) ${last.text}`);
    }
    out.push('');
  }

  const held = pick('hold');
  out.push(`## 保留 (${held.length})`);
  for (const t of held) out.push(`  ${short(t)}`);
  if (!held.length) out.push('  なし');
  out.push('');

  const done = pick('done').slice(0, 5);
  out.push(`## 直近で完了 (${done.length})`);
  for (const t of done) out.push(`  ${short(t)}`);
  if (!done.length) out.push('  なし');

  return out.join('\n');
}
