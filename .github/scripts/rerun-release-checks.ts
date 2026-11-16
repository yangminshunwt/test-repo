import type { WorkflowInput } from './github.ts';

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

// rerun-release-checks.yml から呼ぶ。PR のイベントが起きない変更に合わせて、最後のチェックをやり直す。
// リリースブランチの作成・削除ではラベルだけ、マージ先の VERSION の変更ではラベルと VERSION を確かめ直す。
// ラベルは変えない（ラベルは PR を出した人が決めるもの）。
async function rerunReleaseChecks({ github, context, core }: WorkflowInput) {
  const repo = context.repo;
  // push はそのブランチに向けた PR、リリースブランチの create・delete は main とリリースブランチに向けたすべての PR
  const pushedBranch = context.eventName === 'push' ? context.ref.replace(/^refs\/heads\//, '') : null;
  const pulls = (await github.paginate(github.rest.pulls.list, { ...repo, state: 'open', per_page: 100 })).filter((pull) =>
    pushedBranch ? pull.base.ref === pushedBranch : pull.base.ref === 'main' || pull.base.ref.startsWith('release/'),
  );
  const workflows = context.eventName === 'push' ? ['release-label-check.yml', 'version-check.yml'] : ['release-label-check.yml'];
  const rerunErrors = [];
  for (const pull of pulls) {
    for (const workflow of workflows) {
      const { data } = await github.rest.actions.listWorkflowRuns({ ...repo, workflow_id: workflow, head_sha: pull.head.sha, per_page: 1 });
      let run = data.workflow_runs[0];
      if (!run) continue; // まだ動いていない（これから動く実行は、今の状態で判定する）
      // 動いている実行は、変わる前の状態を読んだかもしれないので、終わるのを待ってからやり直す
      for (let attempt = 0; attempt < 60 && run.status !== 'completed'; attempt++) {
        await sleep(5000);
        run = (await github.rest.actions.getWorkflowRun({ ...repo, run_id: run.id })).data;
      }
      try {
        await github.rest.actions.reRunWorkflow({ ...repo, run_id: run.id });
        core.info(`#${pull.number}：${workflow} をやり直しました（実行 ${run.id}）。`);
      } catch (error) {
        rerunErrors.push(`#${pull.number} / ${workflow}（${(error as Error).message}）`);
      }
    }
  }
  if (rerunErrors.length > 0) {
    core.setFailed(`リリースルールのチェックをやり直せなかった PR があります。該当する workflow を再実行するか push して、チェックをやり直してください：${rerunErrors.join('、')}`);
  }
}

export { rerunReleaseChecks };
