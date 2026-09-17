#!/usr/bin/env node
// agent-board CLI。MCP を設定していない AI でも `node board.mjs ...` で同じ状態を触れる。
//   node board.mjs board
//   node board.mjs handoff
//   node board.mjs add "タイトル" --status needs_you --owner codex
//   node board.mjs set t_abc --status done
//   node board.mjs note t_abc "検証まで終わった。あとは提出だけ"
//   node board.mjs serve

import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  DATA_PATH, COLUMNS, OWNERS, load, mutate, addTask, updateTask, addNote,
  removeTask, findTask, filterTasks,
} from './store.mjs';
import * as fmt from './format.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const [name, inline] = arg.slice(2).split('=');
      const value = inline !== undefined ? inline
        : (argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true);
      if (flags[name] === undefined) flags[name] = value;
      else flags[name] = [].concat(flags[name], value);
    } else {
      positional.push(arg);
    }
  }
  return { positional, flags };
}

const USAGE = `agent-board — Claude Code と Codex が共有するタスクボード

  board [--owner X] [--project P] [--tag T]   カンバンを表示
  handoff                                     引き継ぎサマリ（新しいセッションの最初に）
  list [--status S] [--owner X] [--query Q]   一覧
  show <id>                                   1件の詳細（付箋つき）
  add "<title>" [--status S] [--owner X] [--project P] [--tag T] [--body B] [--due D] [--progress N]
  set <id> [--status S] [--owner X] [--progress N] [--title T] [--body B] [--due D] [--add-tag T] [--rm-tag T]
  note <id> "<text>" [--by claude-code|codex|you]
  rm <id>
  serve [--port 4173]                         ブラウザのボードを開く

  状態: ${COLUMNS.map((c) => `${c.id}(${c.title})`).join(' ')}
  担当: ${OWNERS.join(' ')}
  データ: ${DATA_PATH}`;

function toTags(flags) {
  const raw = flags.tag ?? flags.tags;
  if (raw === undefined || raw === true) return undefined;
  return [].concat(raw).flatMap((t) => String(t).split(',')).map((t) => t.trim()).filter(Boolean);
}

function run(argv) {
  const { positional, flags } = parseArgs(argv);
  const cmd = positional[0] ?? 'board';

  if (cmd === 'help' || flags.help) return USAGE;

  if (cmd === 'serve') return serve(Number(flags.port) || 4173);

  const db = load();

  switch (cmd) {
    case 'board':
      return fmt.board(db, { owner: flags.owner, project: flags.project, tag: flags.tag });

    case 'handoff':
      return fmt.handoff(db);

    case 'list': {
      const tasks = filterTasks(db, {
        status: flags.status, owner: flags.owner, project: flags.project,
        tag: flags.tag, query: flags.query,
      });
      if (flags.json) return JSON.stringify(tasks, null, 2);
      return tasks.length ? tasks.map(fmt.short).join('\n') : '該当なし';
    }

    case 'show':
      return fmt.detail(findTask(db, positional[1]));

    case 'add': {
      const task = mutate((d) => addTask(d, {
        title: positional.slice(1).join(' '),
        body: flags.body === true ? '' : flags.body,
        status: flags.status === true ? undefined : flags.status,
        owner: flags.owner === true ? undefined : flags.owner,
        project: flags.project === true ? '' : flags.project,
        tags: toTags(flags),
        due: flags.due === true ? '' : flags.due,
        progress: flags.progress,
      }));
      return `追加しました\n${fmt.detail(task)}`;
    }

    case 'set': {
      const patch = {};
      for (const key of ['title', 'body', 'status', 'owner', 'project', 'due', 'progress']) {
        if (flags[key] !== undefined && flags[key] !== true) patch[key] = flags[key];
      }
      if (flags['add-tag']) patch.addTags = [].concat(flags['add-tag']).map(String);
      if (flags['rm-tag']) patch.removeTags = [].concat(flags['rm-tag']).map(String);
      const task = mutate((d) => updateTask(d, positional[1], patch));
      return `更新しました\n${fmt.detail(task)}`;
    }

    case 'note': {
      const { task } = mutate((d) => addNote(d, positional[1], positional.slice(2).join(' '), flags.by));
      return `付箋を貼りました\n${fmt.detail(task)}`;
    }

    case 'rm': {
      const task = mutate((d) => removeTask(d, positional[1]));
      return `削除しました: [${task.id}] ${task.title}`;
    }

    default:
      throw new Error(`未知のコマンド: ${cmd}\n\n${USAGE}`);
  }
}

// --- ブラウザ用の小さなサーバー（localhost のみ） -------------------------

const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8' };

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 1e6) reject(new Error('body too large'));
    });
    req.on('end', () => {
      try { resolve(raw ? JSON.parse(raw) : {}); } catch (err) { reject(err); }
    });
    req.on('error', reject);
  });
}

function serve(port) {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const json = (status, payload) => {
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(payload));
    };

    try {
      if (url.pathname === '/api/state' && req.method === 'GET') {
        return json(200, { columns: COLUMNS, owners: OWNERS, file: DATA_PATH, ...load() });
      }

      if (url.pathname === '/api/tasks' && req.method === 'POST') {
        const body = await readBody(req);
        return json(200, mutate((d) => addTask(d, body)));
      }

      const taskMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)(\/notes)?$/);
      if (taskMatch) {
        const [, id, isNotes] = taskMatch;
        if (isNotes && req.method === 'POST') {
          const body = await readBody(req);
          return json(200, mutate((d) => addNote(d, id, body.text, body.by).task));
        }
        if (req.method === 'PATCH') {
          const patch = await readBody(req);
          return json(200, mutate((d) => updateTask(d, id, patch)));
        }
        if (req.method === 'DELETE') {
          return json(200, mutate((d) => removeTask(d, id)));
        }
      }

      const file = url.pathname === '/' ? 'board.html' : url.pathname.slice(1);
      const target = join(HERE, file);
      if (target.startsWith(HERE) && existsSync(target) && !file.endsWith('.mjs')) {
        res.writeHead(200, { 'content-type': MIME[extname(target)] ?? 'application/octet-stream' });
        return res.end(readFileSync(target));
      }

      return json(404, { error: 'not found' });
    } catch (err) {
      return json(400, { error: err.message });
    }
  });

  server.listen(port, '127.0.0.1', () => {
    console.log(`agent-board: http://127.0.0.1:${port}  (データ: ${DATA_PATH})`);
    console.log('止めるときは Ctrl+C');
  });
  return null;
}

// --- entry ---------------------------------------------------------------

try {
  const output = run(process.argv.slice(2));
  if (output !== null && output !== undefined) console.log(output);
} catch (err) {
  console.error(`エラー: ${err.message}`);
  process.exit(1);
}
