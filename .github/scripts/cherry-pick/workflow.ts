import type { WorkflowInput } from '../github.ts';
import { selectTargets } from './targets.ts';
import { labelPullRequests } from './labels.ts';

// YAML との受け渡しはここにまとめ、各処理には引数で渡す。
export async function prepare({ github, context, core }: WorkflowInput, env = process.env): Promise<void> {
  const targets = await selectTargets({ github, repo: context.repo, prNumber: Number(env.PR_NUMBER) });
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
