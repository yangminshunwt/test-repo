#!/bin/bash
# test-repo で、これまでに作った自動化のシナリオをすべて流し、期待どおりかを判定する回帰テスト。
# 前のシナリオのマージの結果を次のシナリオが使うので、上から順に流す。
set -u
export LC_ALL=C # bash 3.2 は変数の直後の全角文字を変数名として読むことがあるため
R=yangminshunwt/test-repo
APP=app/yang-minshun-s-cherry-pick-app # 自動化の GitHub App（cherry-pick の PR などを作る）
HERE=$(cd "$(dirname "$0")" && pwd)
RESULTS=$HERE/regression-results.txt # git には入れない（.gitignore）
TMP=$(mktemp -d)
T=$(date +%s) # 実行ごとに一意な値（コンフリクトを確実に起こすため）
ME=$(gh api user --jq .login) # 流している人（PR の作者とマージした人になり、失敗の通知の宛先になる）
: > "$RESULTS"
# テストは作業場所のブランチを作り直したりリセットしたりするので、手元の作業場所ではなく、毎回作る複製で動かす
DIR=$TMP/repo
gh repo clone "$R" "$DIR" -- -q || { echo "!! $R を複製できませんでした"; exit 1; }
cd "$DIR"

PASS=0
FAIL=0
record() { # <OK|NG> <ID> <内容> [詳細]
  echo "$1 $2 $3${4:+ / $4}" | tee -a "$RESULTS"
  if [ "$1" = OK ]; then PASS=$((PASS + 1)); else FAIL=$((FAIL + 1)); fi
}
ok_if() { # <ID> <内容> <コマンド...>
  local id=$1 what=$2
  shift 2
  if "$@"; then record OK "$id" "$what"; else record NG "$id" "$what"; fi
}
log() { echo; echo "===== $*" | tee -a "$RESULTS"; }
oneline() { tr '\n' ' ' | cut -c1-400; }
since_now() { date -u -v-2S +%Y-%m-%dT%H:%M:%SZ; }
next_minor() { echo "$1" | awk -F. '{print $1"."$2+1".0"}'; }
next_patch() { echo "$1" | awk -F. '{print $1"."$2"."$3+1}'; }
plus_patch() { echo "$1" | awk -F. -v n="$2" '{print $1"."$2"."$3+n}'; }

# ---- 一時的なエラー（GitHub の 5xx など）への備え ----
# git push：ルールでの拒否や、ないものの削除はやり直さない
gpush() {
  for _ in 1 2 3; do
    git push -q "$@" 2>"$TMP/push.err" && return 0
    grep -qE "GH013|remote ref does not exist|already exists|non-fast-forward|\[rejected\]" "$TMP/push.err" && return 1
    sleep 15
  done
  return 1
}
retry() { for _ in 1 2 3; do "$@" && return 0; sleep 15; done; return 1; }
set_merge_commit() { # <true|false>：リポジトリの設定を変え、変わったことを確かめる
  for _ in 1 2 3 4 5; do
    [ "$(gh api -X PATCH "repos/$R" -F allow_merge_commit="$1" --jq .allow_merge_commit 2>/dev/null)" = "$1" ] && return 0
    sleep 10
  done
  return 1
}
TEMP_RULESET_NAME="test: block creation"
temp_rulesets() { gh api "repos/$R/rulesets" --jq ".[] | select(.name == \"$TEMP_RULESET_NAME\") | .id" 2>/dev/null; }
delete_temp_rulesets() {
  local id
  for id in $(temp_rulesets); do retry gh api -X DELETE "repos/$R/rulesets/$id" >/dev/null 2>&1 || { echo "!! ルールセット $id を消せませんでした" >&2; return 1; }; done
  [ -z "$(temp_rulesets)" ]
}
INVALID_CLIENT_ID="Iv23liInvalidForTest"
CLIENT_ID=""
CLIENT_ID_CHANGED=""
set_client_id() { # <値>：変えて、変わったことを確かめる
  for _ in 1 2 3 4 5; do
    gh variable set AUTOMATION_APP_CLIENT_ID --repo $R --body "$1" >/dev/null 2>&1
    [ "$(gh variable get AUTOMATION_APP_CLIENT_ID --repo $R 2>/dev/null)" = "$1" ] && return 0
    sleep 10
  done
  return 1
}
cleanup() { # 途中で止まっても、テストで変えた設定を戻す
  set_merge_commit false || echo "!! allow_merge_commit を false に戻せませんでした" >&2
  delete_temp_rulesets || echo "!! 一時的なルールセットが残っています" >&2
  if [ -n "$CLIENT_ID_CHANGED" ]; then set_client_id "$CLIENT_ID" || echo "!! AUTOMATION_APP_CLIENT_ID を戻せませんでした（$CLIENT_ID）" >&2; fi
}
trap cleanup EXIT

# ---- PR ----
make_pr() { # <名前> <マージ先> <変更するコマンド> [ラベル...] → PR 番号
  local name=$1 base=$2 change=$3
  shift 3
  local branch="reg/$name" url
  retry git fetch -q origin
  if ! git switch -q -C "$branch" "origin/$base" 2>/dev/null; then echo "  (make_pr $name: origin/$base がありません)" >&2; git switch -q main; return; fi
  eval "$change"
  if ! { git add -A && git commit -q -m "reg: $name" >&2; }; then echo "  (make_pr $name: 変更がありません)" >&2; git switch -q main; return; fi
  gpush -f origin "$branch" || { echo "  (make_pr $name: push できませんでした)" >&2; git switch -q main; return; }
  local args=()
  for label in "$@"; do args+=(--label "$label"); done
  url=""
  for _ in 1 2 3; do
    url=$(gh pr create --repo $R --base "$base" --head "$branch" --title "reg: $name" --body "regression $name" ${args[@]+"${args[@]}"} 2>>"$TMP/pr.err") && break
    sleep 10
    url=$(gh pr list --repo $R --head "$branch" --state open --json url --jq '.[0].url // empty') # 失敗に見えて作られていた
    [ -n "$url" ] && break
  done
  git switch -q main
  local n=${url##*/} want have
  [ -z "$n" ] && { echo "  (make_pr $name: PR を作れませんでした)" >&2; return; }
  want=$(printf '%s\n' "$@" | sed '/^$/d' | sort | paste -sd, -)
  for _ in 1 2 3; do
    have=$(gh pr view "$n" --repo $R --json labels --jq '[.labels[].name] | sort | join(",")' 2>/dev/null)
    [ "$have" = "$want" ] && { echo "$n"; return; }
    for label in "$@"; do gh pr edit "$n" --repo $R --add-label "$label" >/dev/null 2>&1; done
    sleep 5
  done
  echo "  (make_pr $name: #$n のラベルがそろいません：$have)" >&2
}
head_of() { local h=""; [ -z "$1" ] && return; for _ in 1 2 3; do h=$(gh pr view "$1" --repo $R --json headRefName --jq .headRefName 2>/dev/null) && [ -n "$h" ] && break; sleep 5; done; echo "$h"; }
# head ブランチの release label check の実行のうち、since より後に作られたものがすべて終わるのを待ち、最後に作られたものの ID を出す
label_run() {
  local head=$1 since=$2 q total pending
  { [ -z "$head" ] || [ -z "$since" ]; } && return
  q="[.[] | select(.createdAt >= \"$since\")]"
  for _ in $(seq 1 72); do
    read -r total pending < <(gh run list --repo $R --workflow release-label-check.yml --branch "$head" --limit 30 --json createdAt,status --jq "$q | \"\(length) \([.[] | select(.status != \"completed\")] | length)\"")
    if [ "${total:-0}" -gt 0 ] && [ "${pending:-1}" = 0 ]; then
      gh run list --repo $R --workflow release-label-check.yml --branch "$head" --limit 30 --json databaseId,createdAt --jq "$q | sort_by(.createdAt) | .[-1].databaseId"
      return
    fi
    sleep 5
  done
}
run_messages() { # <run ID>：エラーと警告の行（ログがまだ取れなければ取り直す）
  local text=""
  for _ in 1 2 3 4; do
    text=$(gh run view "$1" --repo $R --log 2>/dev/null)
    [ -n "$text" ] && break
    sleep 4
  done
  echo "$text" | grep -E '##\[(error|warning)\]' | sed -E 's/.*##\[(error|warning)\]/[\1] /'
}
run_log() { local text=""; for _ in 1 2 3 4; do text=$(gh run view "$1" --repo $R --log 2>/dev/null); [ -n "$text" ] && break; sleep 4; done; echo "$text" | cut -f3- | sed -E 's/^[0-9TZ:.-]+ //'; }
# job の注釈（Environment の決まりで job が始まらなかったときの理由は、ログではなくここにだけ出る）
run_annotations() { local job; for job in $(gh run view "$1" --repo $R --json jobs --jq '.jobs[].databaseId' 2>/dev/null); do gh api "repos/$R/check-runs/$job/annotations" --jq '.[].message' 2>/dev/null; done; }
expect_label() { # <ID> <PR> <pass|fail> [正規表現] [since]
  local id=$1 pr=$2 want=$3 pattern=${4:-} since=${5:-} run got text head
  if [ -z "$pr" ]; then record NG "$id" "no PR to check (creation failed)"; return; fi
  head=$(head_of "$pr")
  [ -z "$since" ] && since=$(retry gh pr view "$pr" --repo $R --json createdAt --jq .createdAt 2>/dev/null)
  if [ -z "$head" ] || [ -z "$since" ]; then record NG "$id" "#$pr: cannot read the PR"; return; fi
  run=$(label_run "$head" "$since")
  if [ -z "$run" ]; then record NG "$id" "#$pr: label check did not finish"; return; fi
  got=$(gh run view "$run" --repo $R --json conclusion --jq '.conclusion | if . == "success" then "pass" elif . == "failure" then "fail" else . end')
  text=$(run_messages "$run")
  if [ "$got" = "$want" ] && { [ -z "$pattern" ] || echo "$text" | grep -qE "$pattern"; }; then
    record OK "$id" "#$pr label check=$got"
  else
    record NG "$id" "#$pr label check=$got (want $want${pattern:+ / $pattern})" "$(echo "$text" | oneline)"
  fi
}
merge_state() { # <PR>：mergeStateStatus（計算中の UNKNOWN が続くあいだは待つ）
  local st=""
  for _ in $(seq 1 12); do st=$(gh pr view "$1" --repo $R --json mergeStateStatus --jq .mergeStateStatus 2>/dev/null); [ -n "$st" ] && [ "$st" != UNKNOWN ] && break; sleep 5; done
  echo "$st"
}
update_if_behind() { # <PR>：マージの前にマージ先の最新を取り込むのが必須なので、遅れていれば取り込んでチェックを待つ
  local since
  [ "$(merge_state "$1")" = BEHIND ] || return 0
  since=$(since_now); gh pr update-branch "$1" --repo $R >/dev/null 2>&1; sleep 5
  label_run "$(head_of "$1")" "$since" >/dev/null
  gh pr checks "$1" --repo $R --watch --interval 10 >/dev/null 2>&1
}
expect_merge() { # <ID> <PR>
  local id=$1 pr=$2
  if [ -z "$pr" ]; then record NG "$id" "no PR to merge"; return; fi
  label_run "$(head_of "$pr")" "1970-01-01T00:00:00Z" >/dev/null
  gh pr checks "$pr" --repo $R --watch --interval 10 >/dev/null 2>&1
  for _ in 1 2 3; do
    update_if_behind "$pr"
    if gh pr merge "$pr" --repo $R --squash >/dev/null 2>&1; then record OK "$id" "merged #$pr"; return; fi
    sleep 10
  done
  record NG "$id" "cannot merge #$pr" "$(gh pr view "$pr" --repo $R --json mergeStateStatus,statusCheckRollup --jq '"\(.mergeStateStatus) \([.statusCheckRollup[] | "\(.name)=\(.conclusion)"] | join(","))"')"
}
pr_for() { gh pr list --repo $R --state "${2:-open}" --limit 200 --json number,headRefName --jq ".[] | select(.headRefName == \"$1\") | .number" | head -1; }
picks_of() { gh pr list --repo $R --state "${2:-all}" --limit 200 --json number,headRefName --jq "[.[] | select(.headRefName | startswith(\"cherry-pick-$1-to-\"))] | length"; }
wait_mergeable() { # <PR> <期待する値>：その値になるまで待ち、最後の値を出す
  local s=""
  for _ in $(seq 1 30); do s=$(gh pr view "$1" --repo $R --json mergeable --jq .mergeable); [ "$s" = "$2" ] && break; sleep 5; done
  echo "$s"
}
comments_matching() { gh pr view "$1" --repo $R --json comments --jq "[.comments[].body | select(test(\"$2\"))] | length"; }

# ---- ワークフロー ----
latest_dispatch() { local v=""; for _ in 1 2 3 4 5; do v=$(gh run list --repo $R --workflow "$1" --event workflow_dispatch --limit 1 --json databaseId --jq '.[0].databaseId // 0' 2>/dev/null); case "$v" in ''|*[!0-9]*) sleep 5 ;; *) echo "$v"; return ;; esac; done; echo 0; }
wait_run_done() { for _ in $(seq 1 90); do [ "$(gh run view "$1" --repo $R --json status --jq .status)" = completed ] && return; sleep 5; done; }
dispatch() { # <ワークフロー> [gh workflow run の引数...] → run ID（終わるまで待つ）
  local wf=$1 before id=0
  shift
  before=$(latest_dispatch "$wf")
  local ok=""
  for _ in 1 2 3; do
    if gh workflow run "$wf" --repo $R "$@" >/dev/null 2>"$TMP/dispatch.err"; then ok=1; break; fi
    grep -q "HTTP 5" "$TMP/dispatch.err" || break
    for _ in $(seq 1 12); do sleep 5; [ "$(latest_dispatch "$wf")" -gt "$before" ] && { ok=1; break 2; }; done
  done
  if [ -z "$ok" ]; then echo DISPATCH_FAILED; return; fi
  for _ in $(seq 1 45); do sleep 4; id=$(latest_dispatch "$wf"); [ "$id" -gt "$before" ] && break; done
  wait_run_done "$id"
  sleep 3
  echo "$id"
}
# マージした PR の cherry-pick の実行（pull_request_target）が終わるのを待ち、その ID を出す
wait_cherry_run() {
  local title id=""
  title=$(gh pr view "$1" --repo $R --json title --jq .title)
  for _ in $(seq 1 45); do
    id=$(gh run list --repo $R --workflow cherry-pick.yml --event pull_request_target --limit 40 --json databaseId,displayTitle,createdAt --jq "[.[] | select(.displayTitle == \"$title\")] | sort_by(.createdAt) | .[-1].databaseId // empty")
    [ -n "$id" ] && break
    sleep 4
  done
  [ -n "$id" ] && wait_run_done "$id"
  sleep 3
  echo "$id"
}
expect_run() { # <ID> <run ID> <success|failure> [正規表現]
  local id=$1 run=$2 want=$3 pattern=${4:-} got text
  if [ "$run" = DISPATCH_FAILED ]; then record NG "$id" "dispatch failed" "$(oneline < "$TMP/dispatch.err")"; return; fi
  if [ -z "$run" ]; then record NG "$id" "run not found"; return; fi
  got=$(gh run view "$run" --repo $R --json conclusion --jq .conclusion)
  text=$(run_log "$run"; run_annotations "$run")
  if [ "$got" = "$want" ] && { [ -z "$pattern" ] || echo "$text" | grep -qE "$pattern"; }; then
    record OK "$id" "run $run=$got"
  else
    record NG "$id" "run $run=$got (want $want${pattern:+ / $pattern})" "$(echo "$text" | grep -E '##\[(error|warning)\]' | head -3 | oneline)"
  fi
}
prep_pr() { gh pr list --repo $R --state open --json number,headRefName --jq ".[] | select(.headRefName | startswith(\"$1\")) | .number" | head -1; }
version_of() { git fetch -q origin; git show "origin/${2:-main}:VERSION" 2>/dev/null | grep "^$1/" | cut -d/ -f2; }
archived_at() { gh api "repos/$R/labels/$(echo "$1" | sed 's#/#%2F#')" --jq '.archived_at // ""' 2>/dev/null; }
is_archived() { [ -n "$(archived_at "$1")" ]; }
has_branch() { git fetch -q origin --prune; [ "$(git ls-remote --heads origin "$1" | wc -l | tr -d ' ')" = 1 ]; }
no_branch() { ! has_branch "$1"; }
has_tag() { [ "$(git ls-remote --tags origin "refs/tags/$1" | wc -l | tr -d ' ')" -ge 1 ]; }
tag_commit() { git fetch -q origin --tags --force; git rev-parse "$1^{commit}"; }
label_names() { gh pr view "$1" --repo $R --json labels --jq '[.labels[].name] | join(",")'; }
author_of() { gh pr view "$1" --repo $R --json author --jq .author.login; }

# =====================================================================
log "S. cleanup"
CLIENT_ID=$(retry gh variable get AUTOMATION_APP_CLIENT_ID --repo $R 2>/dev/null)
if [ -z "$CLIENT_ID" ] || [ "$CLIENT_ID" = "$INVALID_CLIENT_ID" ]; then echo "!! AUTOMATION_APP_CLIENT_ID が正しくありません（$CLIENT_ID）。直してから流してください。"; exit 1; fi
set_merge_commit false
delete_temp_rulesets
for n in $(gh pr list --repo $R --state open --limit 200 --json number --jq '.[].number'); do gh pr close "$n" --repo $R --delete-branch >/dev/null 2>&1; done
git fetch -q origin --prune --tags
for b in $(git ls-remote --heads origin 'release/*' | awk '{print $2}' | sed 's#refs/heads/##'); do gpush origin --delete "$b" 2>/dev/null; done
git switch -q main && git reset -q --hard origin/main
git branch | grep -vE '^\*|^  main$' | xargs git branch -D -q 2>/dev/null
echo "  open PRs: $(gh pr list --repo $R --state open --json number --jq length), release branches: $(git ls-remote --heads origin 'release/*' | wc -l | tr -d ' ')"
A0=$(version_of product-a); B0=$(version_of product-b); C0=$(version_of product-c)
RA="release/product-a/v$A0"; RB="release/product-b/v$B0"; RC="release/product-c/v$C0"
echo "  main: product-a=$A0 product-b=$B0 product-c=$C0"

# =====================================================================
log "R. Release prep"
[ "$(dispatch release-prep.yml -f product=product-x -f bump=minor)" = DISPATCH_FAILED ] && grep -q "not in the list of allowed values" "$TMP/dispatch.err" \
  && record OK R1 "GitHub rejects a product outside the choices" || record NG R1 "a product outside the choices was accepted"
gpush origin "origin/main:refs/heads/reg-ref" 2>/dev/null
# App の秘密鍵の Environment は main と release/** だけに使わせるので、ほかのブランチでは job が始まらない
expect_run R2 "$(dispatch release-prep.yml --ref reg-ref -f product=product-a -f bump=minor)" failure 'is not allowed to deploy to automation-app'
expect_run R2b "$(dispatch hotfix-prep.yml --ref reg-ref -f product=product-a)" failure 'is not allowed to deploy to automation-app'
gpush origin --delete reg-ref 2>/dev/null

# R3: release prep, merging a PR right after the checkout (catch-up path; timing dependent)
R0=$(make_pr r0-race main "echo r0-$T > ProductA/r0.txt" "product-a/v$A0"); expect_label R0 "$R0" pass
BEFORE=$(latest_dispatch release-prep.yml)
gh workflow run release-prep.yml --repo $R -f product=product-a -f bump=minor
RUN=0; for _ in $(seq 1 45); do sleep 2; RUN=$(latest_dispatch release-prep.yml); [ "$RUN" -gt "$BEFORE" ] && break; done
for _ in $(seq 1 120); do s=$(gh run view "$RUN" --repo $R --json jobs --jq '[.jobs[0].steps[]? | select(.name == "Run actions/checkout@v7")][0].status' 2>/dev/null); [ "$s" = completed ] && break; sleep 1; done
gh pr merge "$R0" --repo $R --squash >/dev/null 2>&1
wait_run_done "$RUN"; sleep 3
expect_run R3 "$RUN" success "$RA を作りました"
if run_log "$RUN" | grep -q "Cherry-Pick を実行しました"; then echo "  (R3: the catch-up path ran)"; else echo "  (R3: the catch-up path did not run; timing)"; fi
sleep 40
R0M=$(gh pr view "$R0" --repo $R --json mergeCommit --jq .mergeCommit.oid)
git fetch -q origin
if git merge-base --is-ancestor "$R0M" "origin/$RA" 2>/dev/null || [ -n "$(pr_for "cherry-pick-$R0-to-$RA")" ]; then record OK R3b "#$R0 is in $RA or has a cherry-pick PR to it"; else record NG R3b "#$R0 is neither in $RA nor cherry-picked"; fi
P=$(pr_for "cherry-pick-$R0-to-$RA"); [ -n "$P" ] && expect_merge R3c "$P"
PA=$(prep_pr "release-prep/product-a/"); expect_label R3d "$PA" pass
ok_if R3e "the VERSION bump PR is created by the App and has no release label" test "$(author_of "$PA") $(label_names "$PA")" = "$APP "
# リリースブランチでは Environment の決まりは通るので、スクリプトが main 以外を止める
expect_run R2c "$(dispatch release-prep.yml --ref "$RA" -f product=product-a -f bump=minor)" failure "main ブランチで実行してください"
expect_run R2d "$(dispatch hotfix-prep.yml --ref "$RA" -f product=product-a)" failure "main ブランチで実行してください"
expect_run R5 "$(dispatch release.yml --ref "$RA" -f step=rc)" failure "main の VERSION の product-a が $A0 のまま"
expect_merge R6 "$PA"
# 準備するバージョンは Run workflow を押した時点の main で決まるので、VERSION を上げたあとに Re-run しても次のバージョンの準備は始まらない
gh run rerun "$RUN" --repo $R >/dev/null; sleep 10; wait_run_done "$RUN"; sleep 3
expect_run R6b "$RUN" success "$RA はすでにあるので"
ok_if R6c "re-running after the bump creates no new branch or bump PR" sh -c "! git ls-remote --exit-code --heads origin release/product-a/v$(version_of product-a) >/dev/null && [ -z \"\$(gh pr list --repo $R --state open --json headRefName --jq '.[] | select(.headRefName | startswith(\"release-prep/product-a/\")) | .headRefName')\" ]"
expect_run R7 "$(dispatch release-prep.yml -f product=product-b -f bump=minor)" success
PB=$(prep_pr "release-prep/product-b/")
expect_run R7b "$(dispatch release-prep.yml -f product=product-c -f bump=minor)" success
PC=$(prep_pr "release-prep/product-c/")
expect_merge R7c "$PB"
ok_if R7d "bump PR #$PC for the adjacent VERSION line conflicts" test "$(wait_mergeable "$PC" CONFLICTING)" = CONFLICTING
expect_run R7e "$(dispatch release-prep.yml -f product=product-c -f bump=minor)" success "pull-request-operation = updated"
ok_if R7f "running again makes #$PC mergeable" test "$(wait_mergeable "$PC" MERGEABLE)" = MERGEABLE
expect_merge R7g "$PC"
A=$(version_of product-a); B=$(version_of product-b); C=$(version_of product-c)
echo "  main: product-a=$A product-b=$B product-c=$C, release branches: $RA $RB $RC"
gh label create "product-a/v$(next_minor "$A")" --repo $R --color 1d76db --description "Release label" >/dev/null 2>&1

# =====================================================================
log "L. Release label check (PRs are not merged)"
LA="product-a/v$A"; LB="product-b/v$B"; LC="product-c/v$C"; NEWER="product-a/v$(next_minor "$A")"
L1=$(make_pr l1-none main 'echo x >> ProductA/app.txt')
L2=$(make_pr l2-a main 'echo x >> ProductA/app.txt' "$LA")
L3=$(make_pr l3-shared-ab main 'echo x >> Shared/common.txt' "$LA" "$LB")
L4=$(make_pr l4-shared-abc main 'echo x >> Shared/common.txt' "$LA" "$LB" "$LC")
L5=$(make_pr l5-sab-ab main 'echo x >> SharedAB/common.txt' "$LA" "$LB")
L6=$(make_pr l6-sab-a main 'echo x >> SharedAB/common.txt' "$LA")
L7=$(make_pr l7-sac-ac main 'echo x >> SharedAC/common.txt' "$LA" "$LC")
L8=$(make_pr l8-sac-ab main 'echo x >> SharedAC/common.txt' "$LA" "$LB")
L9=$(make_pr l9-c main 'echo x >> ProductC/app.txt' "$LC")
L10=$(make_pr l10-unlisted-ab main 'mkdir -p Tools && echo x-$T > Tools/x.txt' "$LA" "$LB")
L11=$(make_pr l11-unlisted-abc main 'mkdir -p Tools && echo x-$T > Tools/x.txt' "$LA" "$LB" "$LC")
L12=$(make_pr l12-backport main 'echo x >> ProductA/app.txt' "product-a/v$A0")
L13=$(make_pr l13-dup main 'echo x >> ProductA/app.txt' "product-a/v$A0" "$LA")
L14=$(make_pr l14-newer main 'echo x >> ProductA/app.txt' "$NEWER")
L15=$(make_pr l15-move-shared main 'git mv Shared/common.txt ProductA/common.txt' "$LA")
L16=$(make_pr l16-move-in-a main 'git mv ProductA/app.txt ProductA/app2.txt' "$LA")
L17=$(make_pr l17-move-b-to-a main 'git mv ProductB/app.txt ProductA/app-b.txt' "$LA")
L18=$(make_pr l18-manual-bump main "sed -i '' 's#^product-a/$A\$#product-a/$(next_minor "$A")#' VERSION" "$NEWER")
L19=$(make_pr l19-readme-none main 'echo x >> README.md')
L20=$(make_pr l20-readme-one main 'echo x >> README.md' "$LB")
L21=$(make_pr l21-release-ok "$RA" 'echo x >> ProductA/app.txt' "product-a/v$A0")
L22=$(make_pr l22-release-other "$RA" 'echo x >> ProductA/app.txt' "product-b/v$B0")
L23=$(make_pr l23-archived main 'echo x >> ProductB/app.txt' "product-b/v2.1.0")
expect_label L1 "$L1" fail "product-a に影響する変更ですが"
expect_label L2 "$L2" pass
expect_label L3 "$L3" fail "product-c に影響する変更ですが"
expect_label L4 "$L4" pass
expect_label L5 "$L5" pass
expect_label L6 "$L6" fail "product-b に影響する変更ですが"
expect_label L7 "$L7" pass
expect_label L8 "$L8" fail "product-c に影響する変更ですが"
expect_label L9 "$L9" pass
expect_label L10 "$L10" fail "書かれていないパス"
expect_label L11 "$L11" pass "書かれていないパス"
expect_label L12 "$L12" pass
expect_label L13 "$L13" fail "複数あります"
expect_label L14 "$L14" fail "より新しいバージョンです"
expect_label L15 "$L15" fail "product-b に影響する変更ですが"
expect_label L16 "$L16" pass
expect_label L17 "$L17" fail "product-b に影響する変更ですが"
expect_label L18 "$L18" fail "release/product-a/v$A を作ってください"
expect_label L19 "$L19" pass
expect_label L20 "$L20" fail "product-b に影響する変更はありませんが"
expect_label L21 "$L21" pass
expect_label L22 "$L22" fail "だけを付けてください"
expect_label L23 "$L23" fail "v2.1.0 のリリースブランチがありません"
S=$(since_now); gh pr edit "$L2" --repo $R --remove-label "$LA" >/dev/null; expect_label L24a "$L2" fail "product-a に影響する変更ですが" "$S"
S=$(since_now); gh pr edit "$L2" --repo $R --add-label "$LA" >/dev/null; expect_label L24b "$L2" pass "" "$S"
S=$(since_now); gh pr edit "$L2" --repo $R --base "$RA" >/dev/null; expect_label L25a "$L2" fail "マージ先のブランチのバージョン（v$A0）より新しいバージョンです" "$S"
S=$(since_now); gh pr edit "$L2" --repo $R --base main >/dev/null; expect_label L25b "$L2" pass "" "$S"
for n in $L2 $L3 $L4 $L5 $L6 $L7 $L8 $L9 $L10 $L11 $L12 $L13 $L14 $L15 $L16 $L17 $L18 $L19 $L20 $L21 $L22 $L23; do gh pr close "$n" --repo $R --delete-branch >/dev/null 2>&1; done
gh pr close "$L1" --repo $R >/dev/null 2>&1

# =====================================================================
log "CI. The required ci check"
ci_bucket() { # <PR>：ci の結果（pass か fail）が出るまで待つ（PR を作った直後は、チェックがまだ登録されていない）
  local b=""
  for _ in $(seq 1 72); do b=$(gh pr checks "$1" --repo $R --json name,bucket --jq '.[] | select(.name == "ci") | .bucket' 2>/dev/null); case "$b" in pass|fail) break ;; esac; sleep 5; done
  echo "$b"
}
CI1=$(make_pr ci1-fail main 'touch ProductA/FAIL' "$LA")
ok_if CI1 "ci fails when a product test fails" test "$(ci_bucket "$CI1")" = fail
CI2=$(make_pr ci2-skipped main 'echo x >> ProductC/app.txt' "$LC")
ok_if CI2 "ci passes when every test job is skipped" test "$(ci_bucket "$CI2")" = pass
for n in $CI1 $CI2; do gh pr close "$n" --repo $R --delete-branch >/dev/null 2>&1; done

# =====================================================================
log "RL. Rechecking labels when release branches or VERSION change"
# 実行のやり直しは同じ実行（attempt が増える）なので、PR のチェックの結果が変わるのを待つ
label_bucket() { # <PR> <pass|fail>：release label check がその結果になるまで待ち、最後の結果を出す
  local b=""
  for _ in $(seq 1 60); do b=$(gh pr checks "$1" --repo $R --json name,bucket --jq '.[] | select(.name == "release label check") | .bucket' 2>/dev/null); [ "$b" = "$2" ] && break; sleep 5; done
  echo "$b"
}
RLV=$(echo "$(version_of product-a)" | awk -F. '{print $1"."$2-1".9"}')
gh label create "product-a/v$RLV" --repo $R --color 1d76db --description "Release label" >/dev/null 2>&1
RL=$(make_pr rl-recheck main 'echo rl-$T > ProductA/rl.txt' "product-a/v$RLV"); expect_label RL1 "$RL" fail "v$RLV のリリースブランチがありません"
git fetch -q origin && gpush origin "origin/main:refs/heads/release/product-a/v$RLV" 2>/dev/null
ok_if RL2 "creating release/product-a/v$RLV re-runs the check of #$RL and it passes" test "$(label_bucket "$RL" pass)" = pass
gpush origin --delete "release/product-a/v$RLV" 2>/dev/null
ok_if RL3 "deleting the branch re-runs the check of #$RL and it fails again" test "$(label_bucket "$RL" fail)" = fail
ok_if RL4 "the label of #$RL is unchanged" test "$(label_names "$RL")" = "product-a/v$RLV"
gh pr close "$RL" --repo $R --delete-branch >/dev/null 2>&1

# =====================================================================
log "C. Cherry-pick"
C1=$(make_pr c1-normal main 'echo c1-$T > ProductA/c1.txt' "product-a/v$A0"); expect_merge C1 "$C1"; wait_cherry_run "$C1" >/dev/null
P=$(pr_for "cherry-pick-$C1-to-$RA")
ok_if C1b "cherry-pick #$P to $RA has label product-a/v$A0 and is created by the App" test "$(label_names "$P") $(author_of "$P")" = "product-a/v$A0 $APP"
expect_merge C1c "$P"; wait_cherry_run "$P" >/dev/null
ok_if C1d "merging cherry-pick #$P does not cherry-pick further" test "$(picks_of "$P")" = 0

C2=$(make_pr c2-shared main 'echo c2-$T > Shared/c2.txt && echo c2-$T > .github/workflows/regression-c2.txt' "product-a/v$A0" "product-b/v$B0" "product-c/v$C0")
expect_merge C2 "$C2"; RUN=$(wait_cherry_run "$C2")
ok_if C2b "a shared change incl. .github/workflows is cherry-picked to 3 release branches" test "$(picks_of "$C2" open)" = 3
expect_run C2c "$RUN" success
expect_merge C2d "$(pr_for "cherry-pick-$C2-to-$RA")"
expect_merge C2e "$(pr_for "cherry-pick-$C2-to-$RC")"

C3P=$(make_pr c3-prep main "sed -i '' '1s/.*/product-a main-$T/' ProductA/app.txt" "product-a/v$A"); expect_merge C3 "$C3P"; wait_cherry_run "$C3P" >/dev/null
ok_if C3b "a label with main's version is not cherry-picked" test "$(picks_of "$C3P")" = 0
C3X=$(make_pr c3-conflict main "sed -i '' '1s/.*/product-a fix-$T/' ProductA/app.txt" "product-a/v$A0"); expect_merge C3c "$C3X"; wait_cherry_run "$C3X" >/dev/null
D=$(pr_for "cherry-pick-$C3X-to-$RA")
ok_if C3d "the conflict makes draft PR #$D" test "$(gh pr view "${D:-0}" --repo $R --json isDraft --jq .isDraft 2>/dev/null)" = true
ok_if C3e "the original PR gets a conflict comment" test "$(comments_matching "$C3X" "(?i)conflict")" -ge 1

PBK=$(pr_for "cherry-pick-$C2-to-$RB"); gh pr close "$PBK" --repo $R >/dev/null
expect_run C4 "$(dispatch cherry-pick.yml -f pr_number="$C2")" success "cherry-pick の PR があります"
NEWB=$(pr_for "cherry-pick-$C2-to-$RB")
ok_if C4b "only the closed one to $RB is recreated (#$NEWB)" test -n "$NEWB" -a "$NEWB" != "$PBK"
COUNT=$(picks_of "$C2")
expect_run C4c "$(dispatch cherry-pick.yml -f pr_number="$C2")" success
ok_if C4d "running again creates no more PRs" test "$(picks_of "$C2")" = "$COUNT"
expect_merge C4e "$NEWB"

MISS=$(echo "$C0" | awk -F. '{print $1"."$2-1".9"}')
gh label create "product-c/v$MISS" --repo $R --color 1d76db --description "Release label" >/dev/null 2>&1
gpush origin "origin/$RC:refs/heads/release/product-c/v$MISS" 2>/dev/null
C5=$(make_pr c5-missing main 'echo c5-$T > ProductC/c5.txt' "product-c/v$MISS"); expect_label C5 "$C5" pass
gpush origin --delete "release/product-c/v$MISS" 2>/dev/null
expect_merge C5b "$C5"; wait_cherry_run "$C5" >/dev/null
P=$(pr_for "cherry-pick-$C5-to-$RC"); ok_if C5c "the remaining $RC gets a cherry-pick (#$P)" test -n "$P"
ok_if C5d "no comment for the deleted v$MISS (the label was valid when it was checked)" test "$(comments_matching "$C5" "リリースブランチ")" = 0
expect_merge C5e "$P"
expect_run C6 "$(dispatch cherry-pick.yml -f pr_number="$L1")" failure "はマージされていません"
gpush origin --delete "reg/l1-none" 2>/dev/null # C6 のために残していた、マージしない PR のブランチ

CLIENT_ID_CHANGED=1; set_client_id "$INVALID_CLIENT_ID" || echo "  (C7: Client ID を変えられませんでした)"
C7=$(make_pr c7-rerun main 'echo c7-$T > ProductC/c7.txt' "product-c/v$C0"); expect_merge C7 "$C7"; RUN=$(wait_cherry_run "$C7")
set_client_id "$CLIENT_ID" && CLIENT_ID_CHANGED=""
ok_if C7a "the Client ID is restored" test "$(gh variable get AUTOMATION_APP_CLIENT_ID --repo $R)" = "$CLIENT_ID"
expect_run C7b "$RUN" failure
ok_if C7c "the failure is reported with an @ mention" test "$(comments_matching "$C7" "@$ME cherry-pick を終えられませんでした")" -ge 1
gh run rerun "$RUN" --repo $R --failed >/dev/null; sleep 10; wait_run_done "$RUN"; sleep 5
P=$(pr_for "cherry-pick-$C7-to-$RC")
ok_if C7d "Re-run failed jobs creates the cherry-pick PR (#$P)" test -n "$P" -a "$(author_of "${P:-0}" 2>/dev/null)" = "$APP"
gh run rerun "$RUN" --repo $R >/dev/null; sleep 10; wait_run_done "$RUN"; sleep 5
ok_if C7e "re-running again creates no more PRs" test "$(picks_of "$C7")" = 1
expect_merge C7f "$P"

# =====================================================================
log "E. Release (product-a)"
expect_run E1 "$(dispatch release.yml --ref main -f step=rc)" failure "リリースブランチ（release"
expect_run E2 "$(dispatch release.yml --ref "$RA" -f step=rc)" failure "入っていない変更があります（#$C3X）"
gh pr edit "$C3X" --repo $R --remove-label "product-a/v$A0" --add-label "product-a/v$A" >/dev/null
gh pr close "$D" --repo $R >/dev/null
expect_run E3 "$(dispatch release.yml --ref "$RA" -f step=rc)" success "product-a/v$A0-rc.1 を"
expect_run E4 "$(dispatch release.yml --ref "$RA" -f step=rc)" success "product-a/v$A0-rc.2 を"
expect_run E5 "$(dispatch release.yml --ref "$RA" -f step=release)" success "を削除しました"
ok_if E5b "tag product-a/v$A0 exists at the latest rc (rc.2)" test "$(tag_commit "product-a/v$A0")" = "$(tag_commit "product-a/v$A0-rc.2")"
ok_if E5c "label product-a/v$A0 is archived" is_archived "product-a/v$A0"
ok_if E5d "$RA is deleted" no_branch "$RA"

log "E6. Release (product-c, changes after the rc)"
expect_run E6 "$(dispatch release.yml --ref "$RC" -f step=rc)" success "product-c/v$C0-rc.1 を"
X=$(make_pr e6-pick main 'echo x-$T > ProductC/e6x.txt' "product-c/v$C0"); expect_merge E6b "$X"; wait_cherry_run "$X" >/dev/null
expect_merge E6c "$(pr_for "cherry-pick-$X-to-$RC")"
E6P=$(make_pr e6-direct "$RC" 'echo late-$T > ProductC/late.txt' "product-c/v$C0"); expect_merge E6d "$E6P"
expect_run E6e "$(dispatch release.yml --ref "$RC" -f step=release)" failure "入っていない変更があります（#$X、#$E6P）"
ok_if E6e2 "the late commits are listed" sh -c "gh run view $(latest_dispatch release.yml) --repo $R --log | grep -q 'リリースしたコミットより後に $RC に入ったコミット'"
ok_if E6f "tag product-c/v$C0 was created" has_tag "product-c/v$C0"
ok_if E6g "label product-c/v$C0 is archived" is_archived "product-c/v$C0"
ok_if E6h "$RC is deleted even with changes after the rc (they are reported)" no_branch "$RC"

log "K. Resolving conflicts (product-b)"
K1=$(make_pr k1-prep main "sed -i '' '1s/.*/product-b main-$T/' ProductB/app.txt" "product-b/v$B"); expect_merge K1 "$K1"; wait_cherry_run "$K1" >/dev/null
K2=$(make_pr k2-conflict main "sed -i '' '1s/.*/product-b fix-$T/' ProductB/app.txt" "product-b/v$B0"); expect_merge K2 "$K2"; wait_cherry_run "$K2" >/dev/null
KD=$(pr_for "cherry-pick-$K2-to-$RB")
ok_if K2b "the conflict makes draft PR #$KD" test "$(gh pr view "${KD:-0}" --repo $R --json isDraft --jq .isDraft 2>/dev/null)" = true
git fetch -q origin && git switch -q -C "cherry-pick-$K2-to-$RB" "origin/cherry-pick-$K2-to-$RB"
git checkout -q "origin/$RB" -- ProductB/app.txt && sed -i '' "1s/.*/product-b fix-$T/" ProductB/app.txt && git commit -q -am "Resolve conflict" && gpush origin "HEAD:cherry-pick-$K2-to-$RB" 2>/dev/null
git switch -q main
gh pr ready "$KD" --repo $R >/dev/null
expect_merge K2c "$KD"
expect_run K2d "$(dispatch cherry-pick.yml -f pr_number="$K2")" success "cherry-pick の PR があります"
K3=$(make_pr k3-conflict main "sed -i '' '1s/.*/product-b fix2-$T/' ProductB/app.txt" "product-b/v$B0"); expect_merge K3 "$K3"; wait_cherry_run "$K3" >/dev/null
KD3=$(pr_for "cherry-pick-$K3-to-$RB"); gh pr close "$KD3" --repo $R >/dev/null
git fetch -q origin && git switch -q -C "cherry-pick-$K3-to-$RB" "origin/$RB" && sed -i '' "1s/.*/product-b fix2-$T/" ProductB/app.txt && git commit -q -am "Manual cherry-pick of #$K3" && gpush -f origin "HEAD:cherry-pick-$K3-to-$RB" 2>/dev/null
git switch -q main
KM=$(gh pr create --repo $R --base "$RB" --head "cherry-pick-$K3-to-$RB" --title "[cherry-pick $RB] manual #$K3" --body "manual cherry-pick" --label "product-b/v$B0"); KM=${KM##*/}
expect_merge K3b "$KM"
expect_run K3c "$(dispatch cherry-pick.yml -f pr_number="$K3")" success "cherry-pick の PR があります"

log "E7. Release (product-b, missing changes and re-running the release)"
E7P=$(make_pr e7-b main 'echo e7-$T > ProductB/e7.txt' "product-b/v$B0"); expect_merge E7b "$E7P"; wait_cherry_run "$E7P" >/dev/null
gh pr close "$(pr_for "cherry-pick-$E7P-to-$RB")" --repo $R >/dev/null
# rc なしの release は、リリースしたコミットを commit に入力しないと打たない（ブランチの先頭は、リリースのあとに進んでいることがある）
expect_run E7 "$(dispatch release.yml --ref "$RB" -f step=release)" failure "commit にリリースしたコミットの SHA を入力して"
ok_if E7a "release without an rc creates no release tag without the commit input" sh -c "! git ls-remote --exit-code --tags origin refs/tags/product-b/v$B0 >/dev/null"
expect_run E7c "$(dispatch release.yml --ref "$RB" -f step=rc)" failure "入っていない変更があります（#$E7P）"
dispatch cherry-pick.yml -f pr_number="$E7P" >/dev/null
expect_merge E7d "$(pr_for "cherry-pick-$E7P-to-$RB")"
expect_run E7e "$(dispatch release.yml --ref "$RB" -f step=rc)" success "product-b/v$B0-rc.1 を"
git fetch -q origin
gpush origin "$(tag_commit "product-b/v$B0-rc.1"):refs/tags/product-b/v$B0" 2>/dev/null
expect_run E7g "$(dispatch release.yml --ref "$RB" -f step=release)" success "product-b/v$B0 はもう"
ok_if E7h "$RB is deleted" no_branch "$RB"
ok_if E7i "label product-b/v$B0 is archived" is_archived "product-b/v$B0"

log "U. Reusing an existing release branch (product-b)"
RBN="release/product-b/v$B"
gpush origin "origin/main:refs/heads/$RBN" 2>/dev/null
U1=$(make_pr u1 main 'echo u1-$T > ProductB/u1.txt' "product-b/v$B"); expect_merge U1 "$U1"; wait_cherry_run "$U1" >/dev/null
U2=$(make_pr u2 main 'echo u2-$T > ProductB/u2.txt' "product-b/v$B"); expect_merge U2 "$U2"; wait_cherry_run "$U2" >/dev/null
UP1=$(pr_for "cherry-pick-$U1-to-$RBN"); UP2=$(pr_for "cherry-pick-$U2-to-$RBN")
ok_if U3 "a label with main's version is cherry-picked to the same-version release branch" test -n "$UP1" -a -n "$UP2"
gh pr close "$UP1" --repo $R >/dev/null
expect_run U4 "$(dispatch release-prep.yml -f product=product-b -f bump=minor)" success "すでにあるので"
sleep 60
ok_if U5 "the catch-up re-creates the closed cherry-pick of #$U1" test -n "$(pr_for "cherry-pick-$U1-to-$RBN")"
UB=$(prep_pr "release-prep/product-b/")
expect_merge U6 "$UB"
expect_run U7 "$(dispatch release.yml --ref "$RBN" -f step=rc)" failure "入っていない変更があります（#$U1、#$U2）"

# =====================================================================
log "H1. Hotfix prep (product-c)"
CH=$(next_patch "$C0")
# リリースしたブランチが（管理者が作り直したなどで）残っていれば、リリース手順を先に終わらせる
gpush origin "$(tag_commit "product-c/v$C0"):refs/heads/$RC" 2>/dev/null
expect_run H1 "$(dispatch hotfix-prep.yml -f product=product-c)" failure "$RC がまだあります"
gpush origin --delete "$RC" 2>/dev/null
expect_run H1b "$(dispatch hotfix-prep.yml -f product=product-c)" success "release/product-c/v$CH を作りました"
HC=$(prep_pr "hotfix-prep/product-c/")
ok_if H1b2 "the hotfix bump PR changes only VERSION (the tag's .github is kept)" test "$(gh pr view "$HC" --repo $R --json files --jq '[.files[].path] | join(",")')" = VERSION
expect_run H1c "$(dispatch release.yml --ref "release/product-c/v$CH" -f step=rc)" failure "先に VERSION を上げる PR をマージしてください"
Y=$(make_pr h1-y main 'echo y-$T > ProductC/h1y.txt' "product-c/v$CH"); expect_merge H1d "$Y"; RUN=$(wait_cherry_run "$Y")
expect_run H1e "$RUN" success
YP=$(pr_for "cherry-pick-$Y-to-release/product-c/v$CH")
expect_label H1f "$YP" fail "一致しません"
expect_merge H1g "$HC"
S=$(since_now); gh pr update-branch "$YP" --repo $R >/dev/null 2>&1; expect_label H1h "$YP" pass "" "$S"
expect_merge H1i "$YP"
expect_run H1j "$(dispatch release.yml --ref "release/product-c/v$CH" -f step=rc)" failure "入っていない変更があります（#$X）"
ok_if H1k "Hotfix Preparation cherry-picked #$X (missed by v$C0) to release/product-c/v$CH" test -n "$(pr_for "cherry-pick-$X-to-release/product-c/v$CH")"
ok_if H1l "#$E6P (merged directly into the released branch) is not cherry-picked" test -z "$(pr_for "cherry-pick-$E6P-to-release/product-c/v$CH")"
expect_merge H1m "$(pr_for "cherry-pick-$X-to-release/product-c/v$CH")"
expect_run H1n "$(dispatch release.yml --ref "release/product-c/v$CH" -f step=rc)" success "product-c/v$CH-rc.1 を"

log "H2. Hotfix prep (product-a)"
AH=$(next_patch "$A0")
expect_run H2b "$(dispatch hotfix-prep.yml -f product=product-a)" success "release/product-a/v$AH を作りました"
expect_merge H2c "$(prep_pr "hotfix-prep/product-a/")"
expect_run H2d "$(dispatch hotfix-prep.yml -f product=product-a)" success "すでにあるので"
ok_if H2e "running again creates no PR" test -z "$(prep_pr "hotfix-prep/product-a/")"
expect_run H3 "$(dispatch release.yml --ref "release/product-a/v$AH" -f step=rc)" success "product-a/v$AH-rc.1 を"

log "H4. Two release branches of the same product (product-a)"
A=$(version_of product-a)
expect_run H4 "$(dispatch release-prep.yml -f product=product-a -f bump=minor)" success "release/product-a/v$A を作りました"
expect_merge H4b "$(prep_pr "release-prep/product-a/")"
H4M=$(make_pr h4-both main 'echo both-$T > ProductA/h4both.txt' "product-a/v$AH"); expect_merge H4c "$H4M"; wait_cherry_run "$H4M" >/dev/null
P1=$(pr_for "cherry-pick-$H4M-to-release/product-a/v$AH"); P2=$(pr_for "cherry-pick-$H4M-to-release/product-a/v$A")
ok_if H4d "an older label is cherry-picked to both release branches, each with its own version label" test "$(label_names "${P1:-0}" 2>/dev/null) $(label_names "${P2:-0}" 2>/dev/null)" = "product-a/v$AH product-a/v$A"
expect_merge H4e "$P1"; expect_merge H4f "$P2"
H4P=$(make_pr h4-pattern3 "release/product-a/v$A" 'echo p3-$T > ProductA/p3.txt' "product-a/v$AH"); expect_merge H4g "$H4P"; wait_cherry_run "$H4P" >/dev/null
gh pr close "$(pr_for "cherry-pick-$H4P-to-release/product-a/v$AH")" --repo $R >/dev/null
expect_run H4h "$(dispatch release.yml --ref "release/product-a/v$AH" -f step=rc)" failure "入っていない変更があります（#$H4P）"
dispatch cherry-pick.yml -f pr_number="$H4P" >/dev/null
expect_merge H4i "$(pr_for "cherry-pick-$H4P-to-release/product-a/v$AH")"
expect_run H4j "$(dispatch release.yml --ref "release/product-a/v$AH" -f step=rc)" success "product-a/v$AH-rc.2 を"
expect_run H4k "$(dispatch release.yml --ref "release/product-a/v$AH" -f step=release)" success "を削除しました"
ok_if H4l "the release tag is at rc.2 (not rc.1)" test "$(tag_commit "product-a/v$AH")" = "$(tag_commit "product-a/v$AH-rc.2")" -a "$(tag_commit "product-a/v$AH")" != "$(tag_commit "product-a/v$AH-rc.1")"
ok_if H4m "label product-a/v$AH is archived and release/product-a/v$A is kept" sh -c "[ -n \"$(archived_at "product-a/v$AH")\" ] && git ls-remote --exit-code --heads origin release/product-a/v$A >/dev/null"

log "E8. Release without an rc (product-a)"
HEADA=$(git ls-remote origin "refs/heads/release/product-a/v$A" | cut -f1)
git fetch -q origin
OLDV=""; for c in $(git rev-list "origin/release/product-a/v$A"); do [ "$(git show "$c:VERSION" 2>/dev/null | sed -n "s#^product-a/##p")" != "$A" ] && { OLDV=$c; break; }; done
expect_run E8n "$(dispatch release.yml --ref "release/product-a/v$A" -f step=release)" failure "commit にリリースしたコミットの SHA を入力して"
expect_run E8v "$(dispatch release.yml --ref "release/product-a/v$A" -f step=release -f commit="$OLDV")" failure "VERSION の product-a が $A のコミットではありません"
expect_run E8w "$(dispatch release.yml --ref "release/product-a/v$A" -f step=release -f commit="$(git rev-parse origin/main)")" failure "の履歴にある"
ok_if E8x "no release tag is created by the rejected commit inputs" sh -c "! git ls-remote --exit-code --tags origin refs/tags/product-a/v$A >/dev/null"
expect_run E8 "$(dispatch release.yml --ref "release/product-a/v$A" -f step=release -f commit="$(echo "$HEADA" | cut -c1-7)")" success "product-a/v$A を $(echo "$HEADA" | cut -c1-7)（commit に入力したコミット）に打ちました"
ok_if E8b "the release tag is at the branch head and no rc tag is created" sh -c "[ \"$(tag_commit "product-a/v$A")\" = \"$HEADA\" ] && ! git ls-remote --exit-code --tags origin 'refs/tags/product-a/v$A-rc.*' >/dev/null"
ok_if E8c "release/product-a/v$A is deleted and label product-a/v$A is archived" sh -c "! git ls-remote --exit-code --heads origin release/product-a/v$A >/dev/null && [ -n \"$(archived_at "product-a/v$A")\" ]"

log "H5. Hotfix prep from tags (product-b)"
git fetch -q origin --tags
BL=$(plus_patch "$B0" 5); BN=$(next_patch "$BL")
INITIAL=$(git rev-list --max-parents=0 origin/main)
git switch -q -C reg-legacy "$INITIAL" && git rm -q -r VERSION .github && git commit -q -m "legacy release without VERSION" && LEGACY=$(git rev-parse HEAD)
git tag -f -a -m "rc" "product-b/v$BL-rc.1" "$LEGACY" && git tag -f -a -m "release" "product-b/v$BL" "product-b/v$BL-rc.1" 2>/dev/null
gpush origin "product-b/v$BL-rc.1" "product-b/v$BL" 2>/dev/null; git switch -q main; git branch -D reg-legacy -q
# 自動化（.github）はタグのものを使うので、自動化を入れる前のタグからはブランチを作らない（そのブランチへの PR は必須チェックが動かない）
expect_run H5c "$(dispatch hotfix-prep.yml -f product=product-b)" failure "今の自動化を入れる前のタグ"
ok_if H5d "no release branch or bump PR is created from a tag without automation" sh -c "! git ls-remote --exit-code --heads origin release/product-b/v$BN >/dev/null && [ -z \"$(prep_pr "hotfix-prep/product-b/")\" ]"
# 偽の古いタグは、後のテストや手での確認に残さない
gpush origin --delete "refs/tags/product-b/v$BL" 2>/dev/null
gpush origin --delete "refs/tags/product-b/v$BL-rc.1" 2>/dev/null

# =====================================================================
log "RS. Rulesets"
git fetch -q origin && git switch -q -C reg-direct origin/main && echo d >> README.md && git commit -q -am "direct"
for _ in 1 2 3; do OUT=$(git push origin reg-direct:main 2>&1); echo "$OUT" | grep -q "GH013" && break; sleep 15; done
echo "$OUT" | grep -q "Changes must be made through a pull request" && record OK RS1 "a direct push to main is blocked" || record NG RS1 "a direct push to main is not blocked" "$(echo "$OUT" | oneline)"
# main と release/** は別のルールセットなので、release/** の側も確かめる
git switch -q -C reg-direct-r "origin/release/product-c/v$CH" && echo d >> README.md && git commit -q -am "direct"
for _ in 1 2 3; do OUT=$(git push origin "reg-direct-r:release/product-c/v$CH" 2>&1); echo "$OUT" | grep -q "GH013" && break; sleep 15; done
echo "$OUT" | grep -q "Changes must be made through a pull request" && record OK RS1r "a direct push to a release branch is blocked" || record NG RS1r "a direct push to a release branch is not blocked" "$(echo "$OUT" | oneline)"
git switch -q -C reg-force "origin/release/product-c/v$CH" && git commit -q --amend -m "rewrite"
for _ in 1 2 3; do OUT=$(git push -f origin "reg-force:release/product-c/v$CH" 2>&1); echo "$OUT" | grep -q "GH013" && break; sleep 15; done
echo "$OUT" | grep -q "Cannot force-push" && record OK RS2 "a force push to a release branch is blocked" || record NG RS2 "a force push to a release branch is not blocked" "$(echo "$OUT" | oneline)"
git switch -q -C reg-force-m origin/main && git commit -q --amend -m "rewrite"
for _ in 1 2 3; do OUT=$(git push -f origin reg-force-m:main 2>&1); echo "$OUT" | grep -q "GH013" && break; sleep 15; done
echo "$OUT" | grep -q "Cannot force-push" && record OK RS2m "a force push to main is blocked" || record NG RS2m "a force push to main is not blocked" "$(echo "$OUT" | oneline)"
git switch -q main; git branch -D reg-direct reg-direct-r reg-force reg-force-m -q
NGP=$(make_pr rs3-no-label main 'echo x >> ProductA/app.txt'); expect_label RS3 "$NGP" fail
gh pr merge "$NGP" --repo $R --squash --admin >/dev/null 2>&1 && record NG RS3b "a PR with a failing check was merged with --admin" || record OK RS3b "a PR with a failing check cannot be merged even with --admin"
NGR=$(make_pr rs3r-no-label "release/product-c/v$CH" 'echo x >> ProductC/app.txt'); expect_label RS3r "$NGR" fail
gh pr merge "$NGR" --repo $R --squash --admin >/dev/null 2>&1 && record NG RS3rb "a release-branch PR with a failing check was merged with --admin" || record OK RS3rb "a release-branch PR with a failing check cannot be merged even with --admin"
OKP=$(make_pr rs4-merge-commit main 'echo x >> ProductA/app.txt' "product-a/v$(version_of product-a)"); expect_label RS4 "$OKP" pass
OKR=$(make_pr rs4r-merge-commit "release/product-c/v$CH" 'echo x >> ProductC/app.txt' "product-c/v$CH"); expect_label RS4r "$OKR" pass
# GitHub はルールセット（squash のみ）で止めたときも「Merge commits are not allowed on this repository」と返し、
# メッセージではリポジトリの設定と区別できない。そこで、ルールセットのかからないブランチ（reg-base）では同じ設定で
# マージコミットができることを対照として確かめる
gpush origin "origin/main:refs/heads/reg-base" 2>/dev/null
CTL=$(make_pr rs4-control reg-base 'echo x >> ProductA/app.txt')
gh pr checks "$OKP" --repo $R --watch --interval 10 >/dev/null 2>&1 # 必須チェックの待ちで止まったのを「ルールセットで止まった」と取り違えない
gh pr checks "$OKR" --repo $R --watch --interval 10 >/dev/null 2>&1
set_merge_commit true || echo "  (RS4: allow_merge_commit を true にできませんでした)"
sleep 20
CTL_OUT=$(gh pr merge "$CTL" --repo $R --merge 2>&1); CTL_RC=$?
OUT=$(gh pr merge "$OKP" --repo $R --merge 2>&1); RC4=$?
OUTR=$(gh pr merge "$OKR" --repo $R --merge 2>&1); RC4R=$?
set_merge_commit false
if [ -z "$CTL" ] || [ $CTL_RC -ne 0 ]; then record NG RS4b "the control merge commit outside the rulesets failed" "$(echo "$CTL_OUT" | oneline)"
elif [ $RC4 -eq 0 ]; then record NG RS4b "a merge commit to main was not blocked by the ruleset"
elif echo "$OUT" | grep -qiE "merge commits are not allowed|merge method"; then record OK RS4b "the ruleset blocks a merge commit to main while the same setting allows it outside the rulesets"
else record NG RS4b "the merge commit to main failed for another reason" "$(echo "$OUT" | oneline)"; fi
if [ -z "$CTL" ] || [ $CTL_RC -ne 0 ]; then record NG RS4rb "the control merge commit outside the rulesets failed"
elif [ $RC4R -eq 0 ]; then record NG RS4rb "a merge commit to a release branch was not blocked by the ruleset"
elif echo "$OUTR" | grep -qiE "merge commits are not allowed|merge method"; then record OK RS4rb "the ruleset blocks a merge commit to a release branch"
else record NG RS4rb "the merge commit to a release branch failed for another reason" "$(echo "$OUTR" | oneline)"; fi
# マージ後の作業ブランチは自動で消えるので、1 本ずつ消す（まとめて消すと、ないブランチがあると全部止まる）
gpush origin --delete reg-base 2>/dev/null
gpush origin --delete reg/rs4-control 2>/dev/null
ok_if RS4c "the repository setting is restored (no merge commits)" test "$(gh api "repos/$R" --jq .allow_merge_commit)" = false
gh pr close "$NGP" --repo $R --delete-branch >/dev/null; gh pr close "$OKP" --repo $R --delete-branch >/dev/null 2>&1
gh pr close "$NGR" --repo $R --delete-branch >/dev/null 2>&1; gh pr close "$OKR" --repo $R --delete-branch >/dev/null 2>&1
ok_if RS5 "main has a deletion rule from the 'main branch: merging and deletion' ruleset" sh -c "gh api repos/$R/rules/branches/main --jq '[.[] | select(.type == \"deletion\")] | length' | grep -qv '^0$'"
git push -q origin "origin/main:refs/heads/release/product-c/v0.0.1" 2>"$TMP/rs6" && record OK RS6 "an admin can create a release branch" || record NG RS6 "an admin cannot create a release branch" "$(oneline < "$TMP/rs6")"
git push -q origin --delete release/product-c/v0.0.1 2>"$TMP/rs7" && record OK RS7 "an admin can delete a release branch" || record NG RS7 "an admin cannot delete a release branch" "$(oneline < "$TMP/rs7")"
C=$(version_of product-c)
gh api -X POST "repos/$R/rulesets" --input - >/dev/null 2>&1 <<EOF
{"name":"$TEMP_RULESET_NAME","target":"branch","enforcement":"active","conditions":{"ref_name":{"include":["refs/heads/release/product-c/v$C"],"exclude":[]}},"bypass_actors":[],"rules":[{"type":"creation"}]}
EOF
if [ -z "$(temp_rulesets)" ]; then record NG RS8 "could not create the temporary ruleset"; else
expect_run RS8 "$(dispatch release-prep.yml -f product=product-c -f bump=minor)" failure
ok_if RS8b "nothing is created when the release branch cannot be created" sh -c "! git ls-remote --exit-code --heads origin release/product-c/v$C >/dev/null && [ -z \"\$(gh pr list --repo $R --state open --json headRefName --jq '.[] | select(.headRefName | startswith(\"release-prep/product-c/\")) | .headRefName')\" ]"
fi
delete_temp_rulesets || echo "  (RS8: 一時的なルールセットを消せませんでした)"
git fetch -q origin
python3 -I - "$R" origin/main > "$TMP/rs9" <<'PY'
import json, subprocess, sys
repo, ref = sys.argv[1], sys.argv[2]
def git(*args):
    return subprocess.run(["git", *args], capture_output=True, text=True, check=True).stdout
def api(path):
    return json.loads(subprocess.run(["gh", "api", path], capture_output=True, text=True, check=True).stdout)
def norm(d):
    rules = []
    for r in d["rules"]:
        p = dict(r.get("parameters") or {})
        for k in ("require_extra_approval_for_unattributed_changes", "required_reviewers", "automatic_copilot_code_review_enabled"):
            p.pop(k, None)
        rules.append({"type": r["type"], "parameters": p} if p else {"type": r["type"]})
    return {
        "target": d["target"], "enforcement": d["enforcement"],
        "include": sorted(d["conditions"]["ref_name"]["include"]),
        "bypass": sorted((b["actor_type"], b["actor_id"], b["bypass_mode"]) for b in d.get("bypass_actors") or []),
        "rules": sorted(rules, key=lambda r: r["type"]),
    }
live = {r["name"]: api(f"repos/{repo}/rulesets/{r['id']}") for r in api(f"repos/{repo}/rulesets")}
bad = []
files = [f for f in git("ls-tree", "--name-only", f"{ref}:.github/rulesets").split() if f.endswith(".json")]
for f in files:
    want = json.loads(git("show", f"{ref}:.github/rulesets/{f}"))
    got = live.get(want["name"])
    if got is None or norm(got) != norm(want):
        bad.append(f)
print("OK" if not bad and len(live) == len(files) else "NG " + " ".join(bad) + f" (live {sorted(live)})")
PY
ok_if RS9 "the rulesets on GitHub match .github/rulesets/*.json on main" grep -q '^OK' "$TMP/rs9"

# =====================================================================
log "Result: OK $PASS, NG $FAIL"
grep '^NG ' "$RESULTS" || echo "no NG"
