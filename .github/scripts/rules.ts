// 開発ルールの判断（バージョン、リリースブランチと cherry-pick のブランチの名前、リリースラベルのチェック、
// 変更がどのリリースに入るべきか、各ワークフローが何をするか）。
// GitHub に依存しない関数だけを置き、単体テストできるようにしている。

interface ReleaseVersion {
  product: string;
  version: string;
}

interface ReleaseLabel extends ReleaseVersion {
  label: string;
}

export interface LabeledPullRequest {
  base: string;
  head: string;
  labels: string[];
}

export interface ReleaseLabelCheckInput {
  baseBranch: string;
  labels: string[];
  affectedProducts: string[];
  versionFileAfterMerge: string;
  versionFileBeforeMerge: string;
  releaseBranches: string[];
}

export interface VersionCheckInput {
  baseBranch: string;
  versionFileAfterMerge: string;
  versionFileBeforeMerge: string;
}

const VERSION_PATTERN = /^(\d+)\.(\d+)\.(\d+)$/;
const RELEASE_BRANCH_PATTERN = /^release\/([^/]+)\/v(\d+\.\d+\.\d+)$/;
const RELEASE_LABEL_PATTERN = /^([^/]+)\/v(\d+\.\d+\.\d+)$/;

function parseVersion(text: string): [number, number, number] | null {
  const match = VERSION_PATTERN.exec(text);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

function compareVersions(a: string, b: string): number {
  const [x, y] = [parseVersion(a)!, parseVersion(b)!];
  for (let i = 0; i < 3; i++) {
    if (x[i] !== y[i]) return x[i] - y[i];
  }
  return 0;
}

// VERSION ファイルの中身を { 製品名: 'X.Y.Z' } にする。
function parseVersionFile(text: string): Record<string, string> {
  const versions: Record<string, string> = {};
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
function parseReleaseBranch(name: string): ReleaseVersion | null {
  const match = RELEASE_BRANCH_PATTERN.exec(name);
  return match ? { product: match[1], version: match[2] } : null;
}

// cherry-pick の PR のブランチ名なら元の PR の番号を、そうでなければ null を返す。
function parseCherryPickBranch(name: string): number | null {
  const match = /^cherry-pick-(\d+)-to-/.exec(name);
  return match ? Number(match[1]) : null;
}

// マージキューが作るブランチ（refs/heads/gh-readonly-queue/<マージ先>/pr-<PR の番号>-<もとにしたコミット>）の PR の番号。
// merge_group のイベントには PR の番号がないので、ここから読む（GitHub のドキュメントにあるのは gh-readonly-queue/<マージ先> の部分まで）。
function parseMergeQueueBranch(ref: string): number | null {
  const match = /^(?:refs\/heads\/)?gh-readonly-queue\/.+\/pr-(\d+)-[0-9a-f]+$/.exec(ref);
  return match ? Number(match[1]) : null;
}

// 変更が影響する製品を、paths-filter が当てたフィルタの名前から決める。
// 製品のパス設定に書かれていないファイル（all に当たって listed に当たらないもの）があれば、すべての製品に影響するとみなす。
function findAffectedProducts({ matched, products, hasUnlistedFiles }: { matched: string[]; products: string[]; hasUnlistedFiles: boolean }) {
  if (hasUnlistedFiles) {
    return {
      products: [...products],
      reason: '.github/product-paths.yml に書かれていないパスの変更があるため、すべての製品に影響するとみなしました。そのパスを使う製品に書き足してください。',
    };
  }
  return { products: products.filter((product) => matched.includes(product)), reason: null };
}

// PR のラベルのうち、products の製品のリリースラベル（<製品名>/vX.Y.Z）を { label, product, version } で返す。ほかのラベルは無視する。
function extractReleaseLabels(labels: string[], products: string[]): ReleaseLabel[] {
  return labels.flatMap((label) => {
    const match = RELEASE_LABEL_PATTERN.exec(label);
    return match && products.includes(match[1]) ? [{ label, product: match[1], version: match[2] }] : [];
  });
}

// baseBranch: PR のマージ先
// labels: PR に付いているラベル
// affectedProducts: 変更が影響する製品（versionFileAfterMerge の製品のうち）
// versionFileAfterMerge / versionFileBeforeMerge: マージ後とマージ前の VERSION ファイルの中身
// releaseBranches: 今あるリリースブランチの名前
function checkReleaseLabels({
  baseBranch,
  labels,
  affectedProducts,
  versionFileAfterMerge,
  versionFileBeforeMerge,
  releaseBranches,
}: ReleaseLabelCheckInput): { errors: string[] } {
  const versionsAfterMerge = parseVersionFile(versionFileAfterMerge);
  const versionsBeforeMerge = parseVersionFile(versionFileBeforeMerge);
  const products = Object.keys(versionsAfterMerge);
  const errors: string[] = [];
  const release = parseReleaseBranch(baseBranch);
  const releaseLabels = extractReleaseLabels(labels, products);
  const hasBranch = (product: string, version: string) => releaseBranches.includes(`release/${product}/v${version}`);

  const labelsByProduct = new Map<string, ReleaseLabel[]>();
  for (const releaseLabel of releaseLabels) {
    const product = releaseLabel.product;
    const productLabels = labelsByProduct.get(product) ?? [];

    productLabels.push(releaseLabel);
    labelsByProduct.set(product, productLabels);
  }

  if (baseBranch === 'main') {
    // 1. main のラベル：影響する製品にだけ、製品ごとに 1 つ付ける。
    for (const product of affectedProducts) {
      if (!labelsByProduct.has(product)) {
        errors.push(`${product} に影響する変更ですが、${product} のリリースラベルが付いていません。`);
      }
    }
    for (const [product, productLabels] of labelsByProduct) {
      if (!affectedProducts.includes(product)) {
        errors.push(
          `${product} に影響する変更はありませんが、${product} のリリースラベルが付いています。外すか、${product} が使うパスなら .github/product-paths.yml に書き足してください。`,
        );
      }
      if (productLabels.length > 1) {
        errors.push(`${product} のリリースラベルが複数あります（${productLabels.map((label) => label.label).join('、')}）。製品ごとに 1 つだけ付けてください。`);
      }
    }

    // マージ後の VERSION と同じか、それより古い既存のリリースブランチのバージョンにする。
    for (const { label, product, version } of releaseLabels) {
      const currentVersion = versionsAfterMerge[product];
      const target = `マージ後の VERSION（${product}/${currentVersion}）`;
      if (compareVersions(version, currentVersion) > 0) {
        errors.push(`${label}：${target}より新しいバージョンです。`);
      } else if (version !== currentVersion && !hasBranch(product, version)) {
        errors.push(`${label}：${product} に v${version} のリリースブランチがありません（リリース済みか、まだ作っていません）。${target}か、それより古い今あるリリースブランチのバージョンを付けてください。`);
      }
    }
  } else {
    // 2. release のラベル：マージ先の製品に 1 つ付ける。cherry-pick には元のラベルを引き継ぐための例外がある。
    if (!release) {
      return { errors: [`マージ先のブランチ（${baseBranch}）が、main でも、リリースブランチ（release/<製品名>/vX.Y.Z）でもありません。`] };
    }
    const { product, version: branchVersion } = release;
    const productLabels = labelsByProduct.get(product) ?? [];
    const isCherryPick = labels.includes('cherry-pick');

    // cherry-pick は他の製品のラベルを残せる。元のラベルがアーカイブ済みなら、リリースラベルなしでもよい。
    if (!isCherryPick) {
      for (const releaseLabel of releaseLabels) {
        if (releaseLabel.product !== product) {
          errors.push(`${releaseLabel.label}：${product} のリリースブランチへの PR には、${product} のリリースラベルだけを付けてください。`);
        }
      }
      if (productLabels.length === 0) {
        errors.push(`${product} に影響する変更ですが、${product} のリリースラベルが付いていません。`);
      }
    }
    if (productLabels.length > 1) {
      errors.push(`${product} のリリースラベルが複数あります（${productLabels.map((label) => label.label).join('、')}）。製品ごとに 1 つだけ付けてください。`);
    }

    // マージ先と同じか、それより古い既存のリリースブランチのバージョンにする。
    // cherry-pick なら元のラベルのブランチは削除済みでもよいが、マージ先より新しいラベルは通さない。
    for (const { label, version } of productLabels) {
      const target = `マージ先のブランチのバージョン（v${branchVersion}）`;
      if (compareVersions(version, branchVersion) > 0) {
        errors.push(`${label}：${target}より新しいバージョンです。`);
      } else if (!isCherryPick && version !== branchVersion && !hasBranch(product, version)) {
        errors.push(`${label}：${product} に v${version} のリリースブランチがありません（リリース済みか、まだ作っていません）。${target}か、それより古い今あるリリースブランチのバージョンを付けてください。`);
      }
    }
  }

  // VERSION を変える PR にラベルを付けるなら、変更後のバージョンにする。
  for (const product of products) {
    if (release && product !== release.product) continue;
    const before = versionsBeforeMerge[product];
    const after = versionsAfterMerge[product];
    if (before === undefined || before === after) continue;

    for (const { label, version } of labelsByProduct.get(product) ?? []) {
      if (version !== after) errors.push(`${label}：VERSION の ${product} を ${after} にする PR には、${product}/v${after} を付けてください。`);
    }
  }

  return { errors };
}

function checkVersions({ baseBranch, versionFileAfterMerge, versionFileBeforeMerge }: VersionCheckInput): { errors: string[] } {
  const release = parseReleaseBranch(baseBranch);
  // マージ先の形式はラベルのチェックで確かめる。VERSION の規則は main とリリースブランチに適用する。
  if (baseBranch !== 'main' && !release) return { errors: [] };
  const versionsAfterMerge = parseVersionFile(versionFileAfterMerge);
  const errors: string[] = [];

  // release では、マージ後の VERSION をマージ先のバージョンと一致させる。
  if (release) {
    if (versionsAfterMerge[release.product] !== release.version) {
      errors.push(
        `マージ後の VERSION（${release.product}/${versionsAfterMerge[release.product]}）が、マージ先のブランチのバージョン（v${release.version}）と一致しません。先に VERSION を上げるか、作業ブランチを切ったブランチを確かめてください。`,
      );
    }
    return { errors };
  }

  // main では、既存の製品の VERSION を下げない。上げるときはパッチを 0 にする。
  const versionsBeforeMerge = parseVersionFile(versionFileBeforeMerge);
  for (const product of Object.keys(versionsAfterMerge)) {
    const before = versionsBeforeMerge[product];
    const after = versionsAfterMerge[product];
    if (before === undefined || before === after) continue;

    if (compareVersions(after, before) < 0) {
      errors.push(`VERSION の ${product} を ${before} から ${after} に下げています。`);
    } else if (parseVersion(after)![2] !== 0) {
      errors.push(`VERSION の ${product} を ${after} にしています。main のバージョンは、パッチを 0 にしてください（マイナーかメジャーを上げる。パッチは修正フェーズで使います）。`);
    }
  }

  return { errors };
}

// PR の変更が、product の version のリリースに入るべきか（開発ルールの「リリースラベル」）。
// 通常リリースはラベルのバージョン以上、修正フェーズはそのバージョンのラベルを明示したものだけ。
// リリースブランチにマージした PR は、そのブランチのバージョンまで。
// cherry-pick ラベルの PR は、元の PR の変更を運ぶものなので数えない。ブランチ名では判定しない。
// pull: { base, head, labels }（labels はラベルの名前）
function belongsTo(pull: LabeledPullRequest, product: string, version: string): boolean {
  if (pull.labels.includes('cherry-pick')) return false;
  const base = parseReleaseBranch(pull.base);
  if (pull.base !== 'main' && !(base?.product === product && compareVersions(version, base.version) <= 0)) return false;
  return extractReleaseLabels(pull.labels, [product]).some((label) =>
    parseVersion(version)![2] === 0 ? compareVersions(label.version, version) <= 0 : label.version === version,
  );
}

// リリースの準備（開発ルールの「main ブランチにおいて機能の開発は終了しリリース前の準備フェーズに入りたい場合」）で、
// main の今のバージョンから作るリリースブランチと、次のバージョン（bump は minor か major）とそのリリースラベルを決める。
function planNormalReleasePrep({ versionFile, product, bump }: { versionFile: string; product: string; bump: string }) {
  const currentVersion = parseVersionFile(versionFile)[product];
  const [major, minor] = parseVersion(currentVersion)!;
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
function planHotfixReleasePrep({ product, tags }: { product: string; tags: string[] }) {
  const prefix = `${product}/v`;
  const released = tags.filter((tag) => tag.startsWith(prefix) && parseVersion(tag.slice(prefix.length))).map((tag) => tag.slice(prefix.length));
  if (released.length === 0) {
    return { error: `${product} のリリースタグ（${product}/vX.Y.Z）がまだありません。` };
  }
  const releasedVersion = released.sort(compareVersions).at(-1)!;
  const [major, minor, patch] = parseVersion(releasedVersion)!;
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
function planRelease({ branch, tags }: { branch: string; tags: string[] }) {
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
function setVersion(versionFile: string, product: string, version: string): string {
  return versionFile
    .split('\n')
    .map((line) => (line.trim().split('/')[0] === product && !line.trim().startsWith('#') ? `${product}/${version}` : line))
    .join('\n');
}

export {
  belongsTo,
  checkReleaseLabels,
  checkVersions,
  compareVersions,
  extractReleaseLabels,
  findAffectedProducts,
  parseCherryPickBranch,
  parseMergeQueueBranch,
  parseReleaseBranch,
  parseVersionFile,
  planHotfixReleasePrep,
  planRelease,
  planNormalReleasePrep,
  setVersion,
};
