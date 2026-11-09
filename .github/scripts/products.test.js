'use strict';

// 製品名の元は VERSION ファイル。製品名を書いているほかの場所（製品のパス設定、Release Preparation と
// Hotfix Preparation の選択肢）が、VERSION の製品と完全に一致しているかを確かめる。
// 製品を足したり消したりするときは、これらを同じ PR で直す。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { parseVersionFile } = require('./release-labels.js');

const root = path.join(__dirname, '..', '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const products = Object.keys(parseVersionFile(read('VERSION'))).sort();

// .github/product-paths.yml の、製品以外のフィルタ（増やしたら、ここにも足す）
const HELPER_FILTERS = ['all', 'common', 'listed', 'none'];

// YAML の 1 行のリスト（[a, b, c]）を配列にする
function flowList(text) {
  return text
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function assertSameProducts(actual, where) {
  assert.deepEqual(actual.sort(), products, `${where}（${actual.join(', ')}）が VERSION の製品（${products.join(', ')}）と一致しません`);
}

test('製品のパス設定の製品のフィルタと listed が、VERSION の製品と一致する', () => {
  const paths = read('.github/product-paths.yml');
  const filters = [...paths.matchAll(/^([A-Za-z0-9_-]+):/gm)].map((match) => match[1]);
  assertSameProducts(
    filters.filter((filter) => !HELPER_FILTERS.includes(filter)),
    '.github/product-paths.yml の製品のフィルタ',
  );
  // all（すべてのファイル）と listed の件数の違いで、どの製品にも書かれていないパスを見つけている（release-labels.js の findAffectedProducts）
  assert.match(paths, /^all: \['\*\*'\]$/m, ".github/product-paths.yml に all: ['**'] がありません");
  const listed = /^listed:\s*\[([^\]]*)\]/m.exec(paths);
  assert.ok(listed, '.github/product-paths.yml に listed がありません');
  const aliases = flowList(listed[1]);
  assert.ok(aliases.includes('*none'), '.github/product-paths.yml の listed に *none がありません');
  assertSameProducts(
    aliases.filter((alias) => alias !== '*none').map((alias) => alias.replace(/^\*/, '')),
    '.github/product-paths.yml の listed の製品',
  );
});

for (const workflow of ['release-prep.yml', 'hotfix-prep.yml']) {
  test(`${workflow} の製品の選択肢が、VERSION の製品と一致する`, () => {
    const options = /\n {6}product:[\s\S]*?options:\s*\[([^\]]*)\]/.exec(read(`.github/workflows/${workflow}`));
    assert.ok(options, `${workflow} の product の options が見つかりません`);
    assertSameProducts(flowList(options[1]), `${workflow} の product の選択肢`);
  });
}
