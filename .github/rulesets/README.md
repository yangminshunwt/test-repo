# ルールセット

リポジトリに設定しているルールセットの定義。GitHub の画面（Settings → Rules → Rulesets → Import a ruleset）か、次のコマンドで設定する。

```bash
gh api -X POST repos/{owner}/{repo}/rulesets --input .github/rulesets/<ファイル名>
```

設定を変えたら、このファイルも同じ内容に直す（`gh api repos/{owner}/{repo}/rulesets/<ID>` で今の設定を取れる）。

| ファイル（ルールセットの名前） | 対象 | 内容 | 例外 |
|---|---|---|---|
| `main-branch-merging-deletion.json`（main branch: merging and deletion） | `main` | PR を必須にする（マージは squash だけ）、必須チェック（マージの前にマージ先の最新を取り込み、チェックをやり直す）、force push の禁止、削除の禁止 | なし |
| `release-branches-merging.json`（release branches: merging） | `release/**` | PR を必須にする（マージは squash だけ）、必須チェック（マージの前にマージ先の最新を取り込み、チェックをやり直す）、force push の禁止 | なし |
| `release-branches-creation-deletion.json`（release branches: creation and deletion） | `release/**` | 作成と削除の禁止 | 管理者と自動化の App（リリースブランチは自動化が作り、リリース後に消すため） |
| `release-tags.json`（release tags: creation, update and deletion） | `*/v*` のタグ | 作成・変更・削除の禁止 | 管理者と自動化の App |

ルールセットは、対象と例外の組み合わせごとに分けている（例外はルールセット全体にかかり、ルールごとには決められないため）。名前は「対象: 何を禁止・必須にするか」で、merging は、ブランチに変更を入れるときのルール（PR・必須チェック・force push の禁止）を表す。

`main` と `release/**` を別のルールセットにしているのは、`main` のルールだけを変えられるようにするため（マージキューを使うときに、`main` だけにマージキューのルールを足し、必須チェックなどの設定も `main` だけ変える）。同じブランチにかかるルールセットが複数あると、ルールごとにいちばん厳しいものが使われるので、共通のルールセットのルールは、別のルールセットを足しても `main` だけゆるめたり変えたりできない。今は 2 つの中身は同じ（`main` だけ削除も禁止）で、どちらかを変えるときは、もう一方も変えるかを決める。

`main-branch-merging-deletion.json` と `release-branches-merging.json` の 3 つ（squash だけ、マージの前にマージ先の最新を取り込む、例外なし）により、マージできる PR は、PR の先頭の中身がマージ後の中身と同じになる。ラベルのチェックと CI は、これを前提に PR の先頭を確かめている。ただし、マージキューを使う `main` では、PR をマージ先の最新に合わせなくてもキューに入れられるので、この前提は成り立たない。`main` に入るのはキューが作るマージグループのコミットで、それを確かめるのは、merge_group で動く同じ 2 つの必須チェック（下の「マージキュー」）。必須チェックは `release label check` と `ci`（CI の最後のジョブ。テストのジョブが失敗・取り消しなら失敗する）の 2 つで、製品を足してもここは変えない。必須チェックを変えるときは、ワークフローの変更をマージする前にルールセットを変える（逆だと、その間は必須でないチェックの失敗でマージできてしまう）。既存のルールセットは `gh api -X PUT repos/{owner}/{repo}/rulesets/<ID> --input <ファイル>` で変える。

必須チェックの結果はコミットに付くので、同じコミットを先頭にした PR を、別のマージ先に 2 つ出さない（一方の結果が、もう一方にも使われる）。

管理者がリリースブランチを（リリースせずに）消したときは、同じ名前のブランチを作り直さない。前のブランチにマージした cherry-pick の PR があると、Cherry-Pick はその行き先を済んだものとして扱うため。

必須チェックの `integration_id: 15368` は GitHub Actions を表す。ほかのアプリや commit status から同じ名前の結果を送られても、必須チェックを満たさないようにしている。

`release-tags.json` と `release-branches-creation-deletion.json` の `Integration` の `actor_id` は、自動化に使っている GitHub App の App ID（App の設定ページの General に出る）。自動化（Normal Release Preparation・Hotfix Release Preparation）がリリースブランチを作り、Tag Creation がタグを打ってリリースブランチを削除するために、管理者と同じく例外にしている。リポジトリごとに App が違うので、設定するときに書き換える。

## マージキュー

本番の `main` ではマージキューを使う（このリポジトリは個人のものなので使えない）。使うときは、`main-branch-merging-deletion.json` に `merge_queue` のルールを足す（組織のルールセットには置けない）。

- `merge_method` は `SQUASH`（`pull_request` の `allowed_merge_methods` と同じ）。Cherry-Pick と「変更が入っているか」の判断は、PR の変更が、親が 1 つのコミットとして入ることを前提にしている。
- `grouping_strategy` は `ALLGREEN`（キューのそれぞれの PR のマージグループが、必須チェックを通らないとマージしない）。ラベルのチェックは PR ごとなので、`HEADGREEN` だと、ラベルのチェックに落ちた PR も、グループの最後が通ればマージされる。
- 必須チェック（`release label check` と `ci`）は、そのまま。ワークフローは `merge_group` でも動き、マージグループのコミット（そのまま `main` に入る中身）で確かめる。マージ前の中身はマージグループの親（`main` に、キューで前にある PR を足したもの）で、変更はこの PR の変更だけになる。PR をキューに入れるには、PR の先頭でも同じ 2 つが通っている必要がある。
- マージグループの PR は、マージキューのブランチ名（`gh-readonly-queue/main/pr-<番号>-<SHA>`）から読む。1 つのマージグループのコミットには 1 つの PR の変更だけが入る前提なので、スタックした PR（スタック全体が 1 つのマージグループになる）は、マージキューでは使わない。
- キューに入ったあとのラベルの変更と、リリースブランチの作成・削除は、通ったマージグループのチェックには反映されない（Release Label Recheck が確かめ直すのは、PR の先頭のチェックだけ）。
