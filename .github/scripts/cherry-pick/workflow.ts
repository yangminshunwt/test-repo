import type { WorkflowInput } from '../github.ts';
import { compareVersions, extractReleaseLabels, parseReleaseBranch } from '../rules.ts';

// REST は archived_at を返すが、@actions/github のラベル型にはまだ含まれていない。
interface SourceLabel {
  name: string;
  archived_at?: string | null;
}

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
  if (targets.length === 0) return;

  const originalLabels: SourceLabel[] = await github.paginate(github.rest.issues.listLabelsOnIssue, {
    ...repo,
    issue_number: pr.number,
    per_page: 100,
  });
  const activeLabels = originalLabels.filter((label) => !label.archived_at).map((label) => label.name);
  core.setOutput('labels', ['cherry-pick', ...activeLabels].join(','));
}
