import test from 'node:test';
import assert from 'node:assert/strict';
import { rerunReleaseChecks } from './rerun-release-checks.ts';
import { mockCore, mockContext, mockGitHub } from './test-helpers.ts';

test('VERSION の push は対象ブランチの両チェック、release の作成・削除はラベルだけをやり直す', async () => {
  const pulls = [
    { number: 1, base: { ref: 'main' }, head: { sha: 'main-pr' } },
    { number: 2, base: { ref: 'release/product-a/v1.4.1' }, head: { sha: 'release-pr' } },
    { number: 3, base: { ref: 'feature' }, head: { sha: 'feature-pr' } },
  ];
  for (const eventName of ['push', 'create', 'delete']) {
    const queries: string[] = [];
    const reruns: number[] = [];
    const failures: string[] = [];
    const github = mockGitHub({
      paginate: async () => pulls,
      rest: {
        pulls: { list() {} },
        actions: {
          listWorkflowRuns: async ({ workflow_id, head_sha }: { workflow_id: string; head_sha: string }) => {
            queries.push(`${head_sha}/${workflow_id}`);
            return { data: { workflow_runs: [{ id: queries.length, status: 'completed' }] } };
          },
          reRunWorkflow: async ({ run_id }: { run_id: number }) => { reruns.push(run_id); },
        },
      },
    });
    await rerunReleaseChecks({
      github,
      context: mockContext({ repo: { owner: 'o', repo: 'r' }, eventName, ref: 'refs/heads/release/product-a/v1.4.1' }),
      core: mockCore({ info() {}, setFailed: (message: string) => failures.push(message) }),
    });
    const expected = eventName === 'push'
      ? ['release-pr/release-label-check.yml', 'release-pr/version-check.yml']
      : ['main-pr/release-label-check.yml', 'release-pr/release-label-check.yml'];
    assert.deepEqual(queries, expected);
    assert.equal(reruns.length, queries.length);
    assert.deepEqual(failures, []);
  }
});

test('ラベルの再実行に失敗しても VERSION は再実行し、失敗した workflow を知らせる', async () => {
  const reruns: number[] = [];
  const failures: string[] = [];
  await rerunReleaseChecks({
    github: mockGitHub({
      paginate: async () => [{ number: 1, base: { ref: 'main' }, head: { sha: 'pr-head' } }],
      rest: {
        pulls: { list() {} },
        actions: {
          listWorkflowRuns: async ({ workflow_id }: { workflow_id: string }) => ({
            data: { workflow_runs: [{ id: workflow_id === 'release-label-check.yml' ? 10 : 20, status: 'completed' }] },
          }),
          reRunWorkflow: async ({ run_id }: { run_id: number }) => {
            reruns.push(run_id);
            if (run_id === 10) throw new Error('Cannot rerun');
          },
        },
      },
    }),
    context: mockContext({ repo: { owner: 'o', repo: 'r' }, eventName: 'push', ref: 'refs/heads/main' }),
    core: mockCore({ info() {}, setFailed: (message: string) => failures.push(message) }),
  });
  assert.deepEqual(reruns, [10, 20]);
  assert.equal(failures.length, 1);
  assert.match(failures[0], /#1 \/ release-label-check.yml/);
  assert.doesNotMatch(failures[0], /version-check.yml/);
});
