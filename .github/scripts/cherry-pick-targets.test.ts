import { mockCore, mockContext, mockGitHub } from './test-helpers.ts';
import { prepare } from './cherry-pick/workflow.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setImmediate } from 'node:timers/promises';
import { selectTargets, removeStaleBranches, waitForMergeLink } from './cherry-pick/targets.ts';

const repo = { owner: 'o', repo: 'r' };
const core = { info() {} };
const notFound = () => Object.assign(new Error('Not Found'), { status: 404 });

test('行き先の選択：既存 PR と取り込み済みの変更を飛ばし、閉じた PR は作り直す', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cherry-pick-test-'));
  const cwd = process.cwd();
  t.after(() => { process.chdir(cwd); fs.rmSync(dir, { recursive: true, force: true }); });
  const git = (...args: string[]) => execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { encoding: 'utf8' }).trim();
  git('init', '-q');
  fs.writeFileSync(path.join(dir, 'change.txt'), 'before\n');
  git('add', '.');
  git('commit', '-qm', 'Base');
  const base = git('rev-parse', 'HEAD');
  fs.writeFileSync(path.join(dir, 'change.txt'), 'after\n');
  git('commit', '-qam', 'Source PR');
  const mergeCommit = git('rev-parse', 'HEAD');
  const targets = ['1.0.0', '1.1.0', '1.2.0', '1.3.0'].map((version) => `release/product-a/v${version}`);
  for (const target of targets) git('update-ref', `refs/remotes/origin/${target}`, target === targets[2] ? mergeCommit : base);
  git('update-ref', 'refs/remotes/origin/release/product-a/v1.0.1', base);
  process.chdir(dir);

  const source = { number: 10, merged: true, merge_commit_sha: mergeCommit, base: { ref: 'main' }, head: { ref: 'feature' }, labels: [{ name: 'product-a/v1.0.0' }] };
  const existing = [
    [{ state: 'open', head: { sha: 'open-head' } }],
    [{ state: 'closed', merged_at: '2026-11-12T00:00:00Z', head: { sha: 'merged-head' } }],
    [],
    [{ state: 'closed', merged_at: null, head: { sha: 'closed-head' } }],
  ];
  let cleanupError: Error | undefined;
  let associations = 0;
  const github = mockGitHub({
    rest: {
      pulls: { get: async () => ({ data: source }), list() {} },
      git: { getRef: async () => { throw cleanupError ?? notFound(); } },
      repos: { listPullRequestsAssociatedWithCommit: async () => { associations++; return { data: [{ number: 10 }] }; } },
    },
    paginate: async (_: unknown, { head }: { head: string }) => existing[targets.findIndex((target) => head === `o:cherry-pick-10-to-${target}`)],
    graphql: async () => ({ repository: { pullRequests: { nodes: [], pageInfo: { hasNextPage: false } } } }),
  });
  const input = { github, repo, core, prNumber: 10 };
  assert.deepEqual(await selectTargets(input), {
    targets,
    pending: [{ target: targets[3], closedPullHeads: ['closed-head'] }],
    mergeCommit,
  });
  const outputs = new Map<string, unknown>();
  const workflow = {
    github,
    context: mockContext({ repo }),
    core: mockCore({ ...core, setOutput: (name: string, value: unknown) => outputs.set(name, value) }),
  };
  await prepare(workflow, { PR_NUMBER: '10' });
  assert.deepEqual(Object.fromEntries(outputs), { targets: targets.join(' '), branches: targets[3] });
  assert.equal(associations, 1);

  // 準備に失敗した行き先を、backport-action に渡してはいけない。
  outputs.clear();
  cleanupError = new Error('Cannot read branch');
  await assert.rejects(prepare(workflow, { PR_NUMBER: '10' }), /Cannot read branch/);
  assert.equal(outputs.has('branches'), false);
  assert.equal(associations, 1);

  source.labels.push({ name: 'cherry-pick' });
  assert.deepEqual(await selectTargets(input), { targets: [], pending: [], mergeCommit });
  await prepare(workflow, { PR_NUMBER: '10' });
  assert.deepEqual(Object.fromEntries(outputs), { targets: '', branches: '' });
  assert.equal(associations, 1);
  source.merged = false;
  await assert.rejects(selectTargets(input), /#10 はマージされていません/);
});

test('再実行：閉じた PR と自動化の残りだけを消し、人のブランチと進んだ先頭を残す', async (t) => {
  const target = 'release/product-a/v1.3.0';
  for (const scenario of [
    { name: 'closed PR', email: 'human@example.com', closedPullHeads: ['old-head'], deleted: true },
    { name: 'automation', email: 'github-actions[bot]@users.noreply.github.com', closedPullHeads: [], deleted: true },
    { name: 'human', email: 'human@example.com', closedPullHeads: [], deleted: false },
    { name: 'advanced', email: 'github-actions[bot]@users.noreply.github.com', closedPullHeads: [], advanced: true, deleted: false },
    { name: 'absent', absent: true, closedPullHeads: [], deleted: false },
  ]) {
    await t.test(scenario.name, async () => {
      let reads = 0;
      let deleted = false;
      const github = mockGitHub({
        rest: {
          git: {
            getRef: async () => {
              if (scenario.absent) throw notFound();
              return { data: { object: { sha: reads++ === 0 ? 'old-head' : 'new-head' } } };
            },
            getCommit: async () => ({ data: { committer: { email: scenario.email } } }),
          },
          repos: { get: async () => ({ data: { node_id: 'repo-id' } }) },
        },
        graphql: async (_: string, variables: { name: string; before: string }) => {
          assert.equal(variables.name, `refs/heads/cherry-pick-10-to-${target}`);
          assert.equal(variables.before, 'old-head');
          if (scenario.advanced) throw new Error('Head changed');
          deleted = true;
        },
      });
      await removeStaleBranches({ github, repo, core, prNumber: 10, pending: [{ target, closedPullHeads: scenario.closedPullHeads }] });
      assert.equal(deleted, scenario.deleted);
    });
  }
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
