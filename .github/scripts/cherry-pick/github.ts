import type { GitHub, Repository } from '../github.ts';
import { cherryPickBranch } from '../rules.ts';

export interface PullRequestInput {
  github: GitHub;
  repo: Repository;
  prNumber: number;
}

// ラベルを設定するため、元の PR と行き先に対応する開いている PR を探す。
export function listCherryPickPulls(
  { github, repo, prNumber }: PullRequestInput,
  target: string,
) {
  return github.paginate(github.rest.pulls.list, {
    ...repo,
    state: 'open',
    head: `${repo.owner}:${cherryPickBranch(prNumber, target)}`,
    per_page: 100,
  });
}
