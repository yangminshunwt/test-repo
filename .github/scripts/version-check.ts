// version-check.yml から actions/github-script で呼ぶ。
import type { WorkflowInput } from './github.ts';
import { git } from './github-helpers.ts';
import { checkVersions } from './rules.ts';

async function check({ github, context, core }: WorkflowInput) {
  const mergeGroup = context.payload.merge_group;
  let baseBranch: string;
  if (mergeGroup) {
    baseBranch = mergeGroup.base_ref.replace(/^refs\/heads\//, '');
  } else {
    // 再実行でも現在のマージ先を使う。ラベルは VERSION のチェックには使わない。
    const { data: pullRequest } = await github.rest.pulls.get({
      ...context.repo,
      pull_number: context.payload.pull_request!.number,
    });
    baseBranch = pullRequest.base.ref;
  }

  const result = checkVersions({
    baseBranch,
    versionFileAfterMerge: git('show', 'HEAD:VERSION'),
    versionFileBeforeMerge: git('show', `${process.env.BASE_SHA}:VERSION`),
  });
  for (const error of result.errors) {
    core.error(error);
  }
  if (result.errors.length > 0) {
    core.setFailed(`VERSION のルールを満たしていません（${result.errors.length} 件）。`);
  }
}

export { check };
