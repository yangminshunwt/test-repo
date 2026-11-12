import { findCherryPickTargets } from '../rules.ts';
import type { PullRequestInput } from './github.ts';

// 現在のリリースブランチから行き先を選ぶ。既存 PR や取り込み履歴は調べない。
export async function selectTargets({ github, repo, prNumber }: PullRequestInput): Promise<string[]> {
  const { data: pr } = await github.rest.pulls.get({ ...repo, pull_number: prNumber });
  if (!pr.merged) throw new Error(`#${pr.number} はマージされていません。`);

  const branches = await github.paginate(github.rest.repos.listBranches, { ...repo, per_page: 100 });
  return findCherryPickTargets({
    base: pr.base.ref,
    head: pr.head.ref,
    labels: pr.labels.map((label) => label.name),
  }, branches.map((branch) => branch.name));
}
