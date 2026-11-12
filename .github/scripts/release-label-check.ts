// release-label-check.yml と release-label-recheck.yml から actions/github-script で呼ぶ。
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

  const baseSha = process.env.BASE_SHA!;
  const versionFileAfterMerge = git('show', 'HEAD:VERSION');
  const versionFileBeforeMerge = git('show', `${baseSha}:VERSION`);
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
    versionFile: versionFileAfterMerge,
    baseVersionFile: versionFileBeforeMerge,
    branches: releaseBranches,
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

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

// release-label-recheck.yml から呼ぶ。ラベルのチェックの結果は、マージ先の VERSION と今あるリリースブランチでも変わるが、
// それらが変わっても PR のイベントは起きない。そこで、リリースブランチを作ったり削除したりしたとき（create・delete）と、
// main やリリースブランチの VERSION が変わったとき（push）に、影響する開いている PR の、今の先頭での最後のチェックをやり直す。
// ラベルは変えない（ラベルは PR を出した人が決めるもの）。
async function recheck({ github, context, core }: WorkflowInput) {
  const repo = context.repo;
  // push はそのブランチに向けた PR、リリースブランチの create・delete は main とリリースブランチに向けたすべての PR
  const pushed = context.eventName === 'push' ? context.ref.replace(/^refs\/heads\//, '') : null;
  const pulls = (await github.paginate(github.rest.pulls.list, { ...repo, state: 'open', per_page: 100 })).filter((pull) =>
    pushed ? pull.base.ref === pushed : pull.base.ref === 'main' || pull.base.ref.startsWith('release/'),
  );
  const failed = [];
  for (const pull of pulls) {
    const { data } = await github.rest.actions.listWorkflowRuns({ ...repo, workflow_id: 'release-label-check.yml', head_sha: pull.head.sha, per_page: 1 });
    let run = data.workflow_runs[0];
    if (!run) continue; // まだ動いていない（これから動く実行は、今の状態で判定する）
    // 動いている実行は、変わる前の状態を読んだかもしれないので、終わるのを待ってからやり直す
    for (let attempt = 0; attempt < 60 && run.status !== 'completed'; attempt++) {
      await sleep(5000);
      run = (await github.rest.actions.getWorkflowRun({ ...repo, run_id: run.id })).data;
    }
    try {
      await github.rest.actions.reRunWorkflow({ ...repo, run_id: run.id });
      core.info(`#${pull.number}：ラベルのチェックをやり直しました（実行 ${run.id}）。`);
    } catch (error) {
      failed.push(`#${pull.number}（${(error as Error).message}）`);
    }
  }
  if (failed.length > 0) {
    core.setFailed(`ラベルのチェックをやり直せなかった PR があります。ラベルを付け直すか push して、チェックをやり直してください：${failed.join('、')}`);
  }
}

export { check, recheck };
