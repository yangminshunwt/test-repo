import { mockCore, mockContext, mockGitHub } from './test-helpers.ts';
import { prepare } from './cherry-pick/workflow.ts';
import test from 'node:test';
import assert from 'node:assert/strict';

test('行き先がなければ、付けるラベルは出力しない', async () => {
  const github = mockGitHub({
    rest: {
      pulls: { get: async () => ({ data: { number: 10, merged: true, base: { ref: 'main' }, labels: [{ name: 'product-a/v1.3.0' }] } }) },
      repos: { listBranches() {} },
    },
    paginate: async () => [],
  });
  const outputs = new Map<string, unknown>();
  await prepare({
    github,
    context: mockContext({ repo: { owner: 'o', repo: 'r' } }),
    core: mockCore({ setOutput: (name: string, value: unknown) => outputs.set(name, value) }),
  }, { PR_NUMBER: '10' });
  assert.deepEqual(Object.fromEntries(outputs), { targets: '' });
});

test('prepare は PR の全製品の未アーカイブラベルと cherry-pick を action に渡す', async () => {
  const repo = { owner: 'o', repo: 'r' };
  const labels = [
    { name: 'product-a/v1.3.0', archived_at: '2026-11-12T00:00:00Z' },
    { name: 'product-b/v2.0.0', archived_at: null },
    { name: 'bug' },
    { name: 'needs review' },
    { name: 'old label', archived_at: '2026-11-12T00:00:00Z' },
  ];
  // 準備は読み取りだけ。対象 PR の検索、既存ラベルの同期、ラベル作成は行わない。
  const github = mockGitHub({
    rest: {
      pulls: { get: async () => ({ data: { number: 10, merged: true, base: { ref: 'main' }, labels } }) },
      repos: { listBranches() {} },
    },
    paginate: async (method: unknown) => {
      assert.equal(method, github.rest.repos.listBranches);
      return [{ name: 'release/product-a/v1.3.1' }];
    },
  });
  const outputs = new Map<string, unknown>();
  const workflow = {
    github,
    context: mockContext({ repo }),
    core: mockCore({ setOutput: (name: string, value: unknown) => outputs.set(name, value) }),
  };
  await prepare(workflow, { PR_NUMBER: '10' });
  assert.deepEqual(Object.fromEntries(outputs), {
    targets: 'release/product-a/v1.3.1',
    labels: 'cherry-pick,product-b/v2.0.0,bug,needs review',
  });

  for (const label of labels) label.archived_at = '2026-11-12T00:00:00Z';
  outputs.clear();
  await prepare(workflow, { PR_NUMBER: '10' });
  assert.deepEqual(Object.fromEntries(outputs), { targets: 'release/product-a/v1.3.1', labels: 'cherry-pick' });
});
