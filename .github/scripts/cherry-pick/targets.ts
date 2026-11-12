import timers from 'node:timers/promises';
import { containsChange, listMergedPulls } from '../changes.ts';
import { branchHead, deleteBranchIfAt, localReleaseBranches } from '../github-helpers.ts';
import { cherryPickBranch, findCherryPickTargets } from '../rules.ts';
import { listCherryPickPulls, type Logger, type PullRequestInput } from './github.ts';

// backport-action の git_committer_email の既定値。
const AUTOMATION_COMMITTER = 'github-actions[bot]@users.noreply.github.com';

interface PendingTarget {
  target: string;
  closedPullHeads: string[];
}

interface TargetSelection {
  targets: string[];
  pending: PendingTarget[];
  mergeCommit: string;
}

// targets はラベルを整える行き先。pending は、PR も変更もまだ入っていない行き先。
// ブランチの一覧と「変更が入っているか」は、どちらもチェックアウトした時点で判断する。
// その後に作られた通常リリースのブランチは、Normal Release Preparation が追補する。
export async function selectTargets(input: PullRequestInput & { core: Logger }): Promise<TargetSelection> {
  const { github, repo, prNumber, core } = input;
  const { data: pr } = await github.rest.pulls.get({ ...repo, pull_number: prNumber });
  if (!pr.merged) throw new Error(`#${pr.number} はマージされていません。`);

  // マージ済み PR の merge_commit_sha は、そのマージコミットを指す。
  const mergeCommit = pr.merge_commit_sha!;
  const targets: string[] = findCherryPickTargets({
    base: pr.base.ref,
    head: pr.head.ref,
    labels: pr.labels.map((label) => label.name),
  }, localReleaseBranches());
  const pulls = targets.length > 0 ? await listMergedPulls(github, repo) : [];
  const pending: PendingTarget[] = [];

  for (const target of targets) {
    const existing = await listCherryPickPulls(input, target, 'all');
    if (existing.some((pull) => pull.state === 'open' || pull.merged_at)) {
      core.info(`${target}：cherry-pick の PR があります。`);
      continue;
    }
    if (containsChange(pulls, { number: pr.number, mergeCommit }, `refs/remotes/origin/${target}`)) {
      core.info(`${target}：変更はもう入っています。`);
      continue;
    }
    pending.push({ target, closedPullHeads: existing.map((pull) => pull.head.sha) });
    core.info(`${target}：これから cherry-pick します。`);
  }
  return { targets, pending, mergeCommit };
}

// 閉じた PR のブランチか、自動化が残したブランチだけを消す。
// 人が作ったブランチは残し、backport-action にその中身で PR を作ってもらう。
// 先頭 SHA を条件に削除するので、読み取った後に追加されたコミットは消さない。
export async function removeStaleBranches(
  { github, repo, prNumber, core, pending }: PullRequestInput & { core: Logger; pending: PendingTarget[] },
): Promise<void> {
  for (const { target, closedPullHeads } of pending) {
    const branch = cherryPickBranch(prNumber, target);
    const sha: string | null = await branchHead(github, repo, branch);
    if (!sha) continue;

    const { data: commit } = await github.rest.git.getCommit({ ...repo, commit_sha: sha });
    const fromClosedPull = closedPullHeads.includes(sha);
    const fromAutomation = commit.committer.email === AUTOMATION_COMMITTER;
    if (!fromClosedPull && !fromAutomation) continue;

    if (await deleteBranchIfAt(github, repo, branch, sha)) {
      core.info(`${target}：前の実行の残りの ${branch} を消しました。`);
    }
  }
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
