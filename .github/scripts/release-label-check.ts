// release-label-check.yml と ci.yml から actions/github-script で呼ぶ。
import type { WorkflowInput } from './github.ts';
import { git, localReleaseBranches } from './github-helpers.ts';
import { checkReleaseLabels, findAffectedProducts, parseMergeQueueBranch, parseVersionFile } from './rules.ts';

// 差分と変更前の VERSION は、PR のテスト用マージコミットの第 1 親（キューでは base_sha）から調べる。
function findBase({ context, core }: Pick<WorkflowInput, 'context' | 'core'>) {
  core.setOutput('base_sha', context.payload.merge_group?.base_sha ?? git('rev-parse', 'HEAD^1'));
}

async function check({ github, context, core }: WorkflowInput) {
  // 再実行でも現在のマージ先とラベルを使う。
  const group = context.payload.merge_group;
  const number = group ? parseMergeQueueBranch(group.head_ref) : context.payload.pull_request!.number;
  const { data: pr } = await github.rest.pulls.get({ ...context.repo, pull_number: number! });
  const baseBranch = group ? group.base_ref.replace(/^refs\/heads\//, '') : pr.base.ref;
  const labels = pr.labels.map((label) => label.name);
  const env = process.env;
  const versionFile = git('show', 'HEAD:VERSION');
  const affected = findAffectedProducts({
    matched: JSON.parse(env.AFFECTED_PRODUCTS!),
    products: Object.keys(parseVersionFile(versionFile)),
    hasUnlistedFiles: env.HAS_UNLISTED_FILES === 'true',
  });
  const { errors } = checkReleaseLabels({
    baseBranch,
    labels,
    affectedProducts: affected.products,
    versionFile,
    baseVersionFile: git('show', `${env.BASE_SHA}:VERSION`),
    branches: localReleaseBranches(),
  });

  if (affected.reason) core.warning(affected.reason);
  for (const error of errors) core.error(error);
  if (errors.length > 0) core.setFailed(`リリースラベルのルールを満たしていません（${errors.length} 件）。`);
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

export { findBase, check, recheck };
