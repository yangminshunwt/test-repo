import timers from 'node:timers/promises';
import { branchHead } from '../github-helpers.ts';
import { cherryPickBranch, findCherryPickTargets } from '../rules.ts';
import type { Logger, PullRequestInput } from './github.ts';

// 現在のリリースブランチから行き先を選ぶ。既存 PR や取り込み履歴は調べない。
export async function selectTargets({ github, repo, prNumber }: PullRequestInput) {
  const { data: pr } = await github.rest.pulls.get({ ...repo, pull_number: prNumber });
  if (!pr.merged) throw new Error(`#${pr.number} はマージされていません。`);

  const branches = await github.paginate(github.rest.repos.listBranches, { ...repo, per_page: 100 });
  const targets = findCherryPickTargets({
    base: pr.base.ref,
    head: pr.head.ref,
    labels: pr.labels.map((label) => label.name),
  }, branches.map((branch) => branch.name));

  // backport-action に既存の作業ブランチを再利用させない。削除や復旧は自動では行わない。
  for (const target of targets) {
    const branch = cherryPickBranch(prNumber, target);
    if (await branchHead(github, repo, branch)) {
      throw new Error(`${branch} はすでに存在します。既存のブランチを確認し、手動で対応してください。`);
    }
  }
  // マージ済み PR の merge_commit_sha は、そのマージコミットを指す。
  return { targets, mergeCommit: pr.merge_commit_sha! };
}

// backport-action が squash のコミットを識別できるよう、GitHub の PR とコミットの関連付けを待つ。
// 未反映のまま進むと、PR 内の Update branch のマージコミットを処理して失敗することがある。
export async function waitForMergeLink(
  { github, repo, prNumber, core, mergeCommit }: PullRequestInput & { core: Logger; mergeCommit: string },
): Promise<void> {
  for (let attempt = 0; attempt < 30; attempt++) {
    const { data } = await github.rest.repos.listPullRequestsAssociatedWithCommit({
      ...repo,
      commit_sha: mergeCommit,
    });
    if (data.some((pull) => pull.number === prNumber)) return;
    core.info(`マージコミット ${mergeCommit.slice(0, 7)} と #${prNumber} の結び付きが GitHub に反映されるのを待っています（${attempt + 1} 回目）。`);
    await timers.setTimeout(5000);
  }
  throw new Error(`マージコミットと #${prNumber} の結び付きが GitHub に反映されませんでした。しばらくしてから、Actions の「Cherry-Pick」→「Run workflow」で PR の番号 ${prNumber} を指定してやり直してください。`);
}
