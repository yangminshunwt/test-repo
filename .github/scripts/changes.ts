import type { GitHub, Repository, WorkflowInput } from './github.ts';
import type { LabeledPullRequest } from './rules.ts';

export interface MergedPullRequest extends LabeledPullRequest {
  number: number;
  mergeCommit: string | null;
}

interface MergedPullsPage {
  repository: {
    pullRequests: {
      pageInfo: { hasNextPage: boolean; endCursor: string | null };
      nodes: {
        number: number;
        baseRefName: string;
        headRefName: string;
        mergeCommit: { oid: string } | null;
        labels: { nodes: { name: string }[] };
      }[];
    };
  };
}

// リリースに入るべき変更と、それがコミットに入っているかの判断。
// Tag Creation と Normal Release Preparation が、この同じ定義を使う。
// 入るべきかは rules.ts の belongsTo（開発ルールの「リリースラベル」）。git は、すべての履歴を取った作業場所で動かす。
import { git, prList, report } from './github-helpers.ts';
import { belongsTo, parseCherryPickBranch } from './rules.ts';

// マージされた PR をすべて、{ number, base, head, mergeCommit, labels } で返す。
// 作成日時（変わらない）の順にページを送るので、取っている間に PR が更新されても、取りこぼしも重複もない
// （更新日時の順だと、ラベルを付け替えた PR がページの境目をまたいで動く）。
async function listMergedPulls(github: GitHub, repo: Repository): Promise<MergedPullRequest[]> {
  const pulls: MergedPullRequest[] = [];
  let after: string | null = null;
  do {
    const response: MergedPullsPage = await github.graphql<MergedPullsPage>(
      `query($owner: String!, $name: String!, $after: String) {
        repository(owner: $owner, name: $name) {
          pullRequests(states: MERGED, orderBy: { field: CREATED_AT, direction: ASC }, first: 100, after: $after) {
            pageInfo { hasNextPage endCursor }
            nodes { number baseRefName headRefName mergeCommit { oid } labels(first: 50) { nodes { name } } }
          }
        }
      }`,
      { owner: repo.owner, name: repo.repo, after },
    );
    const page = response.repository.pullRequests;
    for (const node of page.nodes) {
      pulls.push({ number: node.number, base: node.baseRefName, head: node.headRefName, mergeCommit: node.mergeCommit?.oid ?? null, labels: node.labels.nodes.map((label) => label.name) });
    }
    after = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
  } while (after);
  return pulls;
}

// pull（{ number, mergeCommit }）の変更が commit に入っているか。pulls はマージされた PR の一覧（listMergedPulls）。
// pull のマージコミットか、pull の cherry-pick の PR（ブランチ名が cherry-pick-<番号>-to-...）のマージコミットが commit の祖先なら入っている。
// pull の変更を commit に当てても何も変わらない（同じ内容がもう入っている）ときも入っている（Cherry-Pick の backport-action も、
// このときは PR を作らない）。コミットが手元にない（消したブランチにだけあった）ときは、入っていないとみなす。
function containsChange(pulls: MergedPullRequest[], pull: Pick<MergedPullRequest, 'number' | 'mergeCommit'>, commit: string): boolean {
  const carriers = pulls.filter((other) => parseCherryPickBranch(other.head) === pull.number).map((other) => other.mergeCommit);
  for (const sha of [pull.mergeCommit, ...carriers]) {
    try {
      git('merge-base', '--is-ancestor', sha!, commit);
      return true;
    } catch {
      // 祖先ではない（か、コミットが手元にない）
    }
  }
  try {
    return git('merge-tree', '--write-tree', `--merge-base=${pull.mergeCommit}^1`, commit, pull.mergeCommit!).split('\n')[0] === git('rev-parse', `${commit}^{tree}`);
  } catch {
    return false; // コンフリクトする（終了コード 1）か、コミットが手元にない
  }
}

// product の version のリリースに入るべきなのに、commit に入っていない変更（マージされた PR）を返す
function missingChanges(pulls: MergedPullRequest[], product: string, version: string, commit: string): MergedPullRequest[] {
  return pulls.filter((pull) => belongsTo(pull, product, version) && !containsChange(pulls, pull, commit));
}

// normal-release-prep.yml から呼ぶ。リリースブランチ（RELEASE_BRANCH。チェックアウトしたときの先頭が BRANCH_SHA）に
// 入るべきなのに入っていない変更の Cherry-Pick を、PR ごとに実行する。ブランチを作る前に Cherry-Pick が動いた PR
// （作る間にマージされた PR）のため。
async function catchUp({ github, context, core }: WorkflowInput): Promise<void> {
  const env = process.env;
  const repo = context.repo;
  const missing = missingChanges(await listMergedPulls(github, repo), env.PRODUCT!, env.VERSION!, env.BRANCH_SHA!);
  for (const pull of missing) {
    await github.rest.actions.createWorkflowDispatch({ ...repo, workflow_id: 'cherry-pick.yml', ref: 'main', inputs: { pr_number: String(pull.number) } });
  }
  if (missing.length > 0) await report(core, 'Cherry-Pick', [`${env.RELEASE_BRANCH} に入っていない ${prList(missing)} の Cherry-Pick を実行しました。`]);
}

export { catchUp, containsChange, listMergedPulls, missingChanges };
