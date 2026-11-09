// 開発ルールの、リリースラベル・バージョン・ブランチ名のルール。
// GitHub に依存しない関数だけを置き、単体テストできるようにしている。
'use strict';

const VERSION_PATTERN = /^(\d+)\.(\d+)\.(\d+)$/;
const RELEASE_BRANCH_PATTERN = /^release\/([^/]+)\/v(\d+\.\d+\.\d+)$/;
const RELEASE_LABEL_PATTERN = /^([^/]+)\/v(\d+\.\d+\.\d+)$/;

function parseVersion(text) {
  const match = VERSION_PATTERN.exec(text);
  return match ? match.slice(1, 4).map(Number) : null;
}

function compareVersions(a, b) {
  const [x, y] = [parseVersion(a), parseVersion(b)];
  for (let i = 0; i < 3; i++) {
    if (x[i] !== y[i]) return x[i] - y[i];
  }
  return 0;
}

// VERSION ファイルの中身を { 製品名: 'X.Y.Z' } にする。
function parseVersionFile(text) {
  const versions = {};
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    const [product, version, ...rest] = line.split('/');
    if (!product || rest.length > 0 || !parseVersion(version ?? '')) {
      throw new Error(`VERSION ファイルの行の形式が不正です: ${line}`);
    }
    if (product in versions) {
      throw new Error(`VERSION ファイルに ${product} が複数あります`);
    }
    versions[product] = version;
  }
  return versions;
}

// release/<製品名>/vX.Y.Z なら { product, version } を、そうでなければ null を返す。
function parseReleaseBranch(name) {
  const match = RELEASE_BRANCH_PATTERN.exec(name);
  return match ? { product: match[1], version: match[2] } : null;
}

// cherry-pick の PR のブランチ名（cherry-pick.yml の branch_name と同じ形）。手で cherry-pick するときも、この名前にしてもらう。
function cherryPickBranch(prNumber, target) {
  return `cherry-pick-${prNumber}-to-${target}`;
}

// cherry-pick の PR のブランチ名なら元の PR の番号を、そうでなければ null を返す。
function parseCherryPickBranch(name) {
  const match = /^cherry-pick-(\d+)-to-/.exec(name);
  return match ? Number(match[1]) : null;
}

// 変更が影響する製品を、paths-filter が当てたフィルタの名前から決める。
// 製品のパス設定に書かれていないファイル（all に当たって listed に当たらないもの）があれば、すべての製品に影響するとみなす。
function findAffectedProducts({ matched, products, allFileCount, listedFileCount }) {
  if (allFileCount > listedFileCount) {
    return {
      products: [...products],
      reason: '.github/product-paths.yml に書かれていないパスの変更があるため、すべての製品に影響するとみなしました。そのパスを使う製品に書き足してください。',
    };
  }
  return { products: products.filter((product) => matched.includes(product)), reason: null };
}

// PR のラベルのうち、products の製品のリリースラベル（<製品名>/vX.Y.Z）を { label, product, version } で返す。ほかのラベルは無視する。
function extractReleaseLabels(labels, products) {
  return labels.flatMap((label) => {
    const match = RELEASE_LABEL_PATTERN.exec(label);
    return match && products.includes(match[1]) ? [{ label, product: match[1], version: match[2] }] : [];
  });
}

// baseBranch: PR のマージ先
// labels: PR に付いているラベル
// affectedProducts: 変更が影響する製品（versionFile の製品のうち）
// versionFile / baseVersionFile: マージ後とマージ前の VERSION ファイルの中身
// branches: 今あるリリースブランチの名前
// リリース済みのバージョンのラベルは、そのリリースブランチが消えている（Tag Creation がリリースタグを打って消す）ので、
// 「マージ先のバージョンか、今あるリリースブランチのバージョン」の決まりで止まる。
function checkReleaseLabels({ baseBranch, labels, affectedProducts, versionFile, baseVersionFile, branches }) {
  const versions = parseVersionFile(versionFile);
  const baseVersions = parseVersionFile(baseVersionFile);
  const products = Object.keys(versions);
  const errors = [];
  let releaseLabels = extractReleaseLabels(labels, products);
  const hasBranch = (product, version) => branches.includes(`release/${product}/v${version}`);

  let release = null;
  let requiredProducts;
  if (baseBranch === 'main') {
    requiredProducts = affectedProducts;
  } else {
    // ワークフローは main と release/** への PR でだけ動き、release/** は自動化（と管理者）だけが release/<製品名>/vX.Y.Z の形で作る
    release = parseReleaseBranch(baseBranch);
    requiredProducts = [release.product];
    for (const { label, product } of releaseLabels) {
      if (product !== release.product) {
        errors.push(`${label}：${release.product} のリリースブランチへの PR には、${release.product} のリリースラベルだけを付けてください。`);
      }
    }
    releaseLabels = releaseLabels.filter(({ product }) => product === release.product);
    if (versions[release.product] !== release.version) {
      errors.push(
        `マージ後の VERSION（${release.product}/${versions[release.product]}）が、マージ先のブランチのバージョン（v${release.version}）と一致しません。先に VERSION を上げるか、作業ブランチを切ったブランチを確かめてください。`,
      );
    }
  }

  const labelsByProduct = new Map();
  for (const releaseLabel of releaseLabels) {
    labelsByProduct.set(releaseLabel.product, [...(labelsByProduct.get(releaseLabel.product) ?? []), releaseLabel]);
  }
  for (const product of requiredProducts) {
    if (!labelsByProduct.has(product)) {
      errors.push(`${product} に影響する変更ですが、${product} のリリースラベルが付いていません。`);
    }
  }
  // 影響しない製品のラベルは止める（古いバージョンなら、関係のない変更がその製品のリリースブランチに cherry-pick される）。
  // main への PR で、どの製品にも影響しない変更（docs や自動化、VERSION だけなど）には、リリースラベルは付けない。
  for (const product of labelsByProduct.keys()) {
    if (!requiredProducts.includes(product)) {
      errors.push(
        `${product} に影響する変更はありませんが、${product} のリリースラベルが付いています。外すか、${product} が使うパスなら .github/product-paths.yml に書き足してください。`,
      );
    }
  }
  for (const [product, list] of labelsByProduct) {
    if (list.length > 1) {
      errors.push(`${product} のリリースラベルが複数あります（${list.map((l) => l.label).join('、')}）。製品ごとに 1 つだけ付けてください。`);
    }
  }

  // VERSION は上げるだけ。main で上げるときは、上げる前のバージョンのリリースブランチを先に作っておく（開発フェーズの入り方の順番）。
  // VERSION を上げる PR に製品のラベルを付けるなら、上げた後のバージョンにする（古いバージョンなら、上げた VERSION ごと cherry-pick される）。
  for (const product of products.filter((p) => baseVersions[p] !== undefined && baseVersions[p] !== versions[p] && (!release || p === release.product))) {
    const [before, after] = [baseVersions[product], versions[product]];
    if (compareVersions(after, before) < 0) {
      errors.push(`VERSION の ${product} を ${before} から ${after} に下げています。`);
    } else if (!release && !hasBranch(product, before)) {
      errors.push(`VERSION の ${product} を上げる前に、release/${product}/v${before} を作ってください（Actions の「Release Preparation」を使うと順番どおりに進みます）。`);
    }
    for (const { label, version } of labelsByProduct.get(product) ?? []) {
      if (version !== after) errors.push(`${label}：VERSION の ${product} を ${after} にする PR には、${product}/v${after} を付けてください。`);
    }
  }

  // ラベルのバージョンは、マージ先のバージョン以下で、マージ先のバージョンか、今あるリリースブランチのバージョンでなければならない。
  // マージ先のバージョンは、main ならマージ後の VERSION、リリースブランチならブランチ名。
  for (const { label, product, version } of releaseLabels) {
    const upper = release ? release.version : versions[product];
    const target = release ? `マージ先のブランチのバージョン（v${upper}）` : `マージ後の VERSION（${product}/${upper}）`;
    if (compareVersions(version, upper) > 0) {
      errors.push(`${label}：${target}より新しいバージョンです。`);
    } else if (version !== upper && !hasBranch(product, version)) {
      errors.push(`${label}：${product} に v${version} のリリースブランチがありません（リリース済みか、まだ作っていません）。${target}か、それより古い今あるリリースブランチのバージョンを付けてください。`);
    }
  }

  return { errors };
}

// PR の変更が、product の version のリリースに入るべきか（開発ルールの「リリースラベル」）。
// その製品のリリースラベルのバージョン以上で、main にマージした PR ならそれより新しいすべてのバージョン、
// リリースブランチにマージした PR ならそのブランチのバージョンまで。cherry-pick の PR は、元の PR の変更を運ぶものなので数えない。
// pull: { base, head, labels }（labels はラベルの名前）
function belongsTo(pull, product, version) {
  if (parseCherryPickBranch(pull.head) !== null) return false;
  const base = parseReleaseBranch(pull.base);
  if (pull.base !== 'main' && !(base?.product === product && compareVersions(version, base.version) <= 0)) return false;
  return extractReleaseLabels(pull.labels, [product]).some((label) => compareVersions(label.version, version) <= 0);
}

// マージされた PR（pull: { base, head, labels }）の変更を cherry-pick するブランチを、今あるリリースブランチ（branches）から決める。
// 変更が入るべきバージョン（belongsTo）のブランチのうち、マージ先以外。main にマージした PR には上限がない
// （マージの時点で main のバージョンより新しいブランチはなく、あとから作られる修正フェーズのブランチにも入れるため）。
function findCherryPickTargets(pull, branches) {
  return branches
    .filter((name) => {
      const branch = parseReleaseBranch(name);
      return branch && name !== pull.base && belongsTo(pull, branch.product, branch.version);
    })
    .sort();
}

// リリースの準備（開発ルールの「main ブランチにおいて機能の開発は終了しリリース前の準備フェーズに入りたい場合」）で、
// main の今のバージョンから作るリリースブランチと、次のバージョン（bump は minor か major）とそのリリースラベルを決める。
function planReleasePrep({ versionFile, product, bump }) {
  const currentVersion = parseVersionFile(versionFile)[product];
  const [major, minor] = parseVersion(currentVersion);
  const nextVersion = bump === 'major' ? `${major + 1}.0.0` : `${major}.${minor + 1}.0`;
  return {
    currentVersion,
    nextVersion,
    releaseBranch: `release/${product}/v${currentVersion}`,
    releaseTag: `${product}/v${currentVersion}`,
    nextLabel: `${product}/v${nextVersion}`,
  };
}

// 修正フェーズ（開発ルールの「リリース済みのバージョンに対しての修正フェーズに入りたい場合」）で、
// 製品の最新のリリースタグ（<製品名>/vX.Y.Z。rc などは除く）と、そこから作るリリースブランチ（次のパッチバージョン）を決める。
function planHotfixPrep({ product, tags }) {
  const prefix = `${product}/v`;
  const released = tags.filter((tag) => tag.startsWith(prefix) && parseVersion(tag.slice(prefix.length))).map((tag) => tag.slice(prefix.length));
  if (released.length === 0) {
    return { error: `${product} のリリースタグ（${product}/vX.Y.Z）がまだありません。` };
  }
  const releasedVersion = released.sort(compareVersions).at(-1);
  const [major, minor, patch] = parseVersion(releasedVersion);
  const nextVersion = `${major}.${minor}.${patch + 1}`;
  return {
    releasedTag: `${product}/v${releasedVersion}`,
    releasedVersion,
    nextVersion,
    releaseBranch: `release/${product}/v${nextVersion}`,
    nextLabel: `${product}/v${nextVersion}`,
  };
}

// リリース手順（開発ルールの「リリース手順」）で打つタグを、リリースブランチの名前と今あるタグから決める。
// rc タグは <製品名>/vX.Y.Z-rc.N（N は 1 から順に）、リリースタグは <製品名>/vX.Y.Z。
function planRelease({ branch, tags }) {
  const release = parseReleaseBranch(branch);
  if (!release) {
    return { error: `${branch} はリリースブランチ（release/<製品名>/vX.Y.Z）ではありません。Use workflow from でリリースブランチを選んで実行してください。` };
  }
  const releaseTag = `${release.product}/v${release.version}`;
  const rcNumbers = tags.filter((tag) => tag.startsWith(`${releaseTag}-rc.`)).map((tag) => Number(tag.slice(`${releaseTag}-rc.`.length)));
  const latestRc = rcNumbers.length > 0 ? Math.max(...rcNumbers) : null;
  return {
    product: release.product,
    version: release.version,
    releaseTag,
    released: tags.includes(releaseTag),
    latestRcTag: latestRc === null ? null : `${releaseTag}-rc.${latestRc}`,
    nextRcTag: `${releaseTag}-rc.${(latestRc ?? 0) + 1}`,
  };
}

// VERSION ファイルの、その製品の行だけを書き換える（コメントやほかの行はそのまま）。
function setVersion(versionFile, product, version) {
  return versionFile
    .split('\n')
    .map((line) => (line.trim().split('/')[0] === product && !line.trim().startsWith('#') ? `${product}/${version}` : line))
    .join('\n');
}

module.exports = {
  belongsTo,
  checkReleaseLabels,
  cherryPickBranch,
  compareVersions,
  findAffectedProducts,
  findCherryPickTargets,
  parseCherryPickBranch,
  parseVersionFile,
  planHotfixPrep,
  planRelease,
  planReleasePrep,
  setVersion,
};
