import type { WorkflowInput } from '../github.ts';
import { selectTargets, waitForMergeLink } from './targets.ts';
import { labelPullRequests } from './labels.ts';

// YAML との受け渡しはここにまとめ、各処理には引数で渡す。
export async function prepare({ github, context, core }: WorkflowInput, env = process.env): Promise<void> {
  const input = { github, repo: context.repo, core, prNumber: Number(env.PR_NUMBER) };
  const { targets, mergeCommit } = await selectTargets(input);
  if (targets.length > 0) await waitForMergeLink({ ...input, mergeCommit });
  // 作業ブランチの存在確認と関連付け待ちが済んでから、action に行き先を渡す。
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
