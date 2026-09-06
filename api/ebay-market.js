const MODEL = "gpt-5.6-luna";

function clean(value) {
  return String(value || "")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function parseJson(text) {
  const raw = String(text || "")
    .replace(/```json\s*/gi, "")
    .replace(/```[a-zA-Z]*\n?/g, "")
    .replace(/```/g, "")
    .trim();
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(raw.slice(start, end + 1));
  } catch (_) {
    return null;
  }
}

function responseText(data) {
  if (typeof data?.output_text === "string") return data.output_text.trim();
  const parts = [];
  for (const item of data?.output || []) {
    for (const content of item?.content || []) {
      if (typeof content?.text === "string") parts.push(content.text);
    }
  }
  return parts.join("\n").trim();
}

function sources(data) {
  const out = [];
  const seen = new Set();
  const add = source => {
    const url = String(source?.url || source?.link || source?.uri || "").trim();
    if (url && !seen.has(url)) {
      seen.add(url);
      out.push(url);
    }
  };

  for (const item of data?.output || []) {
    for (const source of item?.sources || []) add(source);
    for (const source of item?.action?.sources || []) add(source);
    for (const content of item?.content || []) {
      for (const source of content?.sources || []) add(source);
      for (const annotation of content?.annotations || []) {
        if (annotation?.type === "url_citation") add(annotation);
      }
    }
  }

  return out.slice(0, 50);
}

function ebayUrl(value, itemOnly = false) {
  try {
    const url = new URL(String(value || ""));
    const host = url.hostname.toLowerCase();
    const isEbay = host === "ebay.com" || host.endsWith(".ebay.com");
    return url.protocol === "https:" && isEbay && (!itemOnly || /\/itm\//i.test(url.pathname));
  } catch (_) {
    return false;
  }
}

function ebayItemId(value) {
  if (!ebayUrl(value, true)) return "";
  try {
    const url = new URL(String(value));
    const parts = url.pathname.split("/").filter(Boolean);
    const itmIndex = parts.findIndex(part => part.toLowerCase() === "itm");
    if (itmIndex < 0) return "";
    for (let i = parts.length - 1; i > itmIndex; i -= 1) {
      const match = String(parts[i]).match(/(\d{8,})/);
      if (match) return match[1];
    }
    return "";
  } catch (_) {
    return "";
  }
}

function uniqueUrls(values, itemOnly = false) {
  const seen = new Set();
  return (Array.isArray(values) ? values : [])
    .map(String)
    .map(value => value.trim())
    .filter(value => {
      if (!ebayUrl(value, itemOnly)) return false;
      const key = itemOnly ? ebayItemId(value) : value;
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 16);
}

function verifiedItemUrls(values, webSources) {
  const sourceIds = new Set(
    uniqueUrls(webSources, true)
      .map(ebayItemId)
      .filter(Boolean)
  );
  return uniqueUrls(values, true).filter(url => sourceIds.has(ebayItemId(url)));
}

function normalizeText(value) {
  return String(value || "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[‐‑‒–—―]/g, "-")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeModelNumber(value) {
  return normalizeText(value).replace(/[^a-z0-9]/g, "");
}

function modelNumberMatchesValue(actual, expected) {
  const actualValue = normalizeModelNumber(actual);
  const expectedValue = normalizeModelNumber(expected);
  if (!expectedValue) return true;
  return actualValue === expectedValue;
}

function caseSizeMatchesValue(actual, expected) {
  const actualValue = Number(String(actual ?? "").match(/(\d+(?:\.\d+)?)/)?.[1]);
  const expectedValue = Number(String(expected ?? "").match(/(\d+(?:\.\d+)?)/)?.[1]);
  if (!Number.isFinite(expectedValue)) return true;
  if (!Number.isFinite(actualValue)) return false;
  return Math.abs(actualValue - expectedValue) <= 0.2;
}

const DIAL_GROUPS = [
  { target: /(シャンパン|しゃんぱん|champagne)/i, value: /(シャンパン|しゃんぱん|champagne)/i },
  { target: /(ブラック|黒|black)/i, value: /(ブラック|黒|black)/i },
  { target: /(ブルー|青|blue)/i, value: /(ブルー|青|blue)/i },
  { target: /(シルバー|銀|silver)/i, value: /(シルバー|銀|silver)/i },
  { target: /(ホワイト|白|white)/i, value: /(ホワイト|白|white)/i },
  { target: /(グレー|灰|gray|grey)/i, value: /(グレー|灰|gray|grey)/i },
  { target: /(グリーン|緑|green)/i, value: /(グリーン|緑|green)/i },
  { target: /(ゴールド|金色|gold)/i, value: /(ゴールド|金色|gold)/i },
  { target: /(ピンク|pink)/i, value: /(ピンク|pink)/i },
  { target: /(レッド|赤|red)/i, value: /(レッド|赤|red)/i },
  { target: /(ブラウン|茶|brown)/i, value: /(ブラウン|茶|brown)/i }
];

const SPECIAL_DIALS = [
  { target: /(ダイヤ|diamond|10p|8p)/i, value: /(ダイヤ|diamond|10p|8p)/i },
  { target: /(ピラミッド|pyramid)/i, value: /(ピラミッド|pyramid)/i },
  { target: /(タペストリー|tapestry)/i, value: /(タペストリー|tapestry)/i },
  { target: /(シェル|マザーオブパール|mother of pearl|\bmop\b)/i, value: /(シェル|マザーオブパール|mother of pearl|\bmop\b)/i },
  { target: /(カスタム|custom|社外|aftermarket)/i, value: /(カスタム|custom|社外|aftermarket)/i }
];

function dialValueMatches(actualDial, facts) {
  const target = normalizeText(`${facts?.dialColor || ""} ${facts?.color || ""}`);
  if (!target) return true;

  const actual = normalizeText(actualDial);
  if (!actual) return false;

  const targetGroups = DIAL_GROUPS.filter(group => group.target.test(target));
  if (targetGroups.length > 0 && !targetGroups.some(group => group.value.test(actual))) {
    return false;
  }

  for (const special of SPECIAL_DIALS) {
    const targetHasSpecial = special.target.test(target);
    const actualHasSpecial = special.value.test(actual);
    if (actualHasSpecial && !targetHasSpecial) return false;
  }

  return true;
}

function targetIsBodyOnly(accessories) {
  return /(本体のみ|時計のみ|watch only|head only)/i.test(String(accessories || ""));
}

function obviousBadComparable(title) {
  return /(for\s+parts|parts\s+only|junk|repair|project\s+watch|empty\s+box|box\s+only)/i.test(String(title || ""));
}

function normalizedConditionGroup(value) {
  const text = normalizeText(value);
  if (!text) return "";
  if (/(parts|部品|ジャンク|repair)/i.test(text)) return "parts";
  if (/(new|新品|未使用)/i.test(text)) return "new";
  if (/(pre-owned|used|中古|excellent|good|very good)/i.test(text)) return "used";
  return "other";
}

function factsOnly(input) {
  const src = input && typeof input === "object" ? input : {};
  for (const forbidden of ["serialNumber", "serial", "dateCode", "manufacturingCode"]) {
    if (Object.prototype.hasOwnProperty.call(src, forbidden)) {
      throw new Error("serial/date code is forbidden");
    }
  }

  const allow = [
    "schema",
    "kind",
    "categoryId",
    "categoryName",
    "brandEnglish",
    "modelNumber",
    "verifiedProductNameEnglish",
    "productNameJapanese",
    "lineName",
    "categoryValue",
    "gender",
    "color",
    "dialColor",
    "purity",
    "material",
    "caseSize",
    "driveType",
    "accessories",
    "aiDescriptionJa",
    "aiKeywordsJa",
    "conditionName",
    "deterministicTitle"
  ];

  const out = {};
  for (const key of allow) {
    const value = src[key];
    if (value === null || value === undefined || String(value).trim() === "") continue;
    out[key] = typeof value === "string" ? value.slice(0, 1500) : value;
  }
  return out;
}

async function searchWeb(prompt, searchContextSize = "high") {
  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`
    },
    body: JSON.stringify({
      model: MODEL,
      tools: [
        {
          type: "web_search",
          search_context_size: searchContextSize,
          user_location: { type: "approximate", country: "JP" }
        }
      ],
      tool_choice: "auto",
      include: ["web_search_call.action.sources"],
      input: prompt
    })
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data?.error?.message || data?.error || `OpenAI Responses API error: ${response.status}`);
  }

  return {
    text: responseText(data),
    sources: sources(data)
  };
}

function buildDiscoveryPrompt(facts) {
  return `あなたは日本の中古ブランド品販売会社向けeBay.com成約事例探索担当です。

確定済み情報:
${JSON.stringify(facts, null, 2)}

WEB検索でeBay.comのSold/Completed商品候補を探してください。
この段階では価格算定をしません。実際に検索で確認したeBay item URLだけを候補として最大10件返してください。
serial/date codeは使用禁止です。部品取り、ジャンク、箱のみ、別型番は除外してください。

時計の場合:
- modelNumberがある場合は同じ型番だけ。
- caseSizeがある場合は同じケースサイズだけ。
- dialColorまたはcolorがある場合は同じ文字盤色・文字盤仕様を優先し、明示的に異なる文字盤は候補に入れない。
- 対象にないDiamond、Pyramid、Tapestry、MOP/Mother of Pearl、Custom/Aftermarket等の特殊文字盤は候補に入れない。
- Box/Papers/Full Set付きは除外しない。対象が本体のみなら、後段で上限寄りの補助比較として扱う。
- Best Offer acceptedのSoldも候補に含めてよい。実際の受諾価格が非公開の場合は後段で上限参考として扱う。

JSONのみ返してください:
{"candidateUrls":["https://www.ebay.com/itm/..."],"reasonJa":"短い理由"}
候補が2件未満ならcandidateUrlsは見つかった分だけ返してください。URLを推測・生成してはいけません。`;
}

function extractDiscoveryCandidates(parsed, webSources) {
  const requested = uniqueUrls(parsed?.candidateUrls, true);
  return verifiedItemUrls(requested, webSources).slice(0, 10);
}

function buildVerificationPrompt(facts, candidateUrls) {
  return `あなたはeBay.com中古ブランド品の成約根拠を検証する担当です。
以下の候補URLを1件ずつ実際に確認し、対象商品と条件が合うSold/CompletedだけをverifiedComparablesへ返してください。

対象商品の確定情報:
${JSON.stringify(facts, null, 2)}

候補URL:
${JSON.stringify(candidateUrls, null, 2)}

商品一致ルール:
- 必ず各候補のeBay商品ページを確認する。
- Sold/Completedであることが確認できないものは除外。
- URL、型番、ケースサイズ、文字盤、付属品、Conditionを推測しない。
- 時計はmodelNumber一致必須。caseSizeがある場合は一致必須。
- dialColorまたはcolorがある場合は同じ文字盤色・文字盤仕様だけ採用し、明示的に異なる文字盤は除外。
- 対象にないDiamond、Pyramid、Tapestry、MOP/Mother of Pearl、Custom/Aftermarket等の特殊文字盤は除外。
- 部品取り、ジャンク、修理前提は除外。
- Box/Papers付きは除外しない。対象が本体のみの場合はaccessoryUpperBound=trueとして上限寄りの補助比較にする。

価格ルール:
- US $0.00は価格根拠として使わない。
- exactSoldPriceUsdには、ページ上で実際の成約価格が明示され、Best Offer等で価格非公開ではない場合だけ実売価格を入れる。該当しなければ0。
- Best Offer acceptedで実際の受諾価格が非公開の場合はbestOfferAccepted=trueとし、ページ上の元の表示価格・出品価格が確認できる場合だけdisplayedUpperBoundUsdへ入れる。これは実売価格ではなく上限参考値。
- 取消線の価格、現在の再出品価格、類似商品の価格はexactSoldPriceUsdに絶対に入れない。
- currentOrRelistedPrice=trueのものは価格根拠に使わない。
- 対象が本体のみでBox/Papers付きの場合、その価格はactual sale priceが明示されていても上限寄りの補助比較として扱う。
- 条件一致のSold/Completedが2件未満ならok=false。近い仕様へ広げない。
- 2件以上の条件一致Soldがあり、そのうち少なくとも1件に比較可能な価格情報（exactSoldPriceUsd > 0 または displayedUpperBoundUsd > 0）がある場合だけpricingを作成してよい。
- pricingはexactSoldPriceUsdを最優先する。Best OfferのdisplayedUpperBoundUsdと、対象が本体のみのときのBox/Papers付き成約価格は上限参考にのみ使う。
- QUICK/TARGET/HIGHは保守的に算定し、上限参考値を実売価格として扱わない。

各verifiedComparablesに以下を必ず返してください:
url, title, soldStatusConfirmed, exactSoldPriceUsd, displayedUpperBoundUsd,
bestOfferAccepted, currentOrRelistedPrice, modelNumber, caseSizeMm, dialColor,
specialDial, hasBox, hasPapers, accessoryUpperBound, condition, verificationReasonJa

JSONのみ返してください:
{
  "ok":true,
  "pricing":{"quickUsd":0,"targetUsd":0,"highUsd":0},
  "confidence":"high|medium",
  "reasonJa":"短い日本語理由",
  "verifiedComparables":[
    {
      "url":"https://www.ebay.com/itm/...",
      "title":"",
      "soldStatusConfirmed":true,
      "exactSoldPriceUsd":0,
      "displayedUpperBoundUsd":0,
      "bestOfferAccepted":false,
      "currentOrRelistedPrice":false,
      "modelNumber":"",
      "caseSizeMm":0,
      "dialColor":"",
      "specialDial":"none",
      "hasBox":false,
      "hasPapers":false,
      "accessoryUpperBound":false,
      "condition":"",
      "verificationReasonJa":""
    }
  ]
}
失敗時:
{"ok":false,"reasonJa":"条件を満たす成約事例または価格根拠が不足","verifiedComparables":[]}`;
}

function verifiedComparableMatchesFacts(item, facts) {
  if (!item || typeof item !== "object") return false;

  const url = String(item.url || "").trim();
  const title = clean(item.title);
  if (!ebayUrl(url, true) || !title || obviousBadComparable(title)) return false;
  if (item.soldStatusConfirmed !== true) return false;
  if (item.currentOrRelistedPrice === true) return false;

  if (facts?.modelNumber && !modelNumberMatchesValue(item.modelNumber, facts.modelNumber)) return false;

  if (String(facts?.kind || "").toLowerCase() === "watch") {
    if (facts?.caseSize && !caseSizeMatchesValue(item.caseSizeMm, facts.caseSize)) return false;
    if ((facts?.dialColor || facts?.color) && !dialValueMatches(item.dialColor, facts)) return false;

    const specialDial = normalizeText(item.specialDial || "");
    if (
      specialDial
      && specialDial !== "none"
      && specialDial !== "なし"
      && !dialValueMatches(`${item.dialColor || ""} ${specialDial}`, facts)
    ) {
      return false;
    }
  }

  const targetCondition = normalizedConditionGroup(facts?.conditionName);
  const actualCondition = normalizedConditionGroup(item.condition);
  if (actualCondition === "parts") return false;
  if (targetCondition && actualCondition && actualCondition !== "other" && targetCondition !== actualCondition) {
    return false;
  }

  return true;
}

function priceEvidence(item, facts) {
  const exactSoldPriceUsd = Number(item.exactSoldPriceUsd);
  const displayedUpperBoundUsd = Number(item.displayedUpperBoundUsd);
  const bodyOnly = targetIsBodyOnly(facts?.accessories);
  const accessoryUpperBound = bodyOnly && (item.hasBox === true || item.hasPapers === true || item.accessoryUpperBound === true);
  const bestOfferUpperBound = item.bestOfferAccepted === true;

  let exactPrice = 0;
  let upperBound = 0;

  if (Number.isFinite(exactSoldPriceUsd) && exactSoldPriceUsd > 0) {
    if (accessoryUpperBound) {
      upperBound = exactSoldPriceUsd;
    } else if (!bestOfferUpperBound) {
      exactPrice = exactSoldPriceUsd;
    }
  }

  if (Number.isFinite(displayedUpperBoundUsd) && displayedUpperBoundUsd > 0) {
    upperBound = upperBound > 0
      ? Math.min(upperBound, displayedUpperBoundUsd)
      : displayedUpperBoundUsd;
  }

  return { exactPrice, upperBound, accessoryUpperBound, bestOfferUpperBound };
}

function validateVerifiedResult(parsed, verificationSources, discoveryCandidates, facts) {
  const confidence = clean(parsed?.confidence).toLowerCase();
  const reasonJa = clean(parsed?.reasonJa || parsed?.reason);
  const pricing = parsed?.pricing || {};
  const quickUsd = Math.ceil(Number(pricing.quickUsd));
  const targetUsd = Math.ceil(Number(pricing.targetUsd));
  const highUsd = Math.ceil(Number(pricing.highUsd));

  const discoveryIds = new Set(discoveryCandidates.map(ebayItemId).filter(Boolean));
  const verificationSourceIds = new Set(
    uniqueUrls(verificationSources, true)
      .map(ebayItemId)
      .filter(Boolean)
  );
  const seenIds = new Set();

  const comparables = (Array.isArray(parsed?.verifiedComparables) ? parsed.verifiedComparables : [])
    .map(item => ({
      url: String(item?.url || "").trim(),
      title: clean(item?.title),
      soldStatusConfirmed: item?.soldStatusConfirmed === true,
      exactSoldPriceUsd: Math.ceil(Number(item?.exactSoldPriceUsd)),
      displayedUpperBoundUsd: Math.ceil(Number(item?.displayedUpperBoundUsd)),
      bestOfferAccepted: item?.bestOfferAccepted === true,
      currentOrRelistedPrice: item?.currentOrRelistedPrice === true,
      modelNumber: clean(item?.modelNumber),
      caseSizeMm: item?.caseSizeMm,
      dialColor: clean(item?.dialColor),
      specialDial: clean(item?.specialDial),
      hasBox: item?.hasBox === true,
      hasPapers: item?.hasPapers === true,
      accessoryUpperBound: item?.accessoryUpperBound === true,
      condition: clean(item?.condition),
      verificationReasonJa: clean(item?.verificationReasonJa)
    }))
    .filter(item => {
      const id = ebayItemId(item.url);
      if (!id || seenIds.has(id)) return false;
      if (!discoveryIds.has(id) || !verificationSourceIds.has(id)) return false;
      if (!verifiedComparableMatchesFacts(item, facts)) return false;
      seenIds.add(id);
      return true;
    })
    .map(item => ({ ...item, ...priceEvidence(item, facts) }))
    .slice(0, 6);

  const pricedComparables = comparables.filter(item => item.exactPrice > 0 || item.upperBound > 0);
  const exactPrices = comparables.map(item => item.exactPrice).filter(value => value > 0);
  const upperBounds = comparables.map(item => item.upperBound).filter(value => value > 0);

  const priceOk = [quickUsd, targetUsd, highUsd].every(value => Number.isFinite(value) && value > 0)
    && quickUsd <= targetUsd
    && targetUsd <= highUsd;

  const maxEvidence = Math.max(0, ...exactPrices, ...upperBounds);
  const minExact = exactPrices.length > 0 ? Math.min(...exactPrices) : 0;
  const pricingWithinEvidence = priceOk
    && maxEvidence > 0
    && highUsd <= Math.ceil(maxEvidence * 1.02)
    && (minExact <= 0 || quickUsd >= Math.floor(minExact * 0.70));

  if (
    parsed?.ok !== true
    || comparables.length < 2
    || pricedComparables.length < 1
    || exactPrices.length < 1
    || !pricingWithinEvidence
    || !["high", "medium"].includes(confidence)
    || !reasonJa
  ) {
    return {
      ok: false,
      needsManualSoldInput: true,
      reason: "条件一致のeBay Sold/Completed実績は確認できましたが、自動価格に使える実売価格根拠が不足したためAI価格は採用しません。",
      evidenceUrls: uniqueUrls(verificationSources, false),
      comparables,
      webModel: MODEL,
      researchedAt: new Date().toISOString()
    };
  }

  return {
    ok: true,
    pricing: { quickUsd, targetUsd, highUsd },
    confidence,
    reasonJa,
    soldUrls: comparables.map(item => item.url).slice(0, 3),
    evidenceUrls: uniqueUrls(verificationSources, false),
    comparables,
    webModel: MODEL,
    researchedAt: new Date().toISOString()
  };
}

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Cache-Control", "no-store");

  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ ok: false, error: "POST required" });
  if (!process.env.OPENAI_API_KEY) {
    return res.status(500).json({ ok: false, error: "OPENAI_API_KEY is not configured" });
  }

  try {
    const facts = factsOnly(req.body?.facts || {});
    if (!facts.categoryId || !facts.brandEnglish) {
      return res.status(400).json({ ok: false, error: "categoryId and brandEnglish are required" });
    }

    const discovery = await searchWeb(buildDiscoveryPrompt(facts), "high");
    const discoveryParsed = parseJson(discovery.text);
    const candidateUrls = extractDiscoveryCandidates(discoveryParsed, discovery.sources);

    if (candidateUrls.length < 2) {
      return res.status(200).json({
        ok: false,
        needsManualSoldInput: true,
        reason: clean(discoveryParsed?.reasonJa || "条件に合うeBay Sold/Completed候補を2件以上確認できませんでした。"),
        evidenceUrls: uniqueUrls(discovery.sources),
        comparables: [],
        webModel: MODEL,
        researchedAt: new Date().toISOString()
      });
    }

    const verification = await searchWeb(buildVerificationPrompt(facts, candidateUrls), "high");
    const verificationParsed = parseJson(verification.text);

    if (!verificationParsed) {
      return res.status(200).json({
        ok: false,
        needsManualSoldInput: true,
        reason: "eBay成約根拠の再検証結果を安全に解析できなかったため、AI価格は採用しません。",
        evidenceUrls: uniqueUrls(verification.sources),
        comparables: [],
        webModel: MODEL,
        researchedAt: new Date().toISOString()
      });
    }

    return res.status(200).json(
      validateVerifiedResult(verificationParsed, verification.sources, candidateUrls, facts)
    );
  } catch (error) {
    return res.status(500).json({
      ok: false,
      needsManualSoldInput: true,
      error: error instanceof Error ? error.message : String(error),
      webModel: MODEL,
      researchedAt: new Date().toISOString()
    });
  }
};
