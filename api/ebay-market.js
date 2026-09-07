const MODEL = "gpt-5.6-luna";

const ALLOWED_FACTS = [
  "schema", "kind", "categoryId", "categoryName", "brandEnglish", "modelNumber",
  "verifiedProductNameEnglish", "productNameJapanese", "lineName", "categoryValue",
  "gender", "color", "dialColor", "purity", "material", "caseSize", "driveType",
  "accessories", "aiDescriptionJa", "aiKeywordsJa", "conditionName", "deterministicTitle"
];

const DIAL_GROUPS = [
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
  [/(ブラウン|茶|brown)/i, /(ブラウン|茶|brown)/i]
];

const SPECIAL_DIALS = [
  /(ダイヤ|diamond|10p|8p)/i,
  /(ピラミッド|pyramid)/i,
  /(タペストリー|tapestry)/i,
  /(シェル|マザーオブパール|mother of pearl|\bmop\b)/i,
  /(コンピューター|computer|jubilee dial|jubilee-pattern)/i,
  /(リネン|linen)/i,
  /(ハウンドトゥース|houndstooth)/i,
  /(カスタム|custom|社外|aftermarket)/i
];

function clean(v) {
  return String(v || "").replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim();
}

function norm(v) {
  return clean(v).normalize("NFKC").toLowerCase().replace(/[‐‑‒–—―]/g, "-");
}

function parseJson(text) {
  const raw = String(text || "").replace(/```json\s*/gi, "").replace(/```[a-zA-Z]*\n?/g, "").replace(/```/g, "").trim();
  const a = raw.indexOf("{");
  const b = raw.lastIndexOf("}");
  if (a < 0 || b <= a) return null;
  try { return JSON.parse(raw.slice(a, b + 1)); } catch (_) { return null; }
}

function responseText(data) {
  if (typeof data?.output_text === "string") return data.output_text.trim();
  const out = [];
  for (const item of data?.output || []) for (const c of item?.content || []) if (typeof c?.text === "string") out.push(c.text);
  return out.join("\n").trim();
}

function sourceUrls(data) {
  const out = [];
  const seen = new Set();
  const add = s => {
    const u = String(s?.url || s?.link || s?.uri || "").trim();
    if (u && !seen.has(u)) { seen.add(u); out.push(u); }
  };
  for (const item of data?.output || []) {
    for (const s of item?.sources || []) add(s);
    for (const s of item?.action?.sources || []) add(s);
    for (const c of item?.content || []) {
      for (const s of c?.sources || []) add(s);
      for (const a of c?.annotations || []) if (a?.type === "url_citation") add(a);
    }
  }
  return out.slice(0, 50);
}

function ebayItemId(value) {
  try {
    const u = new URL(String(value || ""));
    if (u.protocol !== "https:" || !(u.hostname === "ebay.com" || u.hostname.endsWith(".ebay.com")) || !/\/itm\//i.test(u.pathname)) return "";
    const parts = u.pathname.split("/").filter(Boolean);
    const i = parts.findIndex(x => x.toLowerCase() === "itm");
    for (let p = parts.length - 1; p > i; p--) {
      const m = parts[p].match(/(\d{8,})/);
      if (m) return m[1];
    }
  } catch (_) {}
  return "";
}

function uniqUrls(values, itemOnly = false) {
  const out = [];
  const seen = new Set();
  for (const raw of Array.isArray(values) ? values : []) {
    const u = String(raw || "").trim();
    let key = u;
    if (itemOnly) key = ebayItemId(u);
    else {
      try {
        const x = new URL(u);
        if (x.protocol !== "https:" || !(x.hostname === "ebay.com" || x.hostname.endsWith(".ebay.com"))) continue;
      } catch (_) { continue; }
    }
    if (!key || seen.has(key)) continue;
    seen.add(key); out.push(u);
  }
  return out.slice(0, 20);
}

function factsOnly(input) {
  const src = input && typeof input === "object" ? input : {};
  for (const k of ["serialNumber", "serial", "dateCode", "manufacturingCode"]) {
    if (Object.prototype.hasOwnProperty.call(src, k)) throw new Error("serial/date code is forbidden");
  }
  const out = {};
  for (const k of ALLOWED_FACTS) {
    const v = src[k];
    if (v === null || v === undefined || String(v).trim() === "") continue;
    out[k] = typeof v === "string" ? v.slice(0, 1500) : v;
  }
  return out;
}

function modelMatches(actual, expected) {
  const a = norm(actual).replace(/[^a-z0-9]/g, "");
  const e = norm(expected).replace(/[^a-z0-9]/g, "");
  return !e || a === e;
}

function caseStatus(actual, expected) {
  const e = Number(String(expected ?? "").match(/(\d+(?:\.\d+)?)/)?.[1]);
  if (!Number.isFinite(e)) return "confirmed";
  const a = Number(String(actual ?? "").match(/(\d+(?:\.\d+)?)/)?.[1]);
  if (!Number.isFinite(a) || a <= 0) return "unconfirmed";
  return Math.abs(a - e) <= 0.2 ? "confirmed" : "mismatch";
}

function dialStatus(actualDial, specialDial, facts) {
  const target = norm(`${facts?.dialColor || ""} ${facts?.color || ""}`);
  if (!target) return "confirmed";
  const special = norm(specialDial);
  if (special && special !== "none" && special !== "なし" && SPECIAL_DIALS.some(rx => rx.test(special) && !rx.test(target))) return "mismatch";
  const actual = norm(actualDial);
  if (!actual || /^(unknown|unspecified|not specified|not stated|n\/a|none|-|不明|記載なし|未記載)$/.test(actual)) return "unconfirmed";
  const groups = DIAL_GROUPS.filter(([t]) => t.test(target));
  if (groups.length) return groups.some(([, a]) => a.test(actual)) ? "confirmed" : "mismatch";
  return actual.includes(target) || target.includes(actual) ? "confirmed" : "mismatch";
}

function conditionGroup(v) {
  const s = norm(v);
  if (!s) return "";
  if (/(parts|部品|ジャンク|repair)/i.test(s)) return "parts";
  if (/(new|新品|未使用)/i.test(s)) return "new";
  if (/(pre-owned|used|中古|excellent|good|very good)/i.test(s)) return "used";
  return "other";
}

function isBodyOnly(v) { return /(本体のみ|時計のみ|watch only|head only)/i.test(String(v || "")); }

async function searchWeb(prompt) {
  const r = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${process.env.OPENAI_API_KEY}` },
    body: JSON.stringify({
      model: MODEL,
      tools: [{ type: "web_search", search_context_size: "high", user_location: { type: "approximate", country: "JP" } }],
      tool_choice: "auto",
      include: ["web_search_call.action.sources"],
      input: prompt
    })
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data?.error?.message || data?.error || `OpenAI Responses API error: ${r.status}`);
  return { text: responseText(data), sources: sourceUrls(data) };
}

function discoveryPrompt(facts) {
  return `あなたはeBay.comの中古ブランド品Sold/Completed事例の探索担当です。\n確定情報:\n${JSON.stringify(facts, null, 2)}\n\n実際にWEB検索で確認したeBay item URLだけを最大12件返してください。価格算定はまだしません。serial/date code、部品取り、ジャンク、箱のみ、別型番は除外。\n時計は同一modelNumberを必須とし、caseSizeは一致を優先しますが同一型番で未記載なら候補に残し、明示的な別サイズだけ除外してください。文字盤はタイトルだけでなくItem specificsも考慮し、明示的な別色は除外、未記載は候補に残してください。\nシャンパン文字盤はChampagneだけでなく、Dial Color欄のGold / Gold Tone / Yellow Goldも同系統候補として探索してください。ケース・ベゼル・ブレスがGoldというだけで文字盤色を推測してはいけません。\nDiamond/Pyramid/Tapestry/MOP/Computer/Jubilee-pattern/Linen/Houndstooth/Custom/Aftermarket等、対象にない特殊文字盤は除外。Box/Papers付きとBest Offer acceptedは候補に残してよい。\n1種類の検索語で終わらず、modelNumber中心、文字盤名あり/なし、シャンパンならChampagne/Gold系など複数検索を試してください。\nJSONのみ:{"candidateUrls":["https://www.ebay.com/itm/..."],"reasonJa":"短い理由"}`;
}

function verifyPrompt(facts, urls) {
  return `あなたはeBay.com中古ブランド品のSold/Completed根拠検証担当です。\n対象:\n${JSON.stringify(facts, null, 2)}\n候補URL:\n${JSON.stringify(urls, null, 2)}\n\n各URLを実際に確認してください。Sold/Completed未確認、別型番、明示的な別サイズ、部品/ジャンクは除外。時計はmodelNumber一致必須。caseSize未記載はcaseSizeMm=0で残してよい。\n文字盤はタイトルだけでなくItem specificsのDial Colorと説明も確認。対象がシャンパンなら、Dial Colorとして明示されたChampagne / Gold / Gold Tone / Yellow Goldは同系統として扱ってよい。ただしケース・ベゼル・ブレスのGoldから推測しない。文字盤色が未記載で、別色や特殊文字盤とも明示されない場合はdialColor=""、dialEvidenceSource="not_stated"として残し、シャンパンと断定しない。Black/Silver/Blue等の明示的別色は除外。対象にないDiamond/Pyramid/Tapestry/MOP/Computer/Jubilee-pattern/Linen/Houndstooth/Custom/Aftermarketは除外。\nBox/Papers付きは対象が本体のみならaccessoryUpperBound=true。Best Offerで受諾価格非公開ならexactSoldPriceUsd=0、表示価格が確認できる場合だけdisplayedUpperBoundUsdへ。US $0.00、取消線、現在の再出品価格、類似商品価格は実売価格にしない。\n文字盤未記載の事例は調査結果として返すが自動価格算定には使わない。文字盤確認済みSoldが2件未満ならok=false。ok=falseでも確認できた事例をverifiedComparablesから捨てない。2件以上の文字盤確認済みSold、少なくとも1件の比較可能価格、少なくとも1件のexactSoldPriceUsdがある場合だけpricingを作成。QUICK/TARGET/HIGHは保守的に。\n各事例: url,title,soldStatusConfirmed,exactSoldPriceUsd,displayedUpperBoundUsd,bestOfferAccepted,currentOrRelistedPrice,modelNumber,caseSizeMm,dialColor,dialEvidenceSource,specialDial,hasBox,hasPapers,accessoryUpperBound,condition,verificationReasonJa\nJSONのみ:{"ok":true,"pricing":{"quickUsd":0,"targetUsd":0,"highUsd":0},"confidence":"high|medium","reasonJa":"短い理由","verifiedComparables":[...]}。失敗時もverifiedComparablesは残す。`;
}

function priceEvidence(item, facts) {
  const exact = Number(item.exactSoldPriceUsd);
  const upper = Number(item.displayedUpperBoundUsd);
  const accessoryUpper = isBodyOnly(facts?.accessories) && (item.hasBox || item.hasPapers || item.accessoryUpperBound);
  let exactPrice = 0, upperBound = 0;
  if (Number.isFinite(exact) && exact > 0) {
    if (accessoryUpper) upperBound = exact;
    else if (!item.bestOfferAccepted) exactPrice = exact;
  }
  if (Number.isFinite(upper) && upper > 0) upperBound = upperBound > 0 ? Math.min(upperBound, upper) : upper;
  return { exactPrice, upperBound };
}

function validate(parsed, verificationSources, candidates, facts) {
  const candidateIds = new Set(candidates.map(ebayItemId));
  const sourceIds = new Set(uniqUrls(verificationSources, true).map(ebayItemId));
  const seen = new Set();
  const targetCondition = conditionGroup(facts?.conditionName);

  const comparables = (Array.isArray(parsed?.verifiedComparables) ? parsed.verifiedComparables : []).map(raw => {
    const item = {
      url: String(raw?.url || "").trim(), title: clean(raw?.title), soldStatusConfirmed: raw?.soldStatusConfirmed === true,
      exactSoldPriceUsd: Math.ceil(Number(raw?.exactSoldPriceUsd) || 0), displayedUpperBoundUsd: Math.ceil(Number(raw?.displayedUpperBoundUsd) || 0),
      bestOfferAccepted: raw?.bestOfferAccepted === true, currentOrRelistedPrice: raw?.currentOrRelistedPrice === true,
      modelNumber: clean(raw?.modelNumber), caseSizeMm: raw?.caseSizeMm, dialColor: clean(raw?.dialColor), dialEvidenceSource: clean(raw?.dialEvidenceSource),
      specialDial: clean(raw?.specialDial), hasBox: raw?.hasBox === true, hasPapers: raw?.hasPapers === true, accessoryUpperBound: raw?.accessoryUpperBound === true,
      condition: clean(raw?.condition), verificationReasonJa: clean(raw?.verificationReasonJa)
    };
    item.id = ebayItemId(item.url);
    item.caseMatchStatus = String(facts?.kind || "").toLowerCase() === "watch" ? caseStatus(item.caseSizeMm, facts?.caseSize) : "confirmed";
    item.dialMatchStatus = String(facts?.kind || "").toLowerCase() === "watch" ? dialStatus(item.dialColor, item.specialDial, facts) : "confirmed";
    Object.assign(item, priceEvidence(item, facts));
    item.soldPriceUsd = item.exactPrice > 0 ? item.exactPrice : 0;
    item.similarityReason = item.verificationReasonJa;
    return item;
  }).filter(item => {
    if (!item.id || seen.has(item.id) || !candidateIds.has(item.id) || !sourceIds.has(item.id)) return false;
    if (!item.title || item.soldStatusConfirmed !== true || item.currentOrRelistedPrice || /(for\s+parts|parts\s+only|junk|repair|project\s+watch|empty\s+box|box\s+only)/i.test(item.title)) return false;
    if (facts?.modelNumber && !modelMatches(item.modelNumber, facts.modelNumber)) return false;
    if (item.caseMatchStatus === "mismatch" || item.dialMatchStatus === "mismatch") return false;
    const actualCondition = conditionGroup(item.condition);
    if (actualCondition === "parts" || (targetCondition && actualCondition && actualCondition !== "other" && targetCondition !== actualCondition)) return false;
    seen.add(item.id); return true;
  }).slice(0, 10);

  const confirmed = comparables.filter(x => x.dialMatchStatus === "confirmed");
  const unconfirmed = comparables.filter(x => x.dialMatchStatus === "unconfirmed");
  const exactPrices = confirmed.map(x => x.exactPrice).filter(x => x > 0);
  const upperBounds = confirmed.map(x => x.upperBound).filter(x => x > 0);
  const priced = confirmed.filter(x => x.exactPrice > 0 || x.upperBound > 0);
  const p = parsed?.pricing || {};
  const quickUsd = Math.ceil(Number(p.quickUsd)), targetUsd = Math.ceil(Number(p.targetUsd)), highUsd = Math.ceil(Number(p.highUsd));
  const priceOrder = [quickUsd, targetUsd, highUsd].every(x => Number.isFinite(x) && x > 0) && quickUsd <= targetUsd && targetUsd <= highUsd;
  const maxEvidence = Math.max(0, ...exactPrices, ...upperBounds);
  const minExact = exactPrices.length ? Math.min(...exactPrices) : 0;
  const withinEvidence = priceOrder && maxEvidence > 0 && highUsd <= Math.ceil(maxEvidence * 1.02) && (!minExact || quickUsd >= Math.floor(minExact * 0.70));
  const confidence = clean(parsed?.confidence).toLowerCase();
  const reasonJa = clean(parsed?.reasonJa || parsed?.reason);
  const confirmedUrls = confirmed.map(x => x.url);
  const evidenceUrls = uniqUrls([...confirmedUrls, ...unconfirmed.map(x => x.url), ...verificationSources]);
  const ok = parsed?.ok === true && confirmed.length >= 2 && priced.length >= 1 && exactPrices.length >= 1 && withinEvidence && ["high", "medium"].includes(confidence) && !!reasonJa;

  if (!ok) {
    let reason = reasonJa;
    if (!reason) reason = confirmed.length < 2
      ? `文字盤まで確認できたSold事例は${confirmed.length}件です。${unconfirmed.length ? `文字盤表記未確認の候補${unconfirmed.length}件も参考情報として保持しています。` : ""}`
      : "条件一致のSold実績は確認できましたが、自動価格に使える実売価格根拠が不足したためAI価格は採用しません。";
    return { ok: false, needsManualSoldInput: true, reason, reasonJa: reason, soldUrls: confirmedUrls.slice(0, 10), evidenceUrls, comparables, confirmedComparableCount: confirmed.length, unconfirmedComparableCount: unconfirmed.length, webModel: MODEL, researchedAt: new Date().toISOString() };
  }
  return { ok: true, pricing: { quickUsd, targetUsd, highUsd }, confidence, reasonJa, soldUrls: confirmedUrls.slice(0, 10), evidenceUrls, comparables, confirmedComparableCount: confirmed.length, unconfirmedComparableCount: unconfirmed.length, webModel: MODEL, researchedAt: new Date().toISOString() };
}

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Cache-Control", "no-store");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ ok: false, error: "POST required" });
  if (!process.env.OPENAI_API_KEY) return res.status(500).json({ ok: false, error: "OPENAI_API_KEY is not configured" });

  try {
    const facts = factsOnly(req.body?.facts || {});
    if (!facts.categoryId || !facts.brandEnglish) return res.status(400).json({ ok: false, error: "categoryId and brandEnglish are required" });

    const d = await searchWeb(discoveryPrompt(facts));
    const dp = parseJson(d.text);
    const sourceIds = new Set(uniqUrls(d.sources, true).map(ebayItemId));
    const candidates = uniqUrls(dp?.candidateUrls, true).filter(u => sourceIds.has(ebayItemId(u))).slice(0, 12);
    if (candidates.length < 2) return res.status(200).json({ ok: false, needsManualSoldInput: true, reason: clean(dp?.reasonJa || "条件に合うeBay Sold/Completed候補を2件以上確認できませんでした。"), evidenceUrls: uniqUrls(d.sources), comparables: [], webModel: MODEL, researchedAt: new Date().toISOString() });

    const v = await searchWeb(verifyPrompt(facts, candidates));
    const vp = parseJson(v.text);
    if (!vp) return res.status(200).json({ ok: false, needsManualSoldInput: true, reason: "eBay成約根拠の再検証結果を安全に解析できなかったため、AI価格は採用しません。", evidenceUrls: uniqUrls(v.sources), comparables: [], webModel: MODEL, researchedAt: new Date().toISOString() });
    return res.status(200).json(validate(vp, v.sources, candidates, facts));
  } catch (error) {
    return res.status(500).json({ ok: false, needsManualSoldInput: true, error: error instanceof Error ? error.message : String(error), webModel: MODEL, researchedAt: new Date().toISOString() });
  }
};