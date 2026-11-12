import { mockCore, mockContext, mockGitHub } from './test-helpers.ts';
import { prepare } from './cherry-pick/workflow.ts';
import test from 'node:test';
import assert from 'node:assert/strict';

test('prepare は現在のラベルとブランチから行き先だけを出力する', async () => {
  const repo = { owner: 'o', repo: 'r' };
  const targets = ['1.3.0', '1.3.1', '1.4.0'].map((version) => `release/product-a/v${version}`);
  const source = { number: 10, merged: true, base: { ref: 'main' }, head: { ref: 'feature' }, labels: [{ name: 'product-a/v1.3.0' }] };
  const outputs = new Map<string, unknown>();
  // 準備に必要な API だけを用意する。コミットの関連付けや作業ブランチの個別取得は行わない。
  const github = mockGitHub({
    rest: {
      pulls: { get: async () => ({ data: source }) },
      repos: { listBranches() {} },
    },
    paginate: async (method: unknown) => {
      assert.equal(method, github.rest.repos.listBranches);
      return [
        'main', 'feature', 'release/invalid', 'release/product-a/v1.2.9', 'release/product-b/v2.0.0',
        ...targets,
        // 同名の作業ブランチがあっても行き先から除外せず、action に渡す。
        'cherry-pick-10-to-release/product-a/v1.3.1',
      ].map((name) => ({ name }));
    },
  });
  const workflow = {
    github,
    context: mockContext({ repo }),
    core: mockCore({ setOutput: (name: string, value: unknown) => outputs.set(name, value) }),
  };
  await prepare(workflow, { PR_NUMBER: '10' });
  assert.deepEqual(Object.fromEntries(outputs), { targets: targets.join(' ') });

  source.labels.push({ name: 'cherry-pick' });
  await prepare(workflow, { PR_NUMBER: '10' });
  assert.deepEqual(Object.fromEntries(outputs), { targets: '' });

  outputs.clear();
  source.merged = false;
  await assert.rejects(prepare(workflow, { PR_NUMBER: '10' }), /#10 はマージされていません/);
  assert.equal(outputs.size, 0);
});
