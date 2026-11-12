import type * as core from '@actions/core';
import type { GitHub, Repository } from '../github.ts';
import { cherryPickBranch } from '../rules.ts';

export interface PullRequestInput {
  github: GitHub;
  repo: Repository;
  prNumber: number;
}

export type Logger = Pick<typeof core, 'info'>;

// 作り直した PR も、手で作った PR も、元の PR と行き先が同じなら同じブランチ名で探す。
export function listCherryPickPulls(
  { github, repo, prNumber }: PullRequestInput,
  target: string,
  state: 'open' | 'all',
) {
  return github.paginate(github.rest.pulls.list, {
    ...repo,
    state,
    head: `${repo.owner}:${cherryPickBranch(prNumber, target)}`,
    per_page: 100,
  });
}
