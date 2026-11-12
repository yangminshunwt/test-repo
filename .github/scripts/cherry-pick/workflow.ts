import type { WorkflowInput } from '../github.ts';
import { selectTargets, removeStaleBranches, waitForMergeLink } from './targets.ts';
import { labelPullRequests } from './labels.ts';
import { reportFailures, type WorkflowResult } from './report.ts';

// YAML との受け渡しはここにまとめ、各処理には引数で渡す。
export async function prepare({ github, context, core }: WorkflowInput, env = process.env): Promise<void> {
  const input = { github, repo: context.repo, core, prNumber: Number(env.PR_NUMBER) };
  const selection = await selectTargets(input);
  core.setOutput('targets', selection.targets.join(' '));

  if (selection.pending.length > 0) {
    await removeStaleBranches({ ...input, pending: selection.pending });
    await waitForMergeLink({ ...input, mergeCommit: selection.mergeCommit });
  }
  // 準備が終わってから、backport-action に渡す行き先を出力する。
  core.setOutput('branches', selection.pending.map(({ target }) => target).join(' '));
}

export async function label({ github, context }: WorkflowInput, env = process.env): Promise<void> {
  await labelPullRequests({
    github,
    repo: context.repo,
    prNumber: Number(env.PR_NUMBER),
    targets: env.TARGETS!.split(' ').filter(Boolean),
  });
}

export async function report({ github, context, core }: WorkflowInput, env = process.env): Promise<void> {
  // ステップの結果は、YAML の env で GitHub Actions から受け取る。
  const result = {
    appTokenOutcome: env.APP_TOKEN_OUTCOME,
    jobStatus: env.JOB_STATUS,
    backportOutcome: env.BACKPORT_OUTCOME,
    wasSuccessful: env.WAS_SUCCESSFUL,
    results: env.RESULTS,
  } as WorkflowResult;
  const reasons = await reportFailures({
    github,
    repo: context.repo,
    prNumber: Number(env.PR_NUMBER),
    runUrl: `${context.serverUrl}/${context.repo.owner}/${context.repo.repo}/actions/runs/${context.runId}`,
    result,
  });
  if (reasons.length > 0) core.setFailed(reasons.join('\n'));
}
