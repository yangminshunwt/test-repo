# 回帰テスト

`regression.sh` は、このリポジトリの自動化（リリースラベルのチェック、CI、Cherry-Pick、Normal Release Preparation、Hotfix Release Preparation、Tag Creation、ルールセット）のシナリオを、GitHub の上で実際に動かし、期待どおりかを 1 件ずつ判定する。前のシナリオの結果を次のシナリオが使うので、上から順にすべて流す（途中の節だけを流すことはできない）。

## 流す前に

流すと、このリポジトリに次のことが起きる。残したい PR やブランチがあるときは流さない。

- 最初に、開いている PR をすべて閉じ（ブランチも削除）、`release/**` のブランチをすべて削除する。
- PR を作ってマージし、リリースブランチとタグを作り、ラベルを作ってアーカイブする。
- 途中で、リポジトリの設定（`allow_merge_commit`）、一時的なルールセット、App の変数（Environment `automation-app` の `AUTOMATION_APP_CLIENT_ID`）を変える。終わったとき（途中で止めたときも）元に戻す。

要るもの：

- このリポジトリの管理者として `gh auth login` してあり、git で push できること。
- macOS（BSD の `sed -i ''` と `date -v` を使う）。
- 自動化の GitHub App がインストールしてあり、Environment `automation-app`（main と `release/**/*` だけが使える）に、変数 `AUTOMATION_APP_CLIENT_ID` と秘密 `AUTOMATION_APP_PRIVATE_KEY` が設定してあること。

手元の作業場所は使わない（毎回、一時フォルダにリポジトリを複製して、そこで動かす）。

## 流し方

```bash
bash tests/regression/regression.sh
```

70〜80 分かかる。結果は、このフォルダの `regression-results.txt` に、1 件ごとに `OK` か `NG` で書く（git には入れない）。最後に件数と NG の一覧を出す。

RS9 は、GitHub のルールセットが main の `.github/rulesets/*.json` と同じかを比べる。ルールセットを変えるときは、GitHub に反映し、JSON の PR をマージしてから流す。
