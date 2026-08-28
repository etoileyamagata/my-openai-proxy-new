const OPENAI_WEB_MODEL = process.env.OPENAI_WEB_MODEL || "gpt-5.4-mini";
const OPENAI_WEB_FALLBACK_MODEL = process.env.OPENAI_WEB_FALLBACK_MODEL || "gpt-4o-mini";

function clean(value) {
  return String(value || "").replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim();
}

function parseJsonObject(text) {
  const raw = String(text || "")
    .replace(/```json\s*/gi, "")
    .replace(/```[a-zA-Z]*\n?/g, "")
    .replace(/```/g, "")
    .trim();
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  try { return JSON.parse(raw.slice(start, end + 1)); } catch (_) { return null; }
}

function extractResponseText(responseJson) {
  if (typeof responseJson?.output_text === "string" && responseJson.output_text.trim()) {
    return responseJson.output_text.trim();
  }
  const parts = [];
  if (Array.isArray(responseJson?.output)) {
    responseJson.output.forEach((item) => {
      if (Array.isArray(item?.content)) {
        item.content.forEach((content) => {
          if (typeof content?.text === "string") parts.push(content.text);
        });
      }
    });
  }
  return parts.join("\n").trim();
}

function extractSources(responseJson) {
  const sources = [];
  const seen = new Set();
  const add = (item) => {
    if (!item || typeof item !== "object") return;
    const url = String(item.url || item.link || item.uri || "").trim();
    const title = String(item.title || item.name || "").trim();
    if (!url || seen.has(url)) return;
    seen.add(url);
    sources.push({ title, url });
  };
  if (Array.isArray(responseJson?.sources)) responseJson.sources.forEach(add);
  if (Array.isArray(responseJson?.output)) {
    responseJson.output.forEach((item) => {
      if (Array.isArray(item?.sources)) item.sources.forEach(add);
      if (Array.isArray(item?.action?.sources)) item.action.sources.forEach(add);
      if (Array.isArray(item?.content)) {
        item.content.forEach((content) => {
          if (Array.isArray(content?.sources)) content.sources.forEach(add);
          if (Array.isArray(content?.annotations)) {
            content.annotations.forEach((annotation) => {
              if (annotation?.type === "url_citation") add(annotation);
            });
          }
        });
      }
    });
  }
  return sources.slice(0, 15);
}

function isEbayItemUrl(value) {
  try {
    const url = new URL(String(value || ""));
    const host = url.hostname.toLowerCase();
    return url.protocol === "https:" && (host === "ebay.com" || host.endsWith(".ebay.com")) && /\/itm\//i.test(url.pathname);
  } catch (_) { return false; }
}

function isEbayUrl(value) {
  try {
    const url = new URL(String(value || ""));
    const host = url.hostname.toLowerCase();
    return url.protocol === "https:" && (host === "ebay.com" || host.endsWith(".ebay.com"));
  } catch (_) { return false; }
}

function uniqueUrls(values, itemOnly) {
  const seen = new Set();
  return (Array.isArray(values) ? values : []).map(String).map(v => v.trim()).filter((url) => {
    const ok = itemOnly ? isEbayItemUrl(url) : isEbayUrl(url);
    if (!ok || seen.has(url)) return false;
    seen.add(url);
    return true;
  }).slice(0, 5);
}

function allowedFacts(input) {
  const facts = input && typeof input === "object" ? input : {};
  if ("serialNumber" in facts || "serial" in facts || "dateCode" in facts || "manufacturingCode" in facts) {
    throw new Error("serial/date code must not be sent to market research");
  }
  const allow = [
    "schema","kind","categoryId","categoryName","brandEnglish","modelNumber","verifiedProductNameEnglish",
    "productNameJapanese","lineName","categoryValue","gender","color","dialColor","purity","material",
    "caseSize","driveType","accessories","aiDescriptionJa","aiKeywordsJa","conditionName","deterministicTitle"
  ];
  const result = {};
  allow.forEach((key) => {
    const value = facts[key];
    if (value === null || value === undefined || String(value).trim() === "") return;
    result[key] = typeof value === "string" ? value.slice(0, 1500) : value;
  });
  return result;
}

async function postResponses(payload) {
  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`
    },
    body: JSON.stringify(payload)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data?.error?.message || data?.error || `OpenAI Responses API error: ${response.status}`);
  return data;
}

async function webSearch(prompt) {
  try {
    const responseJson = await postResponses({
      model: OPENAI_WEB_MODEL,
      tools: [{
        type: "web_search",
        external_web_access: true,
        user_location: { type: "approximate", country: "JP" }
      }],
      tool_choice: "auto",
      include: ["web_search_call.action.sources"],
      input: prompt
    });
    return { text: extractResponseText(responseJson), sources: extractSources(responseJson), webModel: OPENAI_WEB_MODEL };
  } catch (firstError) {
    const responseJson = await postResponses({
      model: OPENAI_WEB_FALLBACK_MODEL,
      tools: [{
        type: "web_search_preview",
        search_context_size: "medium",
        user_location: { type: "approximate", country: "JP" }
      }],
      tool_choice: "auto",
      include: ["web_search_call.action.sources"],
      input: prompt
    });
    return {
      text: extractResponseText(responseJson),
      sources: extractSources(responseJson),
      webModel: OPENAI_WEB_FALLBACK_MODEL,
      fallbackReason: firstError.message
    };
  }
}

function validateOutput(parsed, webResult) {
  const pricing = parsed?.pricing && typeof parsed.pricing === "object" ? parsed.pricing : {};
  const quickUsd = Math.ceil(Number(pricing.quickUsd));
  const targetUsd = Math.ceil(Number(pricing.targetUsd));
  const highUsd = Math.ceil(Number(pricing.highUsd));
  const confidence = clean(parsed?.confidence).toLowerCase();
  const reasonJa = clean(parsed?.reasonJa);
  const soldUrls = uniqueUrls(parsed?.soldUrls, true).slice(0, 3);
  const evidenceUrls = uniqueUrls([
    ...(Array.isArray(parsed?.evidenceUrls) ? parsed.evidenceUrls : []),
    ...(webResult.sources || []).map(item => item.url)
  ], false);
  const comparables = (Array.isArray(parsed?.comparables) ? parsed.comparables : [])
    .map(item => ({
      title: clean(item?.title),
      url: String(item?.url || "").trim(),
      soldPriceUsd: Math.ceil(Number(item?.soldPriceUsd)),
      similarityReason: clean(item?.similarityReason)
    }))
    .filter(item => isEbayItemUrl(item.url) && Number.isFinite(item.soldPriceUsd) && item.soldPriceUsd > 0)
    .slice(0, 5);

  const priceOk = [quickUsd, targetUsd, highUsd].every(v => Number.isFinite(v) && v > 0) && quickUsd <= targetUsd && targetUsd <= highUsd;
  const evidenceOk = soldUrls.length >= 2;
  if (!priceOk || !evidenceOk || !["high", "medium"].includes(confidence) || !reasonJa) {
    return {
      ok: false,
      needsManualSoldInput: true,
      reason: !evidenceOk
        ? "実際のeBay Sold/Completed商品URLを2件以上確認できなかったため、自動価格を採用しません。"
        : "市場調査結果を安全条件で検証できなかったため、自動価格を採用しません。",
      evidenceUrls,
      comparables,
      webModel: webResult.webModel,
      researchedAt: new Date().toISOString()
    };
  }

  return {
    ok: true,
    pricing: { quickUsd, targetUsd, highUsd },
    confidence,
    reasonJa,
    soldUrls,
    evidenceUrls,
    comparables,
    webModel: webResult.webModel,
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
  if (!process.env.OPENAI_API_KEY) return res.status(500).json({ ok: false, error: "OPENAI_API_KEY is not configured" });

  try {
    const facts = allowedFacts(req.body?.facts || {});
    if (!facts.categoryId || !facts.brandEnglish) {
      return res.status(400).json({ ok: false, error: "categoryId and brandEnglish are required" });
    }

    const prompt = `
[ROLE]
あなたは日本の中古ブランド品販売会社向けのeBay.com市場価格調査担当です。

[GOAL]
下記の確定済み商品情報を使い、eBay.comのSold/Completed実績をWEB検索して、現実的な3価格をUSDで作成してください。
QUICK = 比較的早く売る価格
TARGET = しばらく待って現実的に売る中心価格
HIGH = 時間をかけて狙う上限寄り価格

[絶対条件]
- 出力はJSONのみ。
- serial number / date code / manufacturing codeは入力にも出力にも使わない。
- PROVIDED_FACTSの既存ChatGPT説明・キーワードは検索語補助にのみ使い、事実の根拠にはしない。
- カテゴリ、製造国、Condition、Item Specificsを推測しない。
- eBay Sold/Completedと確認できる実商品を最低2件必要とする。
- soldUrlsには実際のeBay商品URL（https://www.ebay.com/itm/... 等）だけを入れる。
- 検索結果一覧URL、Google/Bing URL、Terapeak以外の価格サイトURLをsoldUrlsに入れない。
- 出品中価格だけしか確認できない場合は ok=false にする。
- 同型番を最優先し、なければ同モデル・近い仕様へ広げるが、違いをsimilarityReasonに明記する。
- QUICK <= TARGET <= HIGH を必ず守る。
- 異常値、部品取り、ジャンク、箱のみ、付属品のみ、明らかな別型番は除外する。
- 情報が足りない場合は無理に価格を作らず ok=false にする。

[OUTPUT JSON]
{
  "ok": true,
  "pricing": {"quickUsd": 0, "targetUsd": 0, "highUsd": 0},
  "confidence": "high|medium",
  "reasonJa": "短い日本語理由",
  "soldUrls": ["https://www.ebay.com/itm/...", "https://www.ebay.com/itm/..."],
  "evidenceUrls": [],
  "comparables": [
    {"title":"", "url":"https://www.ebay.com/itm/...", "soldPriceUsd":0, "similarityReason":""}
  ]
}

失敗時:
{
  "ok": false,
  "reasonJa": "Sold/Completed実績を2件以上確認できない等の理由",
  "soldUrls": [],
  "evidenceUrls": []
}

[PROVIDED_FACTS]
${JSON.stringify(facts, null, 2)}
`.trim();

    const webResult = await webSearch(prompt);
    const parsed = parseJsonObject(webResult.text);
    if (!parsed) {
      return res.status(200).json({
        ok: false,
        needsManualSoldInput: true,
        reason: "OpenAI市場調査レスポンスをJSONとして検証できませんでした。",
        evidenceUrls: uniqueUrls((webResult.sources || []).map(item => item.url), false),
        webModel: webResult.webModel,
        researchedAt: new Date().toISOString()
      });
    }

    return res.status(200).json(validateOutput(parsed, webResult));
  } catch (error) {
    return res.status(500).json({
      ok: false,
      needsManualSoldInput: true,
      error: error instanceof Error ? error.message : String(error)
    });
  }
};
