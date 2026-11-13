import { mockCore, mockContext, mockGitHub } from './test-helpers.ts';
import type { Context } from './github.ts';
// PR のテスト用マージコミットとキューの合成済みコミットを、一時的な git リポジトリで確かめる。
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { check } from './release-label-check.ts';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'release-label-check-test-'));
const git = (...args: string[]) => execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { encoding: 'utf8' }).trim();
// parent の上で files を書き換えたコミットを作り、その SHA を返す
function commit(parent: string | null, files: Record<string, string>, message: string) {
  if (parent) git('checkout', '-q', '--detach', parent);
  for (const [file, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), content);
  }
  git('add', '-A');
  git('commit', '-q', '-m', message);
  return git('rev-parse', 'HEAD');
}
function merge(base: string, head: string) {
  git('checkout', '-q', '--detach', base);
  git('merge', '--no-ff', '-q', '-m', 'Test merge', head);
  return git('rev-parse', 'HEAD');
}
const versionFile = (a: string) => `# version\nproduct-a/${a}\nproduct-b/2.0.0\n`;

git('init', '-q');
const root = commit(null, { VERSION: versionFile('1.4.0'), 'ProductA/app.txt': 'a\n', 'ProductB/app.txt': 'b\n' }, 'root');
// main と、main の 1.4.0 から作ったリリースブランチ（チェックアウトしたときのリモートのブランチとして置く）
git('update-ref', 'refs/remotes/origin/main', root);
git('update-ref', 'refs/remotes/origin/release/product-a/v1.4.0', root);
// マージキュー：#11（product-a を 1.5.0 に上げる）の後ろに、#12（product-a を直す）が並んでいる。
// それぞれのマージグループのコミットは、前のマージグループのコミットの上に、その PR の変更を足したもの（main にはまだ入っていない）
const group11 = commit(root, { VERSION: versionFile('1.5.0') }, 'Bump product-a to 1.5.0 (#11)');
const group12 = commit(group11, { 'ProductA/app.txt': 'a fix\n' }, 'Fix product-a (#12)');
const mergeGroup12 = {
  head_sha: group12,
  head_ref: `refs/heads/gh-readonly-queue/main/pr-12-${group11}`,
  base_sha: group11,
  base_ref: 'refs/heads/main',
};
const cwd = process.cwd();
process.chdir(dir);
test.after(() => {
  process.chdir(cwd);
  fs.rmSync(dir, { recursive: true, force: true });
});

function fakeCore() {
  const failures: string[] = [];
  return mockCore({ failures, setFailed: (message: string | Error) => failures.push(String(message)), warning() {}, error() {} });
}
// number の PR だけを返す API
const fakeGithub = (number: number, labels: string[], base = 'main') => mockGitHub({
  rest: {
    pulls: {
      get: async ({ pull_number }: { pull_number: number }) => {
        assert.equal(pull_number, number);
        return { data: { number, base: { ref: base }, labels: labels.map((name) => ({ name })) } };
      },
    },
  },
});
const context = (payload: Context['payload']) => mockContext({ repo: { owner: 'o', repo: 'r' }, payload });

async function runCheck(
  baseSha: string,
  labels: string[],
  baseBranch = 'main',
  payload: Context['payload'] = { pull_request: { number: 12, base: { ref: 'old-base' }, labels: [] } },
) {
  const core = fakeCore();
  Object.assign(process.env, {
    BASE_SHA: baseSha,
    AFFECTED_PRODUCTS: JSON.stringify(['product-a']),
    HAS_UNLISTED_FILES: 'false',
  });
  await check({ github: fakeGithub(12, labels, baseBranch), context: context(payload), core });
  return core.failures;
}

test('マージキュー：前に並んでいる PR の変更（VERSION を上げる）を、この PR の変更とみなさない', async () => {
  git('checkout', '-q', '--detach', group12);
  // 1.4.0 のリリースブランチがあるので、#12 に product-a/v1.4.0 を付けてよい（VERSION は変えていない）
  // PR の番号はキューのブランチ名から読む。キューではイベントのマージ先を使う。
  const payload = { merge_group: mergeGroup12 };
  assert.deepEqual(await runCheck(group11, ['product-a/v1.4.0'], 'old-base', payload), []);
  // 今の main の先頭をマージ前の中身にすると、#11 の VERSION の変更を #12 の変更とみなして止めてしまう
  assert.equal((await runCheck(root, ['product-a/v1.4.0'], 'old-base', payload)).length, 1);
});

test('PR のマージ結果：main 側の VERSION 更新を PR の変更に含めない', async () => {
  const head = commit(root, { 'ProductA/app.txt': 'a fix\n' }, 'Fix product-a');
  const merged = merge(group11, head);
  const laterMain = commit(group11, { VERSION: versionFile('1.6.0') }, 'Advance main after test merge');
  git('update-ref', 'refs/remotes/origin/main', laterMain);
  git('checkout', '-q', '--detach', merged);

  assert.equal(git('diff', '--name-only', `${group11}..HEAD`), 'ProductA/app.txt');
  assert.deepEqual(await runCheck(group11, ['product-a/v1.4.0']), []);
  assert.equal((await runCheck(group11, ['product-a/v1.6.0'])).length, 1);
  git('update-ref', 'refs/remotes/origin/main', root);
});

test('PR のマージ結果：PR 自身の VERSION 更新には更新後のラベルが必要', async () => {
  const head = commit(root, { VERSION: versionFile('1.5.0'), 'ProductA/app.txt': 'a next version\n' }, 'Update product-a and VERSION');
  merge(root, head);
  assert.deepEqual(await runCheck(root, ['product-a/v1.5.0']), []);
  assert.equal((await runCheck(root, ['product-a/v1.4.0'])).length, 1);
});

test('リリース PR の再確認：新しいテスト用マージコミットの VERSION を使う', async () => {
  const baseBranch = 'release/product-a/v1.4.1';
  const labels = ['product-a/v1.4.1'];
  const head = commit(root, { 'ProductA/app.txt': 'a hotfix\n' }, 'Fix product-a for hotfix');
  merge(root, head);
  assert.equal((await runCheck(root, labels, baseBranch)).length, 1);

  const updatedBase = commit(root, { VERSION: versionFile('1.4.1') }, 'Prepare hotfix VERSION');
  git('update-ref', `refs/remotes/origin/${baseBranch}`, updatedBase);
  merge(updatedBase, head);
  assert.equal(git('diff', '--name-only', `${updatedBase}..HEAD`), 'ProductA/app.txt');
  assert.deepEqual(await runCheck(updatedBase, labels, baseBranch), []);
});
