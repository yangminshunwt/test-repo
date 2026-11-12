'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { labelPullRequests } = require('./cherry-pick.js');

test('cherry-pick の PR ごとに元の製品ラベルと cherry-pick を付け、やり直しても重複しない', async (t) => {
  const env = { PR_NUMBER: process.env.PR_NUMBER, TARGETS: process.env.TARGETS };
  t.after(() => {
    for (const [name, value] of Object.entries(env)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });
  process.env.PR_NUMBER = '10';
  process.env.TARGETS = 'release/product-a/v1.4.0 release/product-b/v2.0.0';
  const repo = { owner: 'o', repo: 'r' };
  const labels = (names) => names.map((name) => ({ name }));
  const pulls = [
    { number: 11, head: 'cherry-pick-10-to-release/product-a/v1.4.0', labels: labels(['bug', 'product-a/v1.4.0', 'product-b/v2.0.0']) },
    { number: 12, head: 'cherry-pick-10-to-release/product-b/v2.0.0', labels: [] },
  ];
  let marker = null;
  let created = 0;
  const archived = new Set();
  const github = {
    rest: {
      pulls: {
        list: async () => {},
      },
      issues: {
        listLabelsOnIssue: async () => {},
        getLabel: async ({ name }) => {
          assert.equal(name, 'cherry-pick');
          if (!marker) throw Object.assign(new Error('Not Found'), { status: 404 });
          return { data: marker };
        },
        createLabel: async (label) => { marker = label; created++; },
        setLabels: async ({ issue_number, labels: names }) => {
          assert.ok(marker);
          pulls.find((pull) => pull.number === issue_number).labels = labels(names);
        },
      },
    },
    paginate: async (method, args) => {
      if (method === github.rest.issues.listLabelsOnIssue) {
        assert.equal(args.issue_number, 10);
        return labels(['product-a/v1.3.0', 'product-b/v2.0.0']).map((label) => ({
          ...label, archived_at: archived.has(label.name) ? '2026-11-12T00:00:00Z' : null,
        }));
      }
      assert.equal(method, github.rest.pulls.list);
      assert.equal(args.state, 'open');
      return pulls.filter((pull) => args.head === `${repo.owner}:${pull.head}`);
    },
  };
  for (let attempt = 0; attempt < 2; attempt++) {
    await labelPullRequests({ github, context: { repo } });
    assert.deepEqual(pulls[0].labels, labels(['bug', 'cherry-pick', 'product-a/v1.3.0']));
    assert.deepEqual(pulls[1].labels, labels(['cherry-pick', 'product-b/v2.0.0']));
    assert.equal(created, 1);
  }
  // アーカイブ済みのラベルは再実行でも付け直さず、アーカイブ解除の API も呼ばない。
  archived.add('product-a/v1.3.0');
  await labelPullRequests({ github, context: { repo } });
  assert.deepEqual(pulls[0].labels, labels(['bug', 'cherry-pick']));
  assert.deepEqual(pulls[1].labels, labels(['cherry-pick', 'product-b/v2.0.0']));
});
