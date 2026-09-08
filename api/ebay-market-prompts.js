const core = require("./ebay-market-core");

function searchTermsForColor(facts) {
  const target = core.norm(facts?.dialColor || facts?.color || "");
  if (!target) return [];
  if (/(シャンパン|champagne)/i.test(target)) return ["Champagne", "Gold Dial", "Gold Tone Dial", "Yellow Gold Dial"];
  if (/(ブラック|黒|black)/i.test(target)) return ["Black", "Black Dial", "Black Face"];
  if (/(ブルー|青|blue)/i.test(target)) return ["Blue", "Blue Dial", "Blue Face"];
  if (/(シルバー|銀|silver)/i.test(target)) return ["Silver", "Silver Dial", "Silver Face"];
  if (/(ホワイト|白|white)/i.test(target)) return ["White", "White Dial", "White Face"];
  if (/(グレー|灰|gray|grey)/i.test(target)) return ["Gray", "Grey", "Gray Dial", "Grey Dial"];
  if (/(グリーン|緑|green)/i.test(target)) return ["Green", "Green Dial", "Green Face"];
  if (/(ゴールド|金色|gold)/i.test(target)) return ["Gold", "Gold Dial", "Gold Tone"];
  if (/(ブラウン|茶|brown|chocolate)/i.test(target)) return ["Brown", "Brown Dial", "Chocolate"];
  return [core.clean(facts?.dialColor || facts?.color || "")].filter(Boolean);
}

function searchProfile(facts) {
  const identity = [
    core.clean(facts?.brandEnglish),
    core.clean(facts?.verifiedProductNameEnglish || facts?.lineName || facts?.productNameJapanese),
    core.clean(facts?.modelNumber)
  ].filter(Boolean).join(" ");
  const colors = searchTermsForColor(facts);
  const size = core.clean(facts?.caseSize);
  const queries = [];
  const add = value => { const q = core.clean(value); if (q && !queries.includes(q)) queries.push(q); };
  add(identity);
  for (const color of colors.slice(0, 3)) {
    add(`${identity} ${color}`);
    if (size) add(`${core.clean(facts?.brandEnglish)} ${core.clean(facts?.modelNumber)} ${size}mm ${color}`);
  }
  if (facts?.material) add(`${identity} ${facts.material}`);
  if (facts?.purity) add(`${identity} ${facts.purity}`);
  return queries.slice(0, 8);
}

function discoveryPrompt(facts, excludedUrls = [], recoveryContext = "") {
  return `あなたはeBay.comの中古ブランド品Sold/Completed事例の探索担当です。

対象商品の確定情報（生成説明ではなく、入力・検証済み項目だけ）:
${JSON.stringify(facts, null, 2)}

検索クエリの例:
${JSON.stringify(searchProfile(facts), null, 2)}

既出URL（再提出禁止）:
${JSON.stringify(excludedUrls, null, 2)}
${recoveryContext ? `\n前回検証で不足した点:\n${recoveryContext}\n` : ""}

目的は、同一商品の実際のeBay.com Sold/Completed候補を広く集めることです。価格算定はしません。
- 実際にWEB検索で確認したeBay item URLだけを返す。URLを推測・生成しない。
- modelNumberがある場合は同一型番を最優先。明示的な別型番は除外。
- タイトルだけでなくItem specificsと説明も検索結果から確認する。
- 対象属性（文字盤色/色、ケースサイズ、素材、純度、性別）が未記載なら候補に残す。明示的に異なる場合だけ除外。
- 時計の対象文字盤色そのものを除外しない。シャンパンだけはDial ColorのChampagne / Gold / Gold Tone / Yellow Goldを同系統候補としてよい。
- 対象にないDiamond/Pyramid/Tapestry/MOP/Computer/Jubilee-pattern/Linen/Houndstooth/Custom/Aftermarket等の特殊文字盤は除外。
- 部品取り、ジャンク、空箱のみ、文字盤単体など商品本体でないものは除外。
- Box/Papers付き、Best Offer accepted、非USD表示は候補から除外しない。後段で価格根拠の強さを判定する。
- serial/date codeは対象商品の照合キーや検索語として使用しない。ただし候補出品にその出品固有のシリアル、年式、日付コードが書かれているだけで除外してはいけない。
- 1種類の検索語で終わらず、型番中心、商品名中心、属性あり/なしの複数検索を試す。

最大${core.MAX_DISCOVERY_CANDIDATES}件。JSONのみ:
{"candidateUrls":["https://www.ebay.com/itm/..."],"reasonJa":"探索結果の短い説明"}`;
}

function verificationPrompt(facts, urls) {
  return `あなたはeBay.com中古ブランド品の成約根拠検証担当です。

対象商品の確定情報:
${JSON.stringify(facts, null, 2)}

候補URL:
${JSON.stringify(urls, null, 2)}

各URLを実際にWEBで確認し、候補ごとに観測できた事実を返してください。価格相場やQUICK/TARGET/HIGHは計算しません。サーバー側で算定します。
- Sold/Completedが確認できなければsoldStatusConfirmed=false。
- 型番、商品名、ケースサイズ、文字盤色/色、素材、純度、性別、Condition、付属品を推測しない。未記載は空文字または0。
- modelNumberがある対象では同一型番を確認。タイトルに明記される場合も記録する。
- 時計はcaseSizeとDial ColorをタイトルだけでなくItem specifics・説明で確認。シャンパンだけはDial Colorとして明示されたChampagne / Gold / Gold Tone / Yellow Goldを同系統としてよい。ケースやブレスがGoldという理由で文字盤色を推測しない。
- 対象にない特殊文字盤/Custom/AftermarketはspecialVariantへ明記。
- 非時計でも、対象にcolor/material/purity/genderがあれば実際に確認できた値を返す。
- modelNumberがない商品では、対象の商品名/ラインと同一商品と確認できればidentityMatchStatus="confirmed"、明示的に別商品/別ラインなら"mismatch"、確認不足なら"unconfirmed"。
- targetが本体のみでBox/Papers付きならhasBox/hasPapersを正確に返す。
- ConditionはExcellent/Goodなど細かな評価を推測せず、NewかPre-owned/UsedかPartsかを正確に返す。

価格根拠:
- soldページ上で実際のUSD成約価格が明示されている場合だけexactSoldPriceUsdへ入れ、priceEvidenceType="exact_usd_sold"。
- Best Offer acceptedで受諾価格非公開ならexactSoldPriceUsd=0。元の表示価格が確認できればdisplayedUpperBoundUsdへ入れ、priceEvidenceType="best_offer_upper"。
- 非USD成約はoriginalSoldPriceとoriginalCurrencyに記録。eBayが概算USDを表示している場合だけconvertedUsdDisplayへ入れ、priceEvidenceType="non_usd_sold"。exactSoldPriceUsdには入れない。
- 現在価格・再出品価格しか確認できない場合はpriceEvidenceType="relisted_or_current"で、exactSoldPriceUsd=0。
- US $0.00、取消線の元価格、類似商品価格を実売価格にしない。
- Sold元ページの実売価格を確認でき、別に再出品も存在する場合はSold元価格をexactSoldPriceUsdへ入れてよい。currentOrRelistedPriceは今回記録した価格が現在/再出品価格の場合だけtrue。

全候補を返してください。除外相当でも理由をverificationReasonJaへ書きます。JSONのみ:
{"comparables":[{"url":"https://www.ebay.com/itm/...","title":"","soldStatusConfirmed":true,"modelNumber":"","productNameEnglish":"","lineName":"","identityMatchStatus":"confirmed|mismatch|unconfirmed","caseSizeMm":0,"dialColor":"","color":"","material":"","purity":"","gender":"","specialVariant":"none","hasBox":false,"hasPapers":false,"condition":"","exactSoldPriceUsd":0,"displayedUpperBoundUsd":0,"convertedUsdDisplay":0,"originalSoldPrice":0,"originalCurrency":"","priceEvidenceType":"exact_usd_sold|best_offer_upper|non_usd_sold|relisted_or_current|none","bestOfferAccepted":false,"currentOrRelistedPrice":false,"verificationReasonJa":""}]}`;
}

module.exports = { searchTermsForColor, searchProfile, discoveryPrompt, verificationPrompt };
