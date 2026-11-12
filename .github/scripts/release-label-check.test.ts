import { mockCore, mockContext, mockGitHub } from './test-helpers.ts';
import type { Context } from './github.ts';
// PR のテスト用マージコミットとキューの合成済みコミットを、一時的な git リポジトリで確かめる。
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { findBase, check } from './release-label-check.ts';

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
  const outputs: Record<string, unknown> = {};
  const failures: string[] = [];
  const summary = { addHeading: () => summary, addTable: () => summary, addList: () => summary, write: async () => summary };
  return mockCore({ outputs, failures, summary, setOutput: (name: string, value: unknown) => (outputs[name] = value), setFailed: (message: string | Error) => failures.push(String(message)), warning() {}, error() {} });
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

async function runCheck(before: string, labels: string[], baseBranch = 'main') {
  const core = fakeCore();
  Object.assign(process.env, {
    BASE_REF: baseBranch,
    BEFORE: before,
    LABELS: JSON.stringify(labels),
    AFFECTED_PRODUCTS: JSON.stringify(['product-a']),
    ALL_FILE_COUNT: '1',
    LISTED_FILE_COUNT: '1',
  });
  await check({ core });
  return core.failures;
}

test('マージキュー：PR の番号はブランチ名から、マージ前の中身はマージグループの親から取る', async () => {
  git('checkout', '-q', '--detach', group12);
  for (const mergedCheckout of [false, true]) {
    const core = fakeCore();
    await findBase({ github: fakeGithub(12, ['product-a/v1.4.0']), context: context({ merge_group: mergeGroup12 }), core, mergedCheckout });
    assert.deepEqual(core.outputs, { base_ref: 'main', before: group11, base_sha: group11, labels: JSON.stringify(['product-a/v1.4.0']) });
  }
});

test('マージキュー：前に並んでいる PR の変更（VERSION を上げる）を、この PR の変更とみなさない', async () => {
  git('checkout', '-q', '--detach', group12);
  // 1.4.0 のリリースブランチがあるので、#12 に product-a/v1.4.0 を付けてよい（VERSION は変えていない）
  assert.deepEqual(await runCheck(group11, ['product-a/v1.4.0']), []);
  // 今の main の先頭をマージ前の中身にすると、#11 の VERSION の変更を #12 の変更とみなして止めてしまう
  assert.equal((await runCheck(root, ['product-a/v1.4.0'])).length, 1);
});

test('CI：マージ前の中身は今のマージ先の先頭、変更を探す起点はそれとの分かれ目', async () => {
  const head = commit(root, { 'ProductB/app.txt': 'b fix\n' }, 'Fix product-b');
  git('update-ref', 'refs/remotes/origin/main', group11); // PR を作ったあとで main が進んだ
  const core = fakeCore();
  await findBase({ github: fakeGithub(13, ['product-b/v2.0.0']), context: context({ pull_request: { number: 13 } }), core });
  assert.deepEqual(core.outputs, { base_ref: 'main', before: group11, base_sha: root, labels: JSON.stringify(['product-b/v2.0.0']) });
  git('update-ref', 'refs/remotes/origin/main', root);
  assert.equal(git('rev-parse', 'HEAD'), head);
});

test('PR のマージ結果：main 側の VERSION 更新を PR の変更に含めない', async () => {
  const head = commit(root, { 'ProductA/app.txt': 'a fix\n' }, 'Fix product-a');
  const merged = merge(group11, head);
  const laterMain = commit(group11, { VERSION: versionFile('1.6.0') }, 'Advance main after test merge');
  git('update-ref', 'refs/remotes/origin/main', laterMain);
  git('checkout', '-q', '--detach', merged);

  const core = fakeCore();
  await findBase({ github: fakeGithub(14, ['product-a/v1.4.0']), context: context({ pull_request: { number: 14 } }), core, mergedCheckout: true });
  assert.deepEqual(core.outputs, { base_ref: 'main', before: group11, base_sha: group11, labels: JSON.stringify(['product-a/v1.4.0']) });
  assert.equal(git('diff', '--name-only', `${core.outputs.base_sha}..HEAD`), 'ProductA/app.txt');
  assert.deepEqual(await runCheck(String(core.outputs.before), ['product-a/v1.4.0']), []);
  assert.equal((await runCheck(String(core.outputs.before), ['product-a/v1.6.0'])).length, 1);
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
  const core = fakeCore();
  await findBase({
    github: fakeGithub(15, labels, baseBranch),
    context: context({ pull_request: { number: 15, base: { sha: root, ref: baseBranch } } }),
    core,
    mergedCheckout: true,
  });
  assert.equal(core.outputs.before, updatedBase);
  assert.equal(git('diff', '--name-only', `${core.outputs.base_sha}..HEAD`), 'ProductA/app.txt');
  assert.deepEqual(await runCheck(String(core.outputs.before), labels, baseBranch), []);
});
