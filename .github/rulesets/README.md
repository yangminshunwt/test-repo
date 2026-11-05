# ルールセット

リポジトリに設定しているルールセットの定義。GitHub の画面（Settings → Rules → Rulesets → Import a ruleset）か、次のコマンドで設定する。

```bash
gh api -X POST repos/{owner}/{repo}/rulesets --input .github/rulesets/<ファイル名>
```

設定を変えたら、このファイルも同じ内容に直す（`gh api repos/{owner}/{repo}/rulesets/<ID>` で今の設定を取れる）。

| ファイル | 対象 | 内容 |
|---|---|---|
| `protected-branches.json` | `main`・`release/**` | PR を必須にする（マージは squash だけ）、必須チェック、force push の禁止 |
| `protected-branch-deletion.json` | `main`・`release/**` | 削除の禁止（リリース後にリリースブランチを消すため、管理者は除く） |
| `release-tags.json` | `*/v*` のタグ | 作成・変更・削除の禁止（管理者は除く） |

必須チェックの `integration_id: 15368` は GitHub Actions を表す。ほかのアプリや commit status から同じ名前の結果を送られても、必須チェックを満たさないようにしている。
