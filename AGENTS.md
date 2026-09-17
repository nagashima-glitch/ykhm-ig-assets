# このリポジトリで作業するエージェントへ

`posts/` は Instagram の公開アセット（日付フォルダ / slide*.png / *.mp4 / index.html）。
`agent-board/` は Claude Code と Codex が状態を共有するためのタスクボード。

## 最初にやること

会話の最初に、今の状況を読む:

```
node agent-board/board.mjs handoff
```

（MCP を設定している場合は `board_handoff` ツールでも同じ結果が得られる）

## 作業中にやること

- 着手したら状態を進行中にする: `node agent-board/board.mjs set <id> --status doing --owner codex`
- ユーザーの判断が必要になったら: `node agent-board/board.mjs set <id> --status needs_you`
- 区切りがついたら付箋を残す（次に来る別のAIが読む）:
  `node agent-board/board.mjs note <id> "分かったこと / 詰まったこと / 次の一手" --by codex`
- 終わったら: `node agent-board/board.mjs set <id> --status done`

## 守ること

- `agent-board/tasks.json` を直接書き換えない。必ず `board.mjs` か MCP ツール経由で書く
  （同時書き込みでお互いの変更を消さないためのロックが入っている）。
- 自分の担当名は `codex` / `claude-code` を使う。ユーザー自身は `you`。
- 付箋は「次に作業するAIが、それだけ読んで続きをやれる」粒度で書く。

コマンド一覧は `node agent-board/board.mjs help`。
