import { cherryPickBranch } from '../rules.ts';
import type { PullRequestInput } from './github.ts';

type StepOutcome = 'success' | 'failure' | 'cancelled' | 'skipped' | '';

export interface WorkflowResult {
  appTokenOutcome: StepOutcome;
  jobStatus: StepOutcome;
  backportOutcome: StepOutcome;
  wasSuccessful: 'true' | 'false' | '';
  results: string;
}

// backport-action は行き先ごとの失敗を出力に記録し、ステップ自体は成功にすることがある。
export function failureReasons(result: WorkflowResult): string[] {
  const reasons: string[] = [];
  if (result.appTokenOutcome === 'failure') {
    reasons.push('GitHub App のトークンを作れませんでした。App とリポジトリの設定（AUTOMATION_APP_CLIENT_ID・AUTOMATION_APP_PRIVATE_KEY）を確かめてください。');
  } else if (result.jobStatus === 'failure') {
    reasons.push('途中のステップが失敗しました。実行の記録を確かめてください。');
  }
  // コンフリクトを含む draft PR を作れた行き先は true なので、ここでは失敗にしない。
  for (const line of result.results.split('\n')) {
    if (line.endsWith('=false')) reasons.push(`${line.slice(0, -'=false'.length)} に cherry-pick できませんでした。`);
  }
  // マージコミットを検出するなどして行き先を処理せずに終わると、結果自体が出ない。
  // すでに入っている変更をすべて飛ばした場合は、was_successful が出る。
  if (result.backportOutcome === 'success' && !result.wasSuccessful) {
    reasons.push('backport-action が結果を出さずに終わりました。元の PR の backport-action のコメントと、実行の記録を確かめてください。');
  }
  return reasons;
}

// 元の PR の作者とマージした人へ、新しいコメントで知らせる。
// backport-action の既存コメントの更新だけでは、通知が届かないため。
export async function reportFailures(
  { github, repo, prNumber, runUrl, result }: PullRequestInput & { runUrl: string; result: WorkflowResult },
): Promise<string[]> {
  const reasons = failureReasons(result);
  if (reasons.length === 0) return [];

  const { data: pr } = await github.rest.pulls.get({ ...repo, pull_number: prNumber });
  if (!pr.merged) return []; // 手動実行で未マージの PR を指定した人には、実行結果で知らせる。
  const mentions = [...new Set([pr.user?.login, pr.merged_by?.login].filter(Boolean))]
    .map((login) => `@${login}`).join(' ');
  await github.rest.issues.createComment({
    ...repo,
    issue_number: pr.number,
    body: [`${mentions} cherry-pick を終えられませんでした（[実行の記録](${runUrl})）。`, '', ...reasons.map((reason) => `- ${reason}`), '', manualGuide(pr.number)].join('\n'),
  });
  return reasons;
}

function manualGuide(number: number): string {
  return [
    `手で cherry-pick するときは、行き先のブランチから \`${cherryPickBranch(number, '<行き先のブランチ>')}\` という名前の作業ブランチを作って cherry-pick し、元の PR のアーカイブされていないラベルと \`cherry-pick\` ラベルを付けて PR を出してください。リリースラベルのバージョンは変えません。アーカイブ済みのラベルは付けず、アーカイブも解除しません。このブランチ名は元の PR との対応に、\`cherry-pick\` ラベルは再び cherry-pick しないために使います。`,
    `原因を直して自動でやり直すときは、Actions の「Cherry-Pick」→「Run workflow」で、PR の番号 ${number} を指定してください。`,
    '行き先のブランチがもうない（リリースして削除された）ときは、手での cherry-pick もやり直しも要りません（ブランチも作り直さないでください）。変更はそのリリースには入っていません。修正フェーズに入れる変更は、その修正バージョンを指定して PR を出してください。',
  ].join('\n\n');
}
