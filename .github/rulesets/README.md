# ルールセット

リポジトリに設定しているルールセットの定義。GitHub の画面（Settings → Rules → Rulesets → Import a ruleset）か、次のコマンドで設定する。

```bash
gh api -X POST repos/{owner}/{repo}/rulesets --input .github/rulesets/<ファイル名>
```

設定を変えたら、このファイルも同じ内容に直す（`gh api repos/{owner}/{repo}/rulesets/<ID>` で今の設定を取れる）。

| ファイル | 対象 | 内容 |
|---|---|---|
| `main-branch.json` | `main` | 例外なしで：PR を必須にする（マージは squash だけ）、必須チェック（マージの前にマージ先の最新を取り込み、チェックをやり直す）、force push の禁止、削除の禁止 |
| `release-branches.json` | `release/**` | 例外なしで：PR を必須にする（マージは squash だけ）、必須チェック（マージの前にマージ先の最新を取り込み、チェックをやり直す）、force push の禁止 |
| `release-branch-creation-deletion.json` | `release/**` | 作成と削除の禁止（リリースブランチは自動化が作り、リリース後に消すので、管理者と自動化の App は除く） |
| `release-tags.json` | `*/v*` のタグ | 作成・変更・削除の禁止（管理者と自動化の App は除く） |

`main` と `release/**` を別のルールセットにしているのは、`main` のルールだけを変えられるようにするため（マージキューを使うときに、`main` だけにマージキューのルールを足し、必須チェックなどの設定も `main` だけ変える）。同じブランチにかかるルールセットが複数あると、ルールごとにいちばん厳しいものが使われるので、共通のルールセットのルールは、別のルールセットを足しても `main` だけゆるめたり変えたりできない。今は 2 つの中身は同じ（`main` だけ削除も禁止）で、どちらかを変えるときは、もう一方も変えるかを決める。

`main-branch.json` と `release-branches.json` の 3 つ（squash だけ、マージの前にマージ先の最新を取り込む、例外なし）により、マージできる PR は、PR の先頭の中身がマージ後の中身と同じになる。ラベルのチェックと CI は、これを前提に PR の先頭を確かめている。必須チェックは `release label check` と `ci`（CI の最後のジョブ。テストのジョブが失敗・取り消しなら失敗する）の 2 つで、製品を足してもここは変えない。必須チェックを変えるときは、ワークフローの変更をマージする前にルールセットを変える（逆だと、その間は必須でないチェックの失敗でマージできてしまう）。既存のルールセットは `gh api -X PUT repos/{owner}/{repo}/rulesets/<ID> --input <ファイル>` で変える。

必須チェックの結果はコミットに付くので、同じコミットを先頭にした PR を、別のマージ先に 2 つ出さない（一方の結果が、もう一方にも使われる）。

管理者がリリースブランチを（リリースせずに）消したときは、同じ名前のブランチを作り直さない。前のブランチにマージした cherry-pick の PR があると、Cherry-Pick はその行き先を済んだものとして扱うため。

必須チェックの `integration_id: 15368` は GitHub Actions を表す。ほかのアプリや commit status から同じ名前の結果を送られても、必須チェックを満たさないようにしている。

`release-tags.json` と `release-branch-creation-deletion.json` の `Integration` の `actor_id` は、自動化に使っている GitHub App の App ID（App の設定ページの General に出る）。自動化（Release Preparation・Hotfix Preparation）がリリースブランチを作り、Tag Creation がタグを打ってリリースブランチを削除するために、管理者と同じく例外にしている。リポジトリごとに App が違うので、設定するときに書き換える。
