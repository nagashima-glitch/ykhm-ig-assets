#!/usr/bin/env node
// agent-board の MCP サーバー（stdio / JSON-RPC 2.0、依存パッケージなし）。
// Claude Code と Codex CLI の両方から同じ tasks.json を読み書きするための口。
//
// 環境変数:
//   AGENT_BOARD_AGENT  このクライアントの名前（claude-code / codex）。付箋の署名に使う。
//   AGENT_BOARD_FILE   tasks.json の場所を差し替えたいとき。

import { createInterface } from 'node:readline';

import {
  load, mutate, addTask, updateTask, addNote, removeTask, findTask, filterTasks,
  STATUSES, OWNERS, DATA_PATH, normalizeOwner,
} from './store.mjs';
import * as fmt from './format.mjs';

const SELF = normalizeOwner(process.env.AGENT_BOARD_AGENT, 'other');
const PROTOCOL_VERSION = '2025-06-18';
const SUPPORTED_PROTOCOLS = new Set([PROTOCOL_VERSION, '2025-03-26', '2024-11-05']);

const statusEnum = { type: 'string', enum: STATUSES, description: 'doing=進行中 / needs_you=あなたの判断待ち / agent=エージェント待ち / hold=保留 / done=完了' };
const ownerEnum = { type: 'string', enum: OWNERS, description: '担当（claude-code / codex / you / both / other）' };

const TOOLS = [
  {
    name: 'board_handoff',
    description: '今の状況の引き継ぎサマリを返す。別のAI(Claude/Codex)のセッションから作業を引き継ぐとき、会話の最初に必ずこれを呼ぶ。Get a handoff briefing of all in-flight work.',
    inputSchema: { type: 'object', properties: {} },
    handler: () => fmt.handoff(load()),
  },
  {
    name: 'board_list',
    description: 'タスクを絞り込んで一覧する。List tasks with optional filters.',
    inputSchema: {
      type: 'object',
      properties: {
        status: statusEnum,
        owner: ownerEnum,
        project: { type: 'string' },
        tag: { type: 'string' },
        query: { type: 'string', description: 'タイトル・本文・付箋を全文検索' },
      },
    },
    handler: (args) => {
      const tasks = filterTasks(load(), args);
      return tasks.length ? tasks.map(fmt.short).join('\n') : '該当するタスクはありません';
    },
  },
  {
    name: 'board_get',
    description: 'タスク1件の詳細と全ての付箋（これまでの経緯）を読む。Read one task with its full note history.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'タスクid（先頭一致でも可）' } },
      required: ['id'],
    },
    handler: (args) => fmt.detail(findTask(load(), args.id)),
  },
  {
    name: 'board_add',
    description: 'タスクを追加する。ユーザーの判断が要る場合は status=needs_you にする。Add a task.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        body: { type: 'string', description: '背景・やること・判断してほしい内容' },
        status: statusEnum,
        owner: ownerEnum,
        project: { type: 'string' },
        tags: { type: 'array', items: { type: 'string' } },
        due: { type: 'string', description: '例: 2026-09-18 14:00' },
        progress: { type: 'number', description: '0-100' },
      },
      required: ['title'],
    },
    handler: (args) => {
      const task = mutate((db) => addTask(db, { owner: SELF, ...args }));
      return `追加しました\n${fmt.detail(task)}`;
    },
  },
  {
    name: 'board_update',
    description: 'タスクの状態・担当・進捗などを更新する。作業を始めたら doing、終わったら done に必ず変える。Update a task.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        title: { type: 'string' },
        body: { type: 'string' },
        status: statusEnum,
        owner: ownerEnum,
        project: { type: 'string' },
        tags: { type: 'array', items: { type: 'string' } },
        due: { type: 'string' },
        progress: { type: 'number' },
      },
      required: ['id'],
    },
    handler: (args) => {
      const { id, ...patch } = args;
      const task = mutate((db) => updateTask(db, id, patch));
      return `更新しました\n${fmt.detail(task)}`;
    },
  },
  {
    name: 'board_note',
    description: 'タスクに付箋（引き継ぎメモ）を貼る。分かったこと・詰まったこと・次の一手を、次に来るAIが読める形で残す。Append a handoff note.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        text: { type: 'string', description: '次に作業するAIが読んで続きをやれる内容' },
        by: ownerEnum,
      },
      required: ['id', 'text'],
    },
    handler: (args) => {
      const { task } = mutate((db) => addNote(db, args.id, args.text, args.by ?? SELF));
      return `付箋を貼りました\n${fmt.detail(task)}`;
    },
  },
  {
    name: 'board_remove',
    description: 'タスクを削除する。完了は done への更新で表すので、削除は本当に不要なものだけ。Delete a task.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
    },
    handler: (args) => {
      const task = mutate((db) => removeTask(db, args.id));
      return `削除しました: [${task.id}] ${task.title}`;
    },
  },
];

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function result(id, payload) {
  send({ jsonrpc: '2.0', id, result: payload });
}

function failure(id, code, message) {
  send({ jsonrpc: '2.0', id, error: { code, message } });
}

function handle(message) {
  const { id, method, params } = message;
  const isRequest = id !== undefined && id !== null;

  switch (method) {
    case 'initialize': {
      const asked = params?.protocolVersion;
      return result(id, {
        protocolVersion: SUPPORTED_PROTOCOLS.has(asked) ? asked : PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'agent-board', version: '1.0.0' },
        instructions: `Claude Code と Codex が共有するタスクボード（${DATA_PATH}）。`
          + '会話の最初に board_handoff を呼んで今の状況を把握し、作業の区切りごとに board_update と board_note で状態を残すこと。',
      });
    }

    case 'notifications/initialized':
    case 'notifications/cancelled':
      return undefined;

    case 'ping':
      return result(id, {});

    case 'tools/list':
      return result(id, {
        tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
      });

    case 'tools/call': {
      const tool = TOOLS.find((t) => t.name === params?.name);
      if (!tool) return failure(id, -32602, `unknown tool: ${params?.name}`);
      try {
        const text = tool.handler(params.arguments ?? {});
        return result(id, { content: [{ type: 'text', text }] });
      } catch (err) {
        // ツール内のエラーは isError で返す（プロトコルエラーにはしない）。
        return result(id, { content: [{ type: 'text', text: `エラー: ${err.message}` }], isError: true });
      }
    }

    case 'resources/list':
      return result(id, { resources: [] });

    case 'prompts/list':
      return result(id, { prompts: [] });

    default:
      if (isRequest) return failure(id, -32601, `method not found: ${method}`);
      return undefined;
  }
}

const rl = createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let message;
  try {
    message = JSON.parse(trimmed);
  } catch {
    return failure(null, -32700, 'parse error');
  }
  try {
    handle(message);
  } catch (err) {
    if (message.id !== undefined && message.id !== null) failure(message.id, -32603, err.message);
  }
});
rl.on('close', () => process.exit(0));
