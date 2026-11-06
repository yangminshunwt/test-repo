'use strict';

// 製品名を書いている場所が、VERSION ファイルの製品とそろっているかを確かめる。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { parseVersionFile } = require('./release-labels.js');

const root = path.join(__dirname, '..', '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const products = Object.keys(parseVersionFile(read('VERSION'))).sort();

// YAML の 1 行のリスト（[a, b, c]）を配列にする
function flowList(text) {
  return text
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

test('製品のパス設定に、VERSION の製品ごとのフィルタがあり、listed にも入っている', () => {
  const paths = read('.github/product-paths.yml');
  const filters = [...paths.matchAll(/^([A-Za-z0-9_-]+):/gm)].map((match) => match[1]);
  for (const product of products) {
    assert.ok(filters.includes(product), `.github/product-paths.yml に ${product} のフィルタがありません`);
  }
  const listed = /^listed:\s*\[([^\]]*)\]/m.exec(paths);
  assert.ok(listed, '.github/product-paths.yml に listed がありません');
  const aliases = flowList(listed[1]);
  for (const product of products) {
    assert.ok(aliases.includes(`*${product}`), `.github/product-paths.yml の listed に *${product} がありません`);
  }
});

// 古いタグから作ったリリースブランチでは VERSION の製品が main より少ないことがあるので、
// VERSION の製品がすべて選べることを確かめる（選択肢が多いぶんには、実行したときに止まる）。
for (const workflow of ['release-prep.yml', 'hotfix-prep.yml']) {
  const file = `.github/workflows/${workflow}`;
  test(`${workflow} の製品の選択肢に、VERSION の製品がすべてある`, () => {
    const options = /\n {6}product:[\s\S]*?options:\s*\[([^\]]*)\]/.exec(read(file));
    assert.ok(options, `${workflow} の product の options が見つかりません`);
    const choices = flowList(options[1]);
    for (const product of products) {
      assert.ok(choices.includes(product), `${workflow} の product の options に ${product} がありません`);
    }
  });
}
