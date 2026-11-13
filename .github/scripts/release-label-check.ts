// release-label-check.yml から actions/github-script で呼ぶ。
import type { WorkflowInput } from './github.ts';
import { git, localReleaseBranches } from './github-helpers.ts';
import { checkReleaseLabels, findAffectedProducts, parseMergeQueueBranch, parseVersionFile } from './rules.ts';

async function check({ github, context, core }: WorkflowInput) {
  const mergeGroup = context.payload.merge_group;
  let pullRequestNumber: number;
  if (mergeGroup) {
    // キューのイベントには PR 番号がないため、ブランチ名から読む。
    pullRequestNumber = parseMergeQueueBranch(mergeGroup.head_ref)!;
  } else {
    pullRequestNumber = context.payload.pull_request!.number;
  }

  // 再実行でも現在のマージ先とラベルを使うため、PR を API で取り直す。
  const response = await github.rest.pulls.get({
    ...context.repo,
    pull_number: pullRequestNumber,
  });
  const pullRequest = response.data;
  const labels = pullRequest.labels.map((label) => label.name);

  let baseBranch: string;
  if (mergeGroup) {
    // キューが作られたマージ先を使う（refs/heads/main → main）。
    baseBranch = mergeGroup.base_ref.replace(/^refs\/heads\//, '');
  } else {
    baseBranch = pullRequest.base.ref;
  }

  const versionFileAfterMerge = git('show', 'HEAD:VERSION');
  const releaseBranches = localReleaseBranches();

  const matchedFilters: string[] = JSON.parse(process.env.AFFECTED_PRODUCTS!);
  const allProducts = Object.keys(parseVersionFile(versionFileAfterMerge));
  const hasUnlistedFiles = process.env.HAS_UNLISTED_FILES === 'true';
  const affected = findAffectedProducts({
    matched: matchedFilters,
    products: allProducts,
    hasUnlistedFiles,
  });

  const result = checkReleaseLabels({
    baseBranch,
    labels,
    affectedProducts: affected.products,
    versionFileAfterMerge,
    releaseBranches,
  });

  if (affected.reason) {
    core.warning(affected.reason);
  }
  for (const error of result.errors) {
    core.error(error);
  }
  if (result.errors.length > 0) {
    core.setFailed(`リリースラベルのルールを満たしていません（${result.errors.length} 件）。`);
  }
}

export { check };
