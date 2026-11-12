import { belongsTo, type LabeledPullRequest } from './rules.ts';
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

const BRANCHES = [
  'release/product-a/v1.3.0',
  'release/product-a/v1.4.0',
  'release/product-b/v1.4.0',
];

// cherry-pick 先（開発ルールの Q＆A と同じ状況：main は v1.5.0、product-a のリリースブランチは v1.3.0 と v1.4.0）
async function targets({ base = 'main', head = 'feature', labels, branches = BRANCHES }: Partial<LabeledPullRequest> & { labels: string[]; branches?: string[] }): Promise<string[]> {
  const github = mockGitHub({
    rest: {
      pulls: { get: async () => ({ data: { number: 10, merged: true, base: { ref: base }, head: { ref: head }, labels: labels.map((name) => ({ name })) } }) },
      repos: { listBranches() {} },
    },
    paginate: async () => branches.map((name) => ({ name })),
  });
  let output = '';
  await prepare({
    github,
    context: mockContext({ repo: { owner: 'o', repo: 'r' } }),
    core: mockCore({ setOutput: (_name: string, value: unknown) => { output = String(value); } }),
  }, { PR_NUMBER: '10' });
  return output.split(' ').filter(Boolean);
}

test('cherry-pick：main で、main のバージョンのラベルならどこにも cherry-pick しない', async () => {
  assert.deepEqual(await targets({ labels: ['product-a/v1.5.0'] }), []);
});

test('cherry-pick：main で、リリースブランチのバージョンのラベルなら、そのバージョン以上のリリースブランチすべてに入れる', async () => {
  assert.deepEqual(await targets({ labels: ['product-a/v1.3.0'] }), ['release/product-a/v1.3.0', 'release/product-a/v1.4.0']);
  assert.deepEqual(await targets({ labels: ['product-a/v1.4.0'] }), ['release/product-a/v1.4.0']);
  // ラベルのバージョンのブランチがなくても（リリース済みなど）、それ以上のブランチには入れる
  assert.deepEqual(await targets({ labels: ['product-a/v1.2.0'] }), ['release/product-a/v1.3.0', 'release/product-a/v1.4.0']);
  // すでに存在する修正フェーズのブランチにも候補の PR を作る
  assert.deepEqual(await targets({ labels: ['product-a/v1.3.0'], branches: [...BRANCHES, 'release/product-a/v1.3.1'] }), [
    'release/product-a/v1.3.0',
    'release/product-a/v1.3.1',
    'release/product-a/v1.4.0',
  ]);
});

test('cherry-pick：リリースブランチで、マージ先より古いバージョンのブランチにだけ入れる（Q＆A の 3 パターン）', async () => {
  assert.deepEqual(await targets({ base: 'release/product-a/v1.3.0', labels: ['product-a/v1.3.0'] }), []);
  assert.deepEqual(await targets({ base: 'release/product-a/v1.4.0', labels: ['product-a/v1.4.0'] }), []);
  assert.deepEqual(await targets({ base: 'release/product-a/v1.4.0', labels: ['product-a/v1.3.0'] }), ['release/product-a/v1.3.0']);
});

test('cherry-pick：共有コードの変更は、製品ごとに入れる', async () => {
  assert.deepEqual(await targets({ labels: ['product-a/v1.3.0', 'product-b/v1.4.0'] }), ['release/product-a/v1.3.0', 'release/product-a/v1.4.0', 'release/product-b/v1.4.0']);
});

test('cherry-pick：cherry-pick の PR がマージされても、先へは広がらない', async () => {
  for (const head of ['cherry-pick-12-to-release/product-a/v1.4.0', 'renamed-branch']) {
    assert.deepEqual(await targets({ base: 'release/product-a/v1.4.0', head, labels: ['product-a/v1.3.0', 'cherry-pick'] }), []);
  }
});

test('cherry-pick：修正バージョンのラベルも、それ以降の通常・修正リリースへ送る', async () => {
  const branches = [...BRANCHES, 'release/product-a/v1.3.1', 'release/product-a/v1.3.2'];
  assert.deepEqual(await targets({ labels: ['product-a/v1.3.1'], branches }), ['release/product-a/v1.3.1', 'release/product-a/v1.3.2', 'release/product-a/v1.4.0']);
});

test('cherry-pick：hotfix の候補にしても rc で必須にはせず、マージ先の上限も守る', async () => {
  const branches = [...BRANCHES, 'release/product-a/v1.3.1', 'release/product-a/v1.4.1'];
  const pull = { base: 'release/product-a/v1.4.0', head: 'fix', labels: ['product-a/v1.3.0'] };
  assert.deepEqual(await targets({ ...pull, branches }), ['release/product-a/v1.3.0', 'release/product-a/v1.3.1']);
  assert.equal(belongsTo(pull, 'product-a', '1.3.1'), false);
  assert.deepEqual(await targets({ ...pull, base: 'feature', branches }), []);
});

test('cherry-pick：リリースブランチへの PR に付いた他の製品のラベルは無視する', async () => {
  assert.deepEqual(await targets({ base: 'release/product-a/v1.4.0', labels: ['product-a/v1.4.0', 'product-b/v1.4.0'] }), []);
});

test('cherry-pick：main で、VERSION を上げる前に作った同じバージョンのリリースブランチにも入れる', async () => {
  const branches = [...BRANCHES, 'release/product-a/v1.5.0'];
  assert.deepEqual(await targets({ labels: ['product-a/v1.5.0'], branches }), ['release/product-a/v1.5.0']);
  assert.deepEqual(await targets({ labels: ['product-a/v1.4.0'], branches }), ['release/product-a/v1.4.0', 'release/product-a/v1.5.0']);
});
