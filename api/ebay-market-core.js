const MODEL = "gpt-5.6-luna";
const MAX_DISCOVERY_CANDIDATES = 12;
const MAX_RECOVERY_CANDIDATES = 8;
const MAX_TOTAL_CANDIDATES = 20;
const MAX_REVIEW_URLS = 10;
const VERIFY_BATCH_SIZE = 6;

const ALLOWED_FACTS = [
  "schema", "kind", "categoryId", "categoryName", "brandEnglish", "modelNumber",
  "verifiedProductNameEnglish", "productNameJapanese", "lineName", "categoryValue",
  "gender", "color", "dialColor", "purity", "material", "caseSize", "driveType",
  "accessories", "conditionName", "deterministicTitle"
];

const COLOR_GROUPS = [
  [/(シャンパン|champagne)/i, /(シャンパン|champagne|gold(?:en)?|gold[-\s]?tone|yellow gold)/i],
  [/(ゴールド|金色|gold)/i, /(ゴールド|金色|gold(?:en)?|gold[-\s]?tone|yellow gold|champagne|シャンパン)/i],
  [/(ブラック|黒|black)/i, /(ブラック|黒|black)/i],
  [/(ブルー|青|blue)/i, /(ブルー|青|blue)/i],
  [/(シルバー|銀|silver)/i, /(シルバー|銀|silver)/i],
  [/(ホワイト|白|white)/i, /(ホワイト|白|white)/i],
  [/(グレー|灰|gray|grey)/i, /(グレー|灰|gray|grey)/i],
  [/(グリーン|緑|green)/i, /(グリーン|緑|green)/i],
  [/(ピンク|pink)/i, /(ピンク|pink)/i],
  [/(レッド|赤|red)/i, /(レッド|赤|red)/i],
  [/(ブラウン|茶|brown|chocolate)/i, /(ブラウン|茶|brown|chocolate)/i],
  [/(ベージュ|beige)/i, /(ベージュ|beige)/i],
  [/(ネイビー|navy)/i, /(ネイビー|navy)/i],
  [/(オレンジ|orange)/i, /(オレンジ|orange)/i],
  [/(パープル|紫|purple)/i, /(パープル|紫|purple)/i]
];

const WATCH_SPECIAL_VARIANTS = [
  /(ダイヤ|diamond|10p|8p)/i,
  /(ピラミッド|pyramid)/i,
  /(タペストリー|tapestry)/i,
  /(シェル|マザーオブパール|mother of pearl|\bmop\b)/i,
  /(コンピューター|computer|jubilee dial|jubilee-pattern)/i,
  /(リネン|linen)/i,
  /(ハウンドトゥース|houndstooth)/i,
  /(カスタム|custom|社外|aftermarket)/i
];

const MATERIAL_GROUPS = [
  { key: "stainless", rx: /(ステンレス|stainless|\bss\b)/i },
  { key: "yellow_gold", rx: /(イエローゴールド|yellow gold|\byg\b|k\d+(?:\.\d+)?yg)/i },
  { key: "white_gold", rx: /(ホワイトゴールド|white gold|\bwg\b|k\d+(?:\.\d+)?wg)/i },
  { key: "rose_gold", rx: /(ローズゴールド|ピンクゴールド|rose gold|pink gold|\brg\b|\bpg\b|k\d+(?:\.\d+)?(?:rg|pg))/i },
  { key: "platinum", rx: /(プラチナ|platinum|\bpt\b|pt\d{3,4})/i },
  { key: "silver", rx: /(シルバー|silver|sterling|sv925|silver925)/i },
  { key: "leather", rx: /(レザー|革|leather)/i },
  { key: "canvas", rx: /(キャンバス|canvas)/i },
  { key: "nylon", rx: /(ナイロン|nylon)/i },
  { key: "titanium", rx: /(チタン|titanium)/i },
  { key: "ceramic", rx: /(セラミック|ceramic)/i }
];

function clean(value) {
  return String(value || "").replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim();
}

function norm(value) {
  return clean(value).normalize("NFKC").toLowerCase().replace(/[‐‑‒–—―]/g, "-");
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
  try { return JSON.parse(raw.slice(start, end + 1)); } catch (_) { return null; }
}

function responseText(data) {
  if (typeof data?.output_text === "string") return data.output_text.trim();
  const out = [];
  for (const item of data?.output || []) {
    for (const content of item?.content || []) {
      if (typeof content?.text === "string") out.push(content.text);
    }
  }
  return out.join("\n").trim();
}

function sourceUrls(data) {
  const out = [];
  const seen = new Set();
  const add = source => {
    const url = String(source?.url || source?.link || source?.uri || "").trim();
    if (url && !seen.has(url)) { seen.add(url); out.push(url); }
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
  return out.slice(0, 60);
}

function ebayItemId(value) {
  try {
    const url = new URL(String(value || ""));
    if (url.protocol !== "https:") return "";
    if (!(url.hostname === "ebay.com" || url.hostname.endsWith(".ebay.com"))) return "";
    if (!/\/itm\//i.test(url.pathname)) return "";
    const parts = url.pathname.split("/").filter(Boolean);
    const itmIndex = parts.findIndex(part => part.toLowerCase() === "itm");
    for (let i = parts.length - 1; i > itmIndex; i -= 1) {
      const match = parts[i].match(/(\d{8,})/);
      if (match) return match[1];
    }
  } catch (_) {}
  return "";
}

function uniqItemUrls(values) {
  const out = [];
  const seen = new Set();
  for (const raw of Array.isArray(values) ? values : []) {
    const url = String(raw || "").trim();
    const id = ebayItemId(url);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(url);
  }
  return out;
}

function uniqEbayUrls(values) {
  const out = [];
  const seen = new Set();
  for (const raw of Array.isArray(values) ? values : []) {
    const url = String(raw || "").trim();
    if (!url || seen.has(url)) continue;
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== "https:") continue;
      if (!(parsed.hostname === "ebay.com" || parsed.hostname.endsWith(".ebay.com"))) continue;
      seen.add(url);
      out.push(url);
    } catch (_) {}
  }
  return out;
}

function marketFacts(input) {
  const src = input && typeof input === "object" ? input : {};
  for (const forbidden of ["serialNumber", "serial", "dateCode", "manufacturingCode"]) {
    if (Object.prototype.hasOwnProperty.call(src, forbidden)) throw new Error("serial/date code is forbidden");
  }
  const out = {};
  for (const key of ALLOWED_FACTS) {
    const value = src[key];
    if (value === null || value === undefined || String(value).trim() === "") continue;
    out[key] = typeof value === "string" ? value.slice(0, 800) : value;
  }
  return out;
}

function kindOf(facts) {
  return norm(facts?.kind || facts?.categoryValue || facts?.categoryName || "");
}

function normalizedModel(value) {
  return norm(value).replace(/[^a-z0-9]/g, "");
}

function titleContainsModel(title, expected) {
  const e = normalizedModel(expected);
  if (!e) return false;
  const tokens = norm(title).match(/[a-z0-9]+/g) || [];
  return tokens.some(token => token.replace(/[^a-z0-9]/g, "") === e);
}

function modelStatus(actual, title, expected) {
  const e = normalizedModel(expected);
  if (!e) return "confirmed";
  const a = normalizedModel(actual);
  if (a) return a === e ? "confirmed" : "mismatch";
  return titleContainsModel(title, expected) ? "confirmed" : "unconfirmed";
}

function numberFrom(value) {
  const match = String(value ?? "").match(/(\d+(?:\.\d+)?)/);
  return match ? Number(match[1]) : NaN;
}

function caseStatus(actual, expected) {
  const e = numberFrom(expected);
  if (!Number.isFinite(e)) return "confirmed";
  const a = numberFrom(actual);
  if (!Number.isFinite(a) || a <= 0) return "unconfirmed";
  return Math.abs(a - e) <= 0.3 ? "confirmed" : "mismatch";
}

function colorStatus(actual, expected) {
  const target = norm(expected);
  if (!target) return "confirmed";
  const observed = norm(actual);
  if (!observed || /^(unknown|unspecified|not specified|not stated|n\/a|none|-|不明|記載なし|未記載)$/.test(observed)) return "unconfirmed";
  const groups = COLOR_GROUPS.filter(([targetRx]) => targetRx.test(target));
  if (groups.length) return groups.some(([, actualRx]) => actualRx.test(observed)) ? "confirmed" : "mismatch";
  return observed.includes(target) || target.includes(observed) ? "confirmed" : "mismatch";
}

function specialWatchStatus(specialVariant, facts) {
  if (!/watch|wristwatch|時計/.test(kindOf(facts))) return "confirmed";
  const special = norm(specialVariant);
  if (!special || special === "none" || special === "なし") return "confirmed";
  const target = norm(`${facts?.dialColor || ""} ${facts?.color || ""} ${facts?.verifiedProductNameEnglish || ""} ${facts?.productNameJapanese || ""}`);
  return WATCH_SPECIAL_VARIANTS.some(rx => rx.test(special) && !rx.test(target)) ? "mismatch" : "confirmed";
}

function materialKeys(value) {
  const text = norm(value);
  if (!text) return [];
  return MATERIAL_GROUPS.filter(group => group.rx.test(text)).map(group => group.key);
}

function materialStatus(actual, expected) {
  const target = norm(expected);
  if (!target) return "confirmed";
  const observed = norm(actual);
  if (!observed) return "unconfirmed";
  const targetKeys = materialKeys(target);
  if (!targetKeys.length) return observed.includes(target) || target.includes(observed) ? "confirmed" : "unconfirmed";
  const actualKeys = new Set(materialKeys(observed));
  return targetKeys.every(key => actualKeys.has(key)) ? "confirmed" : "mismatch";
}

function purityCanonical(value) {
  const s = norm(value).replace(/\s+/g, "");
  if (!s) return "";
  if (/(pt1000|pt999)/i.test(s)) return "pt1000";
  if (/pt950/i.test(s)) return "pt950";
  if (/pt900/i.test(s)) return "pt900";
  if (/(k24|24k|au999|gold999|純金|^999(?:\.9)?$)/i.test(s)) return "24k";
  if (/(k22|22k|au916|gold916|^916$)/i.test(s)) return "22k";
  if (/(k18|18k|au750|gold750|^750$)/i.test(s)) return "18k";
  if (/(k14|14k|au585|gold585|^585$)/i.test(s)) return "14k";
  if (/(k10|10k|au417|gold417|^417$)/i.test(s)) return "10k";
  if (/(sv925|silver925|sterling|^925$)/i.test(s)) return "925";
  return s;
}

function purityStatus(actual, expected) {
  const e = purityCanonical(expected);
  if (!e) return "confirmed";
  const a = purityCanonical(actual);
  if (!a) return "unconfirmed";
  return a === e ? "confirmed" : "mismatch";
}

function genderCanonical(value) {
  const s = norm(value);
  if (!s) return "";
  if (/(unisex|ユニセックス|男女兼用)/i.test(s)) return "unisex";
  if (/(men|mens|men's|メンズ|男性)/i.test(s)) return "men";
  if (/(women|womens|women's|ladies|lady|レディース|女性)/i.test(s)) return "women";
  return "";
}

function genderStatus(actual, expected) {
  const e = genderCanonical(expected);
  if (!e) return "confirmed";
  const a = genderCanonical(actual);
  if (!a) return "unconfirmed";
  if (a === "unisex" || e === "unisex" || a === e) return "confirmed";
  return "mismatch";
}

function identityStatus(rawStatus, facts) {
  if (facts?.modelNumber) return "confirmed";
  const expected = clean(facts?.verifiedProductNameEnglish || facts?.lineName || facts?.productNameJapanese);
  if (!expected) return "confirmed";
  const status = norm(rawStatus);
  if (["confirmed", "match", "matched"].includes(status)) return "confirmed";
  if (["mismatch", "different"].includes(status)) return "mismatch";
  return "unconfirmed";
}

function conditionGroup(value) {
  const s = norm(value);
  if (!s) return "";
  if (/(parts|部品|ジャンク|repair|project)/i.test(s)) return "parts";
  if (/(new|新品|未使用)/i.test(s)) return "new";
  if (/(pre-owned|used|中古|excellent|good|very good|fair)/i.test(s)) return "used";
  return "other";
}

function conditionStatus(actual, expected) {
  const target = conditionGroup(expected);
  if (!target || target === "other") return "confirmed";
  const observed = conditionGroup(actual);
  if (!observed || observed === "other") return "unconfirmed";
  if (observed === "parts") return "mismatch";
  return observed === target ? "confirmed" : "mismatch";
}

function isBodyOnly(value) {
  return /(本体のみ|時計のみ|watch only|head only|item only)/i.test(String(value || ""));
}

function rankCandidates(candidatePool, discoverySources, limit = MAX_DISCOVERY_CANDIDATES) {
  const urls = uniqItemUrls(candidatePool);
  const sourceIds = new Set(uniqItemUrls(discoverySources).map(ebayItemId));
  const backed = urls.filter(url => sourceIds.has(ebayItemId(url)));
  const outputOnly = urls.filter(url => !sourceIds.has(ebayItemId(url)));
  return [...backed, ...outputOnly].slice(0, limit);
}

function priceEvidence(item, facts) {
  const exact = Number(item.exactSoldPriceUsd) || 0;
  const upper = Number(item.displayedUpperBoundUsd) || 0;
  const converted = Number(item.convertedUsdDisplay) || 0;
  const evidenceType = norm(item.priceEvidenceType);
  const accessoryUpper = isBodyOnly(facts?.accessories) && (item.hasBox === true || item.hasPapers === true);
  let exactPrice = 0;
  let supportPrice = 0;
  let supportType = "none";
  if (item.soldStatusConfirmed === true && exact > 0 && evidenceType === "exact_usd_sold") {
    if (accessoryUpper) { supportPrice = exact; supportType = "accessory_upper"; }
    else exactPrice = exact;
  } else if (upper > 0 && evidenceType === "best_offer_upper") {
    supportPrice = upper; supportType = "best_offer_upper";
  } else if (converted > 0 && evidenceType === "non_usd_sold") {
    supportPrice = converted; supportType = "converted_display";
  }
  return { exactPrice, supportPrice, supportType, accessoryUpper };
}

function assessComparable(raw, facts) {
  const item = {
    url: String(raw?.url || "").trim(), title: clean(raw?.title), soldStatusConfirmed: raw?.soldStatusConfirmed === true,
    exactSoldPriceUsd: Number(raw?.exactSoldPriceUsd) || 0, displayedUpperBoundUsd: Number(raw?.displayedUpperBoundUsd) || 0,
    convertedUsdDisplay: Number(raw?.convertedUsdDisplay) || 0, originalSoldPrice: Number(raw?.originalSoldPrice) || 0,
    originalCurrency: clean(raw?.originalCurrency),
    priceEvidenceType: clean(raw?.priceEvidenceType || (raw?.bestOfferAccepted ? "best_offer_upper" : (raw?.exactSoldPriceUsd > 0 ? "exact_usd_sold" : "none"))),
    bestOfferAccepted: raw?.bestOfferAccepted === true, currentOrRelistedPrice: raw?.currentOrRelistedPrice === true,
    modelNumber: clean(raw?.modelNumber), productNameEnglish: clean(raw?.productNameEnglish), lineName: clean(raw?.lineName),
    identityMatchStatus: clean(raw?.identityMatchStatus), caseSizeMm: raw?.caseSizeMm, dialColor: clean(raw?.dialColor),
    color: clean(raw?.color), material: clean(raw?.material), purity: clean(raw?.purity), gender: clean(raw?.gender),
    specialVariant: clean(raw?.specialVariant || raw?.specialDial), hasBox: raw?.hasBox === true, hasPapers: raw?.hasPapers === true,
    condition: clean(raw?.condition), verificationReasonJa: clean(raw?.verificationReasonJa)
  };
  item.id = ebayItemId(item.url);
  item.modelMatchStatus = modelStatus(item.modelNumber, item.title, facts?.modelNumber);
  const isWatch = /watch|wristwatch|時計/.test(kindOf(facts));
  item.caseMatchStatus = isWatch ? caseStatus(item.caseSizeMm, facts?.caseSize) : "confirmed";
  item.colorMatchStatus = isWatch ? colorStatus(item.dialColor, facts?.dialColor || facts?.color) : colorStatus(item.color, facts?.color);
  item.specialMatchStatus = specialWatchStatus(item.specialVariant, facts);
  item.materialMatchStatus = materialStatus(item.material, facts?.material);
  item.purityMatchStatus = purityStatus(item.purity, facts?.purity);
  item.genderMatchStatus = genderStatus(item.gender, facts?.gender);
  item.identityMatchStatus = identityStatus(item.identityMatchStatus, facts);
  item.conditionGroup = conditionGroup(item.condition);
  item.conditionMatchStatus = conditionStatus(item.condition, facts?.conditionName);
  Object.assign(item, priceEvidence(item, facts));

  const hardMismatch = [item.modelMatchStatus, item.caseMatchStatus, item.colorMatchStatus, item.specialMatchStatus,
    item.materialMatchStatus, item.purityMatchStatus, item.genderMatchStatus, item.identityMatchStatus,
    item.conditionMatchStatus].includes("mismatch");
  const requiredStatuses = [];
  if (facts?.modelNumber) requiredStatuses.push(item.modelMatchStatus);
  if (isWatch && facts?.caseSize) requiredStatuses.push(item.caseMatchStatus);
  if ((isWatch && (facts?.dialColor || facts?.color)) || (!isWatch && facts?.color)) requiredStatuses.push(item.colorMatchStatus);
  if (facts?.material) requiredStatuses.push(item.materialMatchStatus);
  if (facts?.purity) requiredStatuses.push(item.purityMatchStatus);
  if (facts?.gender) requiredStatuses.push(item.genderMatchStatus);
  if (!facts?.modelNumber && (facts?.verifiedProductNameEnglish || facts?.lineName || facts?.productNameJapanese)) requiredStatuses.push(item.identityMatchStatus);
  if (facts?.conditionName) requiredStatuses.push(item.conditionMatchStatus);
  requiredStatuses.push(item.specialMatchStatus);

  item.matchConfirmedForPricing = requiredStatuses.every(status => status === "confirmed");
  item.reviewEligible = Boolean(item.id && item.title && item.soldStatusConfirmed && !hardMismatch && item.conditionGroup !== "parts");
  item.pricingEligible = Boolean(item.reviewEligible && item.matchConfirmedForPricing);
  item.soldPriceUsd = item.exactPrice > 0 ? item.exactPrice : item.supportPrice;
  item.similarityReason = item.verificationReasonJa;
  return item;
}

function quantile(sorted, q) {
  if (!sorted.length) return 0;
  if (sorted.length === 1) return sorted[0];
  const pos = (sorted.length - 1) * q;
  const base = Math.floor(pos);
  const rest = pos - base;
  const next = sorted[base + 1];
  return next === undefined ? sorted[base] : sorted[base] + rest * (next - sorted[base]);
}

function round50(value) {
  return Math.max(50, Math.round(Number(value) / 50) * 50);
}

function derivePricing(comparables) {
  const exact = comparables.map(item => item.exactPrice).filter(value => value > 0).sort((a, b) => a - b);
  const supports = comparables.map(item => item.supportPrice).filter(value => value > 0).sort((a, b) => a - b);
  const pricedCount = comparables.filter(item => item.exactPrice > 0 || item.supportPrice > 0).length;
  if (comparables.length < 2 || pricedCount < 2 || exact.length < 1) return { ok: false, exactCount: exact.length, supportCount: supports.length, pricedCount };

  let quick, target, high;
  if (exact.length >= 2) {
    quick = Math.max(exact[0], quantile(exact, 0.25));
    target = quantile(exact, 0.50);
    high = Math.min(exact[exact.length - 1], quantile(exact, 0.75));
  } else {
    const anchor = exact[0];
    quick = anchor * 0.92;
    target = anchor;
    const upperSupport = supports.filter(value => value >= anchor * 0.95);
    high = upperSupport.length ? Math.min(anchor * 1.05, upperSupport[0]) : anchor * 1.05;
    if (high < target) high = target;
  }
  quick = round50(quick); target = round50(target); high = round50(high);
  if (quick > target) quick = target;
  if (high < target) high = target;
  const median = quantile(exact, 0.5);
  const spread = exact.length >= 2 && median > 0 ? (exact[exact.length - 1] - exact[0]) / median : 0;
  return {
    ok: true, pricing: { quickUsd: quick, targetUsd: target, highUsd: high },
    confidence: exact.length >= 4 && spread <= 0.25 ? "high" : "medium",
    exactCount: exact.length, supportCount: supports.length, pricedCount
  };
}

function mergeAndAssess(rawComparables, candidateUrls, facts) {
  const candidateIds = new Set(uniqItemUrls(candidateUrls).map(ebayItemId));
  const seen = new Set();
  const assessed = [];
  for (const raw of Array.isArray(rawComparables) ? rawComparables : []) {
    const item = assessComparable(raw, facts);
    if (!item.id || seen.has(item.id) || !candidateIds.has(item.id)) continue;
    seen.add(item.id);
    assessed.push(item);
  }
  return assessed;
}

function resultFromAssessment(assessed, evidenceUrls) {
  const review = assessed.filter(item => item.reviewEligible).slice(0, MAX_REVIEW_URLS);
  const pricingPool = review.filter(item => item.pricingEligible);
  const derived = derivePricing(pricingPool);
  const soldUrls = review.map(item => item.url).slice(0, MAX_REVIEW_URLS);
  const exactCount = derived.exactCount || 0;
  const supportCount = derived.supportCount || 0;
  const confirmedCount = pricingPool.length;
  if (!derived.ok) {
    let reason;
    if (confirmedCount < 2) reason = `対象条件まで確認できたSold事例は${confirmedCount}件です。確認可能な関連Soldは${review.length}件保持しています。`;
    else if (exactCount < 1) reason = `対象条件に一致するSold事例は${confirmedCount}件ありますが、確定USD実売価格を確認できる事例がありません。Best Offer・付属品付き・非USD表示などは参考リンクとして保持しています。`;
    else reason = `対象条件に一致するSold事例は${confirmedCount}件ありますが、自動価格算定に必要な価格根拠が不足しています。`;
    return {
      ok: false, needsManualSoldInput: true, reason, reasonJa: reason, soldUrls,
      evidenceUrls: uniqEbayUrls([...soldUrls, ...evidenceUrls]), comparables: review,
      confirmedComparableCount: confirmedCount, exactPriceComparableCount: exactCount,
      supportPriceComparableCount: supportCount, pricingMethod: "server_quantile_v3", webModel: MODEL,
      researchedAt: new Date().toISOString()
    };
  }
  const reasonJa = `対象条件まで確認できたSold事例${confirmedCount}件を使用。確定USD実売価格${derived.exactCount}件を中心に、補助価格${derived.supportCount}件は上限・参考として扱い、サーバー側で保守的に算定しました。`;
  return {
    ok: true, pricing: derived.pricing, confidence: derived.confidence, reasonJa, reason: reasonJa, soldUrls,
    evidenceUrls: uniqEbayUrls([...soldUrls, ...evidenceUrls]), comparables: review,
    confirmedComparableCount: confirmedCount, exactPriceComparableCount: derived.exactCount,
    supportPriceComparableCount: derived.supportCount, pricingMethod: "server_quantile_v3", webModel: MODEL,
    researchedAt: new Date().toISOString()
  };
}

module.exports = {
  MODEL, MAX_DISCOVERY_CANDIDATES, MAX_RECOVERY_CANDIDATES, MAX_TOTAL_CANDIDATES,
  MAX_REVIEW_URLS, VERIFY_BATCH_SIZE, clean, norm, parseJson, responseText, sourceUrls,
  ebayItemId, uniqItemUrls, uniqEbayUrls, marketFacts, kindOf, modelStatus, caseStatus,
  colorStatus, materialKeys, materialStatus, purityStatus, genderStatus, identityStatus,
  conditionStatus, rankCandidates, priceEvidence, assessComparable, derivePricing,
  mergeAndAssess, resultFromAssessment
};
