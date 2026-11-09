// リリースに入るべき変更と、それがコミットに入っているかの判断。
// Tag Creation、Cherry-Pick、Release Preparation、Hotfix Preparation が、この同じ定義を使う。
// 入るべきかは release-labels.js の belongsTo（開発ルールの「リリースラベル」）。
'use strict';

const { execFileSync } = require('child_process');
const { belongsTo, parseCherryPickBranch } = require('./release-labels.js');

// マージされた PR をすべて、{ number, base, head, mergeCommit, labels } で返す（head は、フォークからの PR なら空）。
// 作成日時（変わらない）の順にページを送るので、取っている間に PR が更新されても、取りこぼしも重複もない
// （更新日時の順だと、ラベルを付け替えた PR がページの境目をまたいで動く）。
async function listMergedPulls(github, repo) {
  const pulls = [];
  let after = null;
  do {
    const { repository } = await github.graphql(
      `query($owner: String!, $name: String!, $after: String) {
        repository(owner: $owner, name: $name) {
          pullRequests(states: MERGED, orderBy: { field: CREATED_AT, direction: ASC }, first: 100, after: $after) {
            pageInfo { hasNextPage endCursor }
            nodes { number baseRefName headRefName isCrossRepository mergeCommit { oid } labels(first: 50) { nodes { name } } }
          }
        }
      }`,
      { owner: repo.owner, name: repo.repo, after },
    );
    const page = repository.pullRequests;
    for (const node of page.nodes) {
      pulls.push({
        number: node.number,
        base: node.baseRefName,
        head: node.isCrossRepository ? '' : node.headRefName,
        mergeCommit: node.mergeCommit?.oid ?? null,
        labels: node.labels.nodes.map((label) => label.name),
      });
    }
    after = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
  } while (after);
  return pulls;
}

// dir（すべての履歴を取った作業場所）で git を動かす
function gitIn(dir) {
  return (...args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
}

// pull（{ number, mergeCommit }）の変更が commit に入っているか。pulls はマージされた PR の一覧（listMergedPulls）。
// pull のマージコミットか、pull の cherry-pick の PR のマージコミットが commit の祖先なら入っている。
// pull の変更を commit に当てても何も変わらない（同じ内容がもう入っている）ときも入っている（Cherry-Pick の backport-action も、
// このときは PR を作らない）。コミットが手元にない（消したブランチにだけあった）ときは、入っていないとみなす。
function containsChange(dir, pulls, pull, commit) {
  const git = gitIn(dir);
  const carriers = pulls.filter((other) => parseCherryPickBranch(other.head) === pull.number).map((other) => other.mergeCommit);
  for (const sha of [pull.mergeCommit, ...carriers]) {
    try {
      git('merge-base', '--is-ancestor', sha, commit);
      return true;
    } catch {
      // 祖先ではない（か、コミットが手元にない）
    }
  }
  try {
    return git('merge-tree', '--write-tree', `--merge-base=${pull.mergeCommit}^1`, commit, pull.mergeCommit).split('\n')[0] === git('rev-parse', `${commit}^{tree}`);
  } catch {
    return false; // コンフリクトする（終了コード 1）か、コミットが手元にない
  }
}

// product の version のリリースに入るべきなのに、commit に入っていない変更（マージされた PR）を返す
function missingChanges(dir, pulls, product, version, commit) {
  return pulls.filter((pull) => belongsTo(pull, product, version) && !containsChange(dir, pulls, pull, commit));
}

// product の version のリリースブランチ（今作ったもの。先頭が commit）に入るべきなのに入っていない変更の Cherry-Pick を、
// PR ごとに実行する。ブランチを作る前に Cherry-Pick が動いた PR（作る間にマージされた PR や、前のリリースに入らなかった PR）のため。
// Cherry-Pick は、cherry-pick の PR がもうある行き先や、変更がもう入っている行き先を飛ばすので、何度実行してもよい。
async function dispatchCherryPicks({ github, repo, dir, product, version, commit }) {
  const missing = missingChanges(dir, await listMergedPulls(github, repo), product, version, commit);
  for (const pull of missing) {
    await github.rest.actions.createWorkflowDispatch({ ...repo, workflow_id: 'cherry-pick.yml', ref: 'main', inputs: { pr_number: String(pull.number) } });
  }
  return missing;
}

module.exports = { containsChange, dispatchCherryPicks, listMergedPulls, missingChanges };
