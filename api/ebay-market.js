const MODEL = process.env.OPENAI_WEB_MODEL || "gpt-5.6";

function clean(v) { return String(v || "").replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim(); }
function parseJson(text) {
  const raw = String(text || "").replace(/```json\s*/gi, "").replace(/```[a-zA-Z]*\n?/g, "").replace(/```/g, "").trim();
  const a = raw.indexOf("{"), b = raw.lastIndexOf("}");
  if (a < 0 || b <= a) return null;
  try { return JSON.parse(raw.slice(a, b + 1)); } catch (_) { return null; }
}
function responseText(data) {
  if (typeof data?.output_text === "string") return data.output_text.trim();
  const parts = [];
  for (const item of data?.output || []) for (const c of item?.content || []) if (typeof c?.text === "string") parts.push(c.text);
  return parts.join("\n").trim();
}
function sources(data) {
  const out = [], seen = new Set();
  const add = x => { const url = String(x?.url || x?.link || x?.uri || "").trim(); if (url && !seen.has(url)) { seen.add(url); out.push(url); } };
  for (const item of data?.output || []) {
    for (const x of item?.sources || []) add(x);
    for (const x of item?.action?.sources || []) add(x);
    for (const c of item?.content || []) {
      for (const x of c?.sources || []) add(x);
      for (const x of c?.annotations || []) if (x?.type === "url_citation") add(x);
    }
  }
  return out.slice(0, 20);
}
function ebayUrl(value, itemOnly = false) {
  try {
    const u = new URL(String(value || "")), host = u.hostname.toLowerCase();
    const ebay = host === "ebay.com" || host.endsWith(".ebay.com");
    return u.protocol === "https:" && ebay && (!itemOnly || /\/itm\//i.test(u.pathname));
  } catch (_) { return false; }
}
function uniqueUrls(values, itemOnly = false) {
  const seen = new Set();
  return (Array.isArray(values) ? values : []).map(String).map(x => x.trim()).filter(x => {
    if (!ebayUrl(x, itemOnly) || seen.has(x)) return false;
    seen.add(x); return true;
  }).slice(0, 8);
}
function factsOnly(input) {
  const src = input && typeof input === "object" ? input : {};
  for (const forbidden of ["serialNumber", "serial", "dateCode", "manufacturingCode"]) {
    if (Object.prototype.hasOwnProperty.call(src, forbidden)) throw new Error("serial/date code is forbidden");
  }
  const allow = ["schema","kind","categoryId","categoryName","brandEnglish","modelNumber","verifiedProductNameEnglish","productNameJapanese","lineName","categoryValue","gender","color","dialColor","purity","material","caseSize","driveType","accessories","aiDescriptionJa","aiKeywordsJa","conditionName","deterministicTitle"];
  const out = {};
  for (const key of allow) {
    const value = src[key];
    if (value === null || value === undefined || String(value).trim() === "") continue;
    out[key] = typeof value === "string" ? value.slice(0, 1500) : value;
  }
  return out;
}
async function searchWeb(prompt) {
  const response = await fetch("https://api.openai.com/v1/responses", {
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
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data?.error?.message || data?.error || `OpenAI Responses API error: ${response.status}`);
  return { text: responseText(data), sources: sources(data) };
}
function validate(parsed, webSources) {
  const pricing = parsed?.pricing || {};
  const quickUsd = Math.ceil(Number(pricing.quickUsd)), targetUsd = Math.ceil(Number(pricing.targetUsd)), highUsd = Math.ceil(Number(pricing.highUsd));
  const confidence = clean(parsed?.confidence).toLowerCase(), reasonJa = clean(parsed?.reasonJa || parsed?.reason);
  const soldUrls = uniqueUrls(parsed?.soldUrls, true).slice(0, 3);
  const evidenceUrls = uniqueUrls([...(parsed?.evidenceUrls || []), ...(webSources || [])], false);
  const comparables = (Array.isArray(parsed?.comparables) ? parsed.comparables : []).map(x => ({
    title: clean(x?.title), url: String(x?.url || "").trim(), soldPriceUsd: Math.ceil(Number(x?.soldPriceUsd)), similarityReason: clean(x?.similarityReason)
  })).filter(x => ebayUrl(x.url, true) && Number.isFinite(x.soldPriceUsd) && x.soldPriceUsd > 0).slice(0, 5);
  const priceOk = [quickUsd,targetUsd,highUsd].every(x => Number.isFinite(x) && x > 0) && quickUsd <= targetUsd && targetUsd <= highUsd;
  if (!priceOk || soldUrls.length < 2 || !["high","medium"].includes(confidence) || !reasonJa) {
    return { ok:false, needsManualSoldInput:true, reason:"実際のeBay Sold/Completed商品URLを2件以上含む安全な相場結果を確認できませんでした。", evidenceUrls, comparables, webModel:MODEL, researchedAt:new Date().toISOString() };
  }
  return { ok:true, pricing:{quickUsd,targetUsd,highUsd}, confidence, reasonJa, soldUrls, evidenceUrls, comparables, webModel:MODEL, researchedAt:new Date().toISOString() };
}

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Cache-Control", "no-store");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ ok:false, error:"POST required" });
  if (!process.env.OPENAI_API_KEY) return res.status(500).json({ ok:false, error:"OPENAI_API_KEY is not configured" });
  try {
    const facts = factsOnly(req.body?.facts || {});
    if (!facts.categoryId || !facts.brandEnglish) return res.status(400).json({ ok:false, error:"categoryId and brandEnglish are required" });
    const prompt = `あなたは日本の中古ブランド品販売会社向けeBay.com市場価格調査担当です。\n\n確定済み情報:\n${JSON.stringify(facts, null, 2)}\n\nWEB検索でeBay.comのSold/Completed実績を調査してください。serial/date codeは使わず、既存ChatGPT説明・キーワードは検索補助にのみ使用してください。カテゴリ、製造国、Condition、Item Specificsは推測しません。同型番を最優先し、なければ同モデル・近い仕様へ広げます。部品取り、ジャンク、箱のみ、別型番などの異常比較対象は除外してください。\n\n実際のeBay Sold/Completed商品URLを最低2件確認できる場合だけok=true。出品中価格しか確認できない場合や根拠不足ならok=false。\n\n価格はUSD整数で QUICK=比較的早く売る価格、TARGET=しばらく待って現実的に売る中心価格、HIGH=時間をかけて狙う上限寄り価格。QUICK <= TARGET <= HIGH。\n\nJSONのみ返してください:\n{"ok":true,"pricing":{"quickUsd":0,"targetUsd":0,"highUsd":0},"confidence":"high|medium","reasonJa":"短い日本語理由","soldUrls":["https://www.ebay.com/itm/...","https://www.ebay.com/itm/..."],"evidenceUrls":[],"comparables":[{"title":"","url":"https://www.ebay.com/itm/...","soldPriceUsd":0,"similarityReason":""}]}\n失敗時:{"ok":false,"reasonJa":"理由","soldUrls":[],"evidenceUrls":[]}`;
    const web = await searchWeb(prompt);
    const parsed = parseJson(web.text);
    if (!parsed || parsed.ok === false) return res.status(200).json({ ok:false, needsManualSoldInput:true, reason:clean(parsed?.reasonJa || "市場調査結果を安全に確定できませんでした。"), evidenceUrls:uniqueUrls(web.sources), webModel:MODEL, researchedAt:new Date().toISOString() });
    return res.status(200).json(validate(parsed, web.sources));
  } catch (error) {
    return res.status(500).json({ ok:false, needsManualSoldInput:true, error:error instanceof Error ? error.message : String(error) });
  }
};
