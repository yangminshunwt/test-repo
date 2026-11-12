import { mockCore, mockContext, mockGitHub } from './test-helpers.ts';
import { prepare } from './cherry-pick/workflow.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { selectTargets, waitForMergeLink } from './cherry-pick/targets.ts';

const repo = { owner: 'o', repo: 'r' };
const core = { info() {} };
const notFound = () => Object.assign(new Error('Not Found'), { status: 404 });

test('行き先は現在のラベルとブランチから選び、既存 PR や Git 履歴は読まない', async () => {
  const targets = ['1.3.0', '1.3.1', '1.4.0'].map((version) => `release/product-a/v${version}`);
  const source = { number: 10, merged: true, merge_commit_sha: 'merge-sha', base: { ref: 'main' }, head: { ref: 'feature' }, labels: [{ name: 'product-a/v1.3.0' }] };
  const checked: string[] = [];
  // PR 一覧と GraphQL の API は用意しない。作業場所に Git の履歴も要らない。
  const github = mockGitHub({
    rest: {
      pulls: { get: async () => ({ data: source }) },
      repos: { listBranches() {} },
      git: { getRef: async ({ ref }: { ref: string }) => { checked.push(ref); throw notFound(); } },
    },
    paginate: async (method: unknown) => {
      assert.equal(method, github.rest.repos.listBranches);
      return ['main', 'feature', 'release/invalid', 'release/product-a/v1.2.9', 'release/product-b/v2.0.0', ...targets].map((name) => ({ name }));
    },
  });
  const input = { github, repo, prNumber: 10 };
  assert.deepEqual(await selectTargets(input), { targets, mergeCommit: 'merge-sha' });
  assert.deepEqual(checked, targets.map((target) => `heads/cherry-pick-10-to-${target}`));
  source.labels.push({ name: 'cherry-pick' });
  checked.length = 0;
  assert.deepEqual(await selectTargets(input), { targets: [], mergeCommit: 'merge-sha' });
  assert.deepEqual(checked, []);
  source.merged = false;
  await assert.rejects(selectTargets(input), /#10 はマージされていません/);
});

test('同名の作業ブランチはエラーにし、削除も復旧もせず action に行き先を渡さない', async () => {
  const target = 'release/product-a/v1.3.1';
  const source = { number: 10, merged: true, merge_commit_sha: 'merge-sha', base: { ref: 'main' }, head: { ref: 'feature' }, labels: [{ name: 'product-a/v1.3.0' }] };
  let branchExists = false;
  let apiError: Error | undefined;
  let associations = 0;
  const outputs = new Map<string, unknown>();
  const github = mockGitHub({
    rest: {
      pulls: { get: async () => ({ data: source }) },
      git: { getRef: async () => {
        if (apiError) throw apiError;
        if (!branchExists) throw notFound();
        return { data: { object: { sha: 'existing-head' } } };
      } },
      repos: {
        listBranches() {},
        listPullRequestsAssociatedWithCommit: async () => { associations++; return { data: [{ number: 10 }] }; },
      },
    },
    paginate: async () => [{ name: target }],
  });
  const workflow = {
    github,
    context: mockContext({ repo }),
    core: mockCore({ ...core, setOutput: (name: string, value: unknown) => outputs.set(name, value) }),
  };
  await prepare(workflow, { PR_NUMBER: '10' });
  assert.deepEqual(Object.fromEntries(outputs), { targets: target });
  assert.equal(associations, 1);

  outputs.clear();
  branchExists = true;
  await assert.rejects(prepare(workflow, { PR_NUMBER: '10' }), /cherry-pick-10-to-release\/product-a\/v1\.3\.1 はすでに存在します/);
  assert.equal(outputs.size, 0);
  assert.equal(associations, 1);

  apiError = new Error('Cannot read branch');
  await assert.rejects(prepare(workflow, { PR_NUMBER: '10' }), /Cannot read branch/);
  assert.equal(outputs.size, 0);
  apiError = undefined;

  source.labels.push({ name: 'cherry-pick' });
  await prepare(workflow, { PR_NUMBER: '10' });
  assert.deepEqual(Object.fromEntries(outputs), { targets: '' });
  assert.equal(associations, 1);
});

test('マージコミットの関連付け：GitHub に反映されるまで待つ', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let calls = 0;
  const github = mockGitHub({ rest: { repos: { listPullRequestsAssociatedWithCommit: async () => ({ data: ++calls === 1 ? [] : [{ number: 10 }] }) } } });
  const waiting = waitForMergeLink({ github, repo, core, prNumber: 10, mergeCommit: 'merge-sha' });
  await setImmediate();
  assert.equal(calls, 1);
  t.mock.timers.tick(5000);
  await waiting;
  assert.equal(calls, 2);
});

test('マージコミットの関連付け：未反映が続けば失敗し、次のステップには進めない', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let calls = 0;
  const github = mockGitHub({ rest: { repos: { listPullRequestsAssociatedWithCommit: async () => { calls++; return { data: [] }; } } } });
  const rejected = assert.rejects(waitForMergeLink({ github, repo, core, prNumber: 10, mergeCommit: 'merge-sha' }), /結び付きが GitHub に反映されませんでした/);
  for (let attempt = 0; attempt < 30; attempt++) {
    await setImmediate();
    t.mock.timers.tick(5000);
  }
  await rejected;
  assert.equal(calls, 30);
});
