// changes.ts の「変更がコミットに入っているか」を、一時的な git リポジトリで確かめる（changes.ts は今の場所で git を動かす）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { containsChange, missingChanges } from './changes.ts';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'changes-test-'));
const git = (...args: string[]) => execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { encoding: 'utf8' }).trim();
// parent の上で files を書き換えたコミットを作り、その SHA を返す（ブランチは動かさない）
function commit(parent: string, files: Record<string, string>, message: string) {
  git('checkout', '-q', '--detach', parent);
  for (const [file, content] of Object.entries(files)) fs.writeFileSync(path.join(dir, file), content);
  git('add', '-A');
  git('commit', '-q', '-m', message);
  return git('rev-parse', 'HEAD');
}

git('init', '-q');
fs.writeFileSync(path.join(dir, 'a.txt'), 'a\n');
fs.writeFileSync(path.join(dir, 'b.txt'), 'b\n');
git('add', '-A');
git('commit', '-q', '-m', 'root');
const root = git('rev-parse', 'HEAD');
// main に #10（a.txt を変える）をマージ。release は root から切ったブランチ
const m10 = commit(root, { 'a.txt': 'a10\n' }, 'Change a (#10)');
const pull10 = { number: 10, base: 'main', head: 'f10', mergeCommit: m10, labels: ['product-a/v1.0.0'] };
const cwd = process.cwd();
process.chdir(dir);

// それぞれ、名前の決まりのほかには入っていると判断できないように作る（あとで同じ行を変えたので、当て直すとコンフリクトする、など）
test('マージコミットが祖先なら入っている', () => {
  assert.equal(containsChange([pull10], pull10, commit(m10, { 'a.txt': 'a11\n' }, 'later change to the same line')), true);
});

test('cherry-pick の PR のマージコミットが祖先なら入っている', () => {
  const pick = commit(root, { 'a.txt': 'a10-resolved\n', 'b.txt': 'b3\n' }, 'Change a (#10) (#11), conflict resolved');
  const carrier = { number: 11, base: 'release/product-a/v1.0.0', head: 'cherry-pick-10-to-release/product-a/v1.0.0', mergeCommit: pick, labels: ['cherry-pick', 'product-a/v1.0.0'] };
  const head = commit(pick, { 'b.txt': 'b4\n' }, 'later');
  assert.equal(containsChange([pull10, carrier], pull10, head), true);
  assert.deepEqual(missingChanges([pull10, carrier], 'product-a', '1.0.0', head), []);
});

test('同じ内容がもう入っていれば（当てても何も変わらなければ）入っている', () => {
  assert.equal(containsChange([pull10], pull10, commit(root, { 'a.txt': 'a10\n' }, 'Same change by another PR')), true);
});

test('入っていない変更、コンフリクトする変更、手元にないコミットは、入っていない', () => {
  assert.equal(containsChange([pull10], pull10, commit(root, { 'b.txt': 'b5\n' }, 'other')), false);
  assert.equal(containsChange([pull10], pull10, commit(root, { 'a.txt': 'conflict\n' }, 'conflict')), false);
  assert.equal(containsChange([pull10], { ...pull10, mergeCommit: '0123456789012345678901234567890123456789' }, root), false);
});

test('入っていない変更は、そのバージョンに入るべきものだけを返す', () => {
  const other = { number: 12, base: 'main', head: 'f12', mergeCommit: m10, labels: ['product-a/v1.1.0'] };
  const unlabeled = { number: 13, base: 'main', head: 'f13', mergeCommit: m10, labels: [] };
  assert.deepEqual(missingChanges([pull10, other, unlabeled], 'product-a', '1.0.0', root).map((pull) => pull.number), [10]);
  assert.deepEqual(missingChanges([pull10, other, unlabeled], 'product-a', '1.0.0', m10), []);
});

test('修正フェーズ：正式タグに入らなかった旧バージョンの変更を、欠落とみなさない', () => {
  const hotfix = { ...pull10, number: 14, labels: ['product-a/v1.0.1'] };
  const carrier = { ...hotfix, number: 15, head: 'renamed-branch', labels: ['cherry-pick', 'product-a/v1.0.1'] };
  assert.deepEqual(missingChanges([pull10], 'product-a', '1.0.1', root), []);
  assert.deepEqual(missingChanges([pull10, hotfix, carrier], 'product-a', '1.0.1', root).map((pull) => pull.number), [14]);
  assert.deepEqual(missingChanges([pull10, hotfix], 'product-a', '1.0.2', root), []);
});

test.after(() => {
  process.chdir(cwd);
  fs.rmSync(dir, { recursive: true, force: true });
});
