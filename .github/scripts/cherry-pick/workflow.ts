import type { WorkflowInput } from '../github.ts';
import { findCherryPickTargets } from '../rules.ts';
import { labelPullRequests } from './labels.ts';

// YAML との受け渡しはここにまとめ、各処理には引数で渡す。
export async function prepare({ github, context, core }: WorkflowInput, env = process.env): Promise<void> {
  const repo = context.repo;
  const { data: pr } = await github.rest.pulls.get({ ...repo, pull_number: Number(env.PR_NUMBER) });
  if (!pr.merged) throw new Error(`#${pr.number} はマージされていません。`);

  const branches = await github.paginate(github.rest.repos.listBranches, { ...repo, per_page: 100 });
  const targets = findCherryPickTargets({
    base: pr.base.ref,
    head: pr.head.ref,
    labels: pr.labels.map((label) => label.name),
  }, branches.map((branch) => branch.name));
  core.setOutput('targets', targets.join(' '));
}

export async function label({ github, context }: WorkflowInput, env = process.env): Promise<void> {
  await labelPullRequests({
    github,
    repo: context.repo,
    prNumber: Number(env.PR_NUMBER),
    targets: env.TARGETS!.split(' ').filter(Boolean),
  });
}
