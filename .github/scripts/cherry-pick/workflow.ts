import type { WorkflowInput } from '../github.ts';
import { compareVersions, extractReleaseLabels, parseReleaseBranch } from '../rules.ts';
import { labelPullRequests } from './labels.ts';

// YAML との受け渡しはここにまとめ、各処理には引数で渡す。
export async function prepare({ github, context, core }: WorkflowInput, env = process.env): Promise<void> {
  const repo = context.repo;
  const { data: pr } = await github.rest.pulls.get({ ...repo, pull_number: Number(env.PR_NUMBER) });
  if (!pr.merged) throw new Error(`#${pr.number} はマージされていません。`);

  const labels = pr.labels.map((label) => label.name);
  if (labels.includes('cherry-pick')) {
    core.setOutput('targets', '');
    return;
  }

  const base = parseReleaseBranch(pr.base.ref);
  const branches = await github.paginate(github.rest.repos.listBranches, { ...repo, per_page: 100 });
  const targets = branches
    .map((branch) => branch.name)
    .filter((name) => {
      const branch = parseReleaseBranch(name);
      if (!branch || name === pr.base.ref) return false;
      if (pr.base.ref !== 'main') {
        if (!base || base.product !== branch.product) return false;
        if (compareVersions(branch.version, base.version) > 0) return false;
      }
      return extractReleaseLabels(labels, [branch.product]).some((label) => compareVersions(label.version, branch.version) <= 0);
    })
    .sort();
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
