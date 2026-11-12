import { found } from '../github-helpers.ts';
import { cherryPickLabels } from '../rules.ts';
import { listCherryPickPulls, type PullRequestInput } from './github.ts';

// REST は archived_at を返すが、@actions/github のラベル型にはまだ含まれていない。
interface SourceLabel {
  name: string;
  archived_at?: string | null;
}

// 元の PR のラベルをすべて引き継ぎ、cherry-pick を付ける。
// アーカイブ済みラベルは付けられないので除外し、アーカイブも解除しない。
// 開いている対象 PR に設定し、リリースラベル以外は残す。
export async function labelPullRequests(
  input: PullRequestInput & { targets: string[] },
): Promise<void> {
  const { github, repo, prNumber, targets } = input;
  const pulls = [];
  for (const target of targets) pulls.push(...await listCherryPickPulls(input, target));
  if (pulls.length === 0) return; // 空変更などで PR がなければ、ラベルを読み書きしない。

  const originalLabels: SourceLabel[] = await github.paginate(github.rest.issues.listLabelsOnIssue, {
    ...repo,
    issue_number: prNumber,
    per_page: 100,
  });
  const labels = originalLabels.filter((label) => !label.archived_at).map((label) => label.name);

  if (!(await found(github.rest.issues.getLabel({ ...repo, name: 'cherry-pick' })))) {
    await github.rest.issues.createLabel({
      ...repo,
      name: 'cherry-pick',
      color: '1d76db',
      description: 'Cherry-pick pull request',
    });
  }

  for (const pull of pulls) {
    await github.rest.issues.setLabels({
      ...repo,
      issue_number: pull.number,
      labels: cherryPickLabels(labels, pull.labels.map((label) => label.name)),
    });
  }
}
