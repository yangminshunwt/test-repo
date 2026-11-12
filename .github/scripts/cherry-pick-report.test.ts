import { mockGitHub } from './test-helpers.ts';
import type { WorkflowResult } from './cherry-pick/report.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { failureReasons, reportFailures } from './cherry-pick/report.ts';

const success: WorkflowResult = { appTokenOutcome: 'success', jobStatus: 'success', backportOutcome: 'success', wasSuccessful: 'true', results: 'release/product-a/v1.3.0=true' };

test('成功した draft や行き先なしは失敗にせず、部分失敗と結果なしは知らせる', () => {
  assert.deepEqual(failureReasons(success), []);
  assert.deepEqual(failureReasons({ ...success, appTokenOutcome: 'skipped', backportOutcome: 'skipped', wasSuccessful: '', results: '' }), []);
  assert.deepEqual(failureReasons({ ...success, wasSuccessful: 'false', results: `${success.results}\nrelease/product-b/v2.0.0=false` }), ['release/product-b/v2.0.0 に cherry-pick できませんでした。']);
  assert.match(failureReasons({ ...success, wasSuccessful: '', results: '' })[0], /結果を出さずに終わりました/);
  assert.match(failureReasons({ ...success, appTokenOutcome: 'failure', jobStatus: 'failure' })[0], /App のトークン/);
});

test('失敗した元 PR に作者とマージした人、実行 URL、手動手順を知らせる', async () => {
  const comments: { issue_number: number; body: string }[] = [];
  const source = { number: 10, merged: true, user: { login: 'author' }, merged_by: { login: 'merger' } };
  const github = mockGitHub({ rest: {
    pulls: { get: async () => ({ data: source }) },
    issues: { createComment: async (comment: { issue_number: number; body: string }) => { comments.push(comment); } },
  } });
  const input = { github, repo: { owner: 'o', repo: 'r' }, prNumber: 10, runUrl: 'https://github.com/o/r/actions/runs/1', result: { ...success, jobStatus: 'failure' as const } };
  assert.equal((await reportFailures(input)).length, 1);
  assert.equal(comments[0].issue_number, 10);
  assert.match(comments[0].body, /@author @merger/);
  assert.ok(comments[0].body.includes(input.runUrl));
  assert.match(comments[0].body, /cherry-pick-10-to-/);
  assert.match(comments[0].body, /アーカイブされていないラベル/);
  source.merged_by.login = 'author';
  await reportFailures(input);
  assert.equal(comments[1].body.match(/@author/g)!.length, 1);
  source.merged = false;
  assert.deepEqual(await reportFailures(input), []);
  assert.deepEqual(await reportFailures({ ...input, result: success }), []);
  assert.equal(comments.length, 2);
});
