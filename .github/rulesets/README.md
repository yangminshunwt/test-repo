# ルールセット

リポジトリに設定しているルールセットの定義。GitHub の画面（Settings → Rules → Rulesets → Import a ruleset）か、次のコマンドで設定する。

```bash
gh api -X POST repos/{owner}/{repo}/rulesets --input .github/rulesets/<ファイル名>
```

設定を変えたら、このファイルも同じ内容に直す（`gh api repos/{owner}/{repo}/rulesets/<ID>` で今の設定を取れる）。

| ファイル | 対象 | 内容 |
|---|---|---|
| `protected-branches.json` | `main`・`release/**` | PR を必須にする（マージは squash だけ）、必須チェック、force push の禁止 |
<<<<<<< HEAD
| `protected-branch-deletion.json` | `main`・`release/**` | 削除の禁止（リリース後にリリースブランチを消すため、管理者は除く） |
| `release-tags.json` | `*/v*` のタグ | 作成・変更・削除の禁止（管理者は除く） |

必須チェックの `integration_id: 15368` は GitHub Actions を表す。ほかのアプリや commit status から同じ名前の結果を送られても、必須チェックを満たさないようにしている。
=======
| `main-deletion.json` | `main` | 削除の禁止（例外なし） |
| `release-branch-deletion.json` | `release/**` | 削除の禁止（リリース後にリリースブランチを消すため、管理者と自動化の App は除く） |
| `release-tags.json` | `*/v*` のタグ | 作成・変更・削除の禁止（管理者と自動化の App は除く） |

必須チェックの `integration_id: 15368` は GitHub Actions を表す。ほかのアプリや commit status から同じ名前の結果を送られても、必須チェックを満たさないようにしている。

`release-tags.json` と `release-branch-deletion.json` の `Integration` の `actor_id` は、自動化に使っている GitHub App の App ID（App の設定ページの General に出る）。リリースの自動化（Release）がタグを打ち、リリースブランチを削除するために、管理者と同じく例外にしている。リポジトリごとに App が違うので、設定するときに書き換える。
>>>>>>> 5bffd49 (Judge missing changes by content, check main VERSION, and run release scripts from main (#130))
