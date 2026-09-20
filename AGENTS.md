# AGENTS.md — ykhm-ig-assets

Instagram 投稿用の画像・リールと、その確認用ページを置くリポジトリ。コードはほぼ無い。

## 構成
- `posts/YYYY-MM-DD/slide*.png` … カルーセル画像（順番どおり）
- `posts/YYYY-MM-DD/index.html` … 確認用ページ。画像は raw.githubusercontent.com の URL で参照する
- `posts/YYYY-MM-DD/reel-*.mp4` と `posts/YYYY-MM-DD/reel/index.html` … リール
- `.gitignore` は原則すべて無視。`posts/` 配下の png / mp4 / index.html と `docs/` のみ許可

## 作業ルール
- `posts/` は 40MB 超。**指定された投稿ディレクトリ以外を読まない**
- 既存の投稿ファイルを書き換えない。新しい日付のディレクトリを足す
- 確認ページは既存の `index.html` と同じ構造・同じスタイルに揃える
- コミットメッセージは既存に合わせる（例: `Add Instagram story image 2026-09-13`）

## モデル選択（重要）
着手前にタスクを分類し、次に当てはまるなら **推論レベルを high 以上に上げてから始める**
（対話中なら `/reasoning high`、起動時なら `--profile deep`）:

- HP・サイトの改築、ページ構成やテンプレートの設計変更
- 原因の分からない表示崩れ・不具合の調査
- 複数ファイルにまたがる変更、影響範囲が読めない変更

逆に、文言修正・画像差し替え・一括置換・リネームのような機械的な作業は
`--profile fast`（低推論）のままで良い。上げない。

詳しい振り分けは `docs/ai-workflow.md` を見ること。
