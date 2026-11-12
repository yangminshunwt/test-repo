import { mockGitHub } from './test-helpers.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { labelPullRequests } from './cherry-pick/labels.ts';

test('cherry-pick の PR ごとに元の全ラベルと cherry-pick を付け、やり直しても重複しない', async () => {
  const targets = ['release/product-a/v1.4.0', 'release/product-b/v2.0.0'];
  const repo = { owner: 'o', repo: 'r' };
  const labels = (names: string[]) => names.map((name) => ({ name }));
  const pulls = [
    { number: 11, head: 'cherry-pick-10-to-release/product-a/v1.4.0', labels: labels(['reviewed', 'product-a/v1.4.0', 'product-b/v2.0.0']) },
    { number: 12, head: 'cherry-pick-10-to-release/product-b/v2.0.0', labels: [] },
  ];
  let marker: { name: string } | null = null;
  let created = 0;
  const archived = new Set();
  const github = mockGitHub({
    rest: {
      pulls: {
        list: async () => {},
      },
      issues: {
        listLabelsOnIssue: async () => {},
        getLabel: async ({ name }: { name: string }) => {
          assert.equal(name, 'cherry-pick');
          if (!marker) throw Object.assign(new Error('Not Found'), { status: 404 });
          return { data: marker };
        },
        createLabel: async (label: { name: string }) => { marker = label; created++; },
        setLabels: async ({ issue_number, labels: names }: { issue_number: number; labels: string[] }) => {
          assert.ok(marker);
          pulls.find((pull) => pull.number === issue_number)!.labels = labels(names);
        },
      },
    },
    paginate: async (method: unknown, args: { issue_number?: number; state?: string; head?: string }) => {
      if (method === github.rest.issues.listLabelsOnIssue) {
        assert.equal(args.issue_number, 10);
        return labels(['product-a/v1.3.0', 'product-b/v2.0.0', 'bug']).map((label) => ({
          ...label, archived_at: archived.has(label.name) ? '2026-11-12T00:00:00Z' : null,
        }));
      }
      assert.equal(method, github.rest.pulls.list);
      assert.equal(args.state, 'open');
      return pulls.filter((pull) => args.head === `${repo.owner}:${pull.head}`);
    },
  });
  for (let attempt = 0; attempt < 2; attempt++) {
    await labelPullRequests({ github, repo, prNumber: 10, targets });
    assert.deepEqual(pulls[0].labels.map(({ name }) => name).sort(), ['reviewed', 'cherry-pick', 'product-a/v1.3.0', 'product-b/v2.0.0', 'bug'].sort());
    assert.deepEqual(pulls[1].labels.map(({ name }) => name).sort(), ['cherry-pick', 'product-a/v1.3.0', 'product-b/v2.0.0', 'bug'].sort());
    assert.equal(created, 1);
  }
  // アーカイブ済みのラベルは再実行でも付け直さず、アーカイブ解除の API も呼ばない。
  archived.add('product-a/v1.3.0');
  await labelPullRequests({ github, repo, prNumber: 10, targets });
  assert.deepEqual(pulls[0].labels.map(({ name }) => name).sort(), ['reviewed', 'cherry-pick', 'bug', 'product-b/v2.0.0'].sort());
  assert.deepEqual(pulls[1].labels.map(({ name }) => name).sort(), ['cherry-pick', 'bug', 'product-b/v2.0.0'].sort());
});
