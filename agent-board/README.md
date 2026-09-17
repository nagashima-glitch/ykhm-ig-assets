# agent-board

Claude Code と Codex が、同じタスク・同じ進捗・同じ経緯を見るための最小の仕組み。
依存パッケージなし（Node だけ）。

## 考え方

本体は **`tasks.json` 1 ファイル** と、それを壊さずに読み書きする薄い CLI だけ。
両方の AI に同じフォルダを見せれば状態は共有できる ——
足りないのは「同じ書き方」なので、そこだけを決めている。

| 層 | 役割 | 無くても動くか |
|---|---|---|
| `tasks.json` | 唯一の状態。git に乗せれば端末間も同期される | 本体 |
| `board.mjs` | CLI。壊れない書き込み（排他ロック付き） | 本体 |
| `AGENTS.md` / `CLAUDE.md` | 両AIへの「最初に handoff を読め」という指示 | 本体（これが無いと読まない） |
| `mcp-server.mjs` | MCP ツールとして呼べるようにする上乗せ | ○ 無くてよい |
| `board.html` | ブラウザのカンバン表示 | ○ 無くてよい |

## 使う

```bash
node agent-board/board.mjs handoff     # 今の状況（新しいセッションの最初に読む）
node agent-board/board.mjs board       # カンバン表示
node agent-board/board.mjs add "9/20の投稿を作る" --status doing --owner claude-code --project ykhm-ig
node agent-board/board.mjs set  t_xxx --status needs_you
node agent-board/board.mjs note t_xxx "3枚目まで完成。次は文言の推敲。" --by codex
node agent-board/board.mjs show t_xxx  # 付箋（経緯）つきで1件を読む
node agent-board/board.mjs serve       # http://127.0.0.1:4173 でブラウザ表示
```

状態は `doing`(進行中) / `needs_you`(あなたの判断待ち) / `agent`(エージェント待ち) /
`hold`(保留) / `done`(完了)。担当は `claude-code` / `codex` / `you` / `both`。

## MCP として繋ぐ（任意）

**Claude Code** — リポジトリ直下の `.mcp.json` がすでにこの設定なので、
プロジェクトを開いて MCP サーバーを許可すれば `board_*` ツールが使える。

**Codex CLI** — `~/.codex/config.toml` に追記する（パスは絶対パスで）:

```toml
[mcp_servers.agent-board]
command = "node"
args = ["/絶対パス/ykhm-ig-assets/agent-board/mcp-server.mjs"]
env = { AGENT_BOARD_AGENT = "codex" }
```

ツール: `board_handoff` / `board_list` / `board_get` / `board_add` /
`board_update` / `board_note` / `board_remove`。

MCP を設定しない場合でも、`AGENTS.md` に書いた CLI コマンドで同じことができる。

## 仕組みの注意点

- 書き込みは必ず `board.mjs` か MCP 経由で。`tasks.json` を直接上書きすると、
  もう片方の AI の変更を消す可能性がある（CLI 側は `tasks.json.lock` で排他してから
  読み→変更→書き出しを行い、一時ファイル + rename で原子的に置き換える）。
- `serve` は `127.0.0.1` だけで待ち受ける。認証は無いので外部に公開しない。
- 保存場所を変えたいときは環境変数 `AGENT_BOARD_FILE` で差し替えられる。
