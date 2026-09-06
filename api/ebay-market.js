const MODEL = "gpt-5.6-luna";

function clean(v) {
  return String(v || "").replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim();
}

function parseJson(text) {
  const raw = String(text || "")
    .replace(/```json\s*/gi, "")
    .replace(/```[a-zA-Z]*\n?/g, "")
    .replace(/```/g, "")
    .trim();
  const a = raw.indexOf("{");
  const b = raw.lastIndexOf("}");
  if (a < 0 || b <= a) return null;
  try {
    return JSON.parse(raw.slice(a, b + 1));
  } catch (_) {
    return null;
  }
}

function responseText(data) {
  if (typeof data?.output_text === "string") return data.output_text.trim();
  const parts = [];
  for (const item of data?.output || []) {
    for (const c of item?.content || []) {
      if (typeof c?.text === "string") parts.push(c.text);
    }
  }
  return parts.join("\n").trim();
}

function sources(data) {
  const out = [];
  const seen = new Set();
  const add = x => {
    const url = String(x?.url || x?.link || x?.uri || "").trim();
    if (url && !seen.has(url)) {
      seen.add(url);
      out.push(url);
    }
  };
  for (const item of data?.output || []) {
    for (const x of item?.sources || []) add(x);
    for (const x of item?.action?.sources || []) add(x);
    for (const c of item?.content || []) {
      for (const x of c?.sources || []) add(x);
      for (const x of c?.annotations || []) {
        if (x?.type === "url_citation") add(x);
      }
    }
  }
  return out.slice(0, 30);
}

function ebayUrl(value, itemOnly = false) {
  try {
    const u = new URL(String(value || ""));
    const host = u.hostname.toLowerCase();
    const ebay = host === "ebay.com" || host.endsWith(".ebay.com");
    return u.protocol === "https:" && ebay && (!itemOnly || /\/itm\//i.test(u.pathname));
  } catch (_) {
    return false;
  }
}

function ebayItemId(value) {
  if (!ebayUrl(value, true)) return "";
  try {
    const u = new URL(String(value));
    const parts = u.pathname.split("/").filter(Boolean);
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
    .map(x => x.trim())
    .filter(x => {
      if (!ebayUrl(x, itemOnly) || seen.has(x)) return false;
      seen.add(x);
      return true;
    })
    .slice(0, 12);
}

function verifiedItemUrls(values, webSources) {
  const sourceIds = new Set(
    uniqueUrls(webSources, true)
      .map(ebayItemId)
      .filter(Boolean)
  );
  const seenIds = new Set();
  return uniqueUrls(values, true).filter(url => {
    const id = ebayItemId(url);
    if (!id || !sourceIds.has(id) || seenIds.has(id)) return false;
    seenIds.add(id);
    return true;
  });
}

function normalizeText(value) {
  return String(value || "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[‐‑‒–—―]/g, "-")
    .replace(/\s+/g, " ")
    .trim();
}

function modelNumberMatches(title, modelNumber) {
  const model = normalizeText(modelNumber);
  if (!model) return true;
  return normalizeText(title).includes(model);
}

function caseSizeMatches(title, caseSize) {
  const match = String(caseSize || "").match(/(\d+(?:\.\d+)?)/);
  if (!match) return true;
  const size = match[1].replace(".", "\\.");
  return new RegExp(`(^|[^0-9])${size}\\s*mm([^0-9]|$)`, "i").test(String(title || ""));
}

const DIAL_GROUPS = [
  { key: "champagne", target: /(シャンパン|しゃんぱん|champagne)/i, listing: /\bchampagne\b/i },
  { key: "black", target: /(ブラック|黒|black)/i, listing: /\bblack\b/i },
  { key: "blue", target: /(ブルー|青|blue)/i, listing: /\bblue\b/i },
  { key: "silver", target: /(シルバー|銀|silver)/i, listing: /\bsilver\b/i },
  { key: "white", target: /(ホワイト|白|white)/i, listing: /\bwhite\b/i },
  { key: "gray", target: /(グレー|灰|gray|grey)/i, listing: /\b(?:gray|grey)\b/i },
  { key: "green", target: /(グリーン|緑|green)/i, listing: /\bgreen\b/i },
  { key: "gold", target: /(ゴールド|金色|gold)/i, listing: /\bgold\b/i },
  { key: "pink", target: /(ピンク|pink)/i, listing: /\bpink\b/i },
  { key: "red", target: /(レッド|赤|red)/i, listing: /\bred\b/i },
  { key: "brown", target: /(ブラウン|茶|brown)/i, listing: /\bbrown\b/i }
];

const SPECIAL_DIALS = [
  { key: "diamond", target: /(ダイヤ|diamond|10p|8p)/i, listing: /\bdiamond\b/i },
  { key: "pyramid", target: /(ピラミッド|pyramid)/i, listing: /\bpyramid\b/i },
  { key: "tapestry", target: /(タペストリー|tapestry)/i, listing: /\btapestry\b/i },
  { key: "mop", target: /(シェル|マザーオブパール|mother of pearl|\bmop\b)/i, listing: /(mother of pearl|\bmop\b)/i },
  { key: "custom", target: /(カスタム|custom|社外|aftermarket)/i, listing: /\b(?:custom|aftermarket)\b/i }
];

function dialMatches(title, facts) {
  const target = normalizeText(`${facts?.dialColor || ""} ${facts?.color || ""}`);
  if (!target) return true;

  const targetGroups = DIAL_GROUPS.filter(group => group.target.test(target));
  if (targetGroups.length > 0) {
    const listingMatchesTarget = targetGroups.some(group => group.listing.test(String(title || "")));
    if (!listingMatchesTarget) return false;
  }

  for (const special of SPECIAL_DIALS) {
    const targetHasSpecial = special.target.test(target);
    const listingHasSpecial = special.listing.test(String(title || ""));
    if (listingHasSpecial && !targetHasSpecial) return false;
  }

  return true;
}

function targetIsBodyOnly(accessories) {
  return /(本体のみ|時計のみ|watch only|head only)/i.test(String(accessories || ""));
}

function listingHasIncludedAccessories(title) {
  const text = normalizeText(title);
  const explicitlyNoAccessories = /(no\s+box\s*\/\s*papers?|no\s+box\s+(?:and|&)\s+papers?|without\s+box|without\s+papers?|watch only|head only)/i.test(text);
  if (explicitlyNoAccessories) return false;
  return /(full\s+set|box\s*(?:&|and|\/)\s*papers?|with\s+box|with\s+papers?|box\s+paper|box\s+papers|\bcertificate\b|\bwarranty\s+card\b)/i.test(text);
}

function obviousBadComparable(title) {
  return /(for\s+parts|parts\s+only|junk|repair|project\s+watch|empty\s+box|box\s+only)/i.test(String(title || ""));
}

function comparableMatchesFacts(comparable, facts) {
  const title = clean(comparable?.title);
  if (!title || obviousBadComparable(title)) return false;

  if (String(facts?.kind || "").toLowerCase() === "watch") {
    if (facts?.modelNumber && !modelNumberMatches(title, facts.modelNumber)) return false;
    if (facts?.caseSize && !caseSizeMatches(title, facts.caseSize)) return false;
    if ((facts?.dialColor || facts?.color) && !dialMatches(title, facts)) return false;
    if (targetIsBodyOnly(facts?.accessories) && listingHasIncludedAccessories(title)) return false;
  }

  return true;
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

async function searchWeb(prompt) {
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
          search_context_size: "high",
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
  return { text: responseText(data), sources: sources(data) };
}

function validate(parsed, webSources, facts) {
  const pricing = parsed?.pricing || {};
  const quickUsd = Math.ceil(Number(pricing.quickUsd));
  const targetUsd = Math.ceil(Number(pricing.targetUsd));
  const highUsd = Math.ceil(Number(pricing.highUsd));
  const confidence = clean(parsed?.confidence).toLowerCase();
  const reasonJa = clean(parsed?.reasonJa || parsed?.reason);
  const evidenceUrls = uniqueUrls(webSources, false);
  const verifiedSourceUrls = verifiedItemUrls(parsed?.soldUrls, webSources);
  const verifiedIds = new Set(verifiedSourceUrls.map(ebayItemId).filter(Boolean));
  const comparables = (Array.isArray(parsed?.comparables) ? parsed.comparables : [])
    .map(x => ({
      title: clean(x?.title),
      url: String(x?.url || "").trim(),
      soldPriceUsd: Math.ceil(Number(x?.soldPriceUsd)),
      similarityReason: clean(x?.similarityReason)
    }))
    .filter(x => {
      const id = ebayItemId(x.url);
      return id
        && verifiedIds.has(id)
        && Number.isFinite(x.soldPriceUsd)
        && x.soldPriceUsd > 0
        && comparableMatchesFacts(x, facts);
    })
    .slice(0, 5);
  const soldUrls = comparables.map(x => x.url).slice(0, 3);
  const priceOk = [quickUsd, targetUsd, highUsd].every(x => Number.isFinite(x) && x > 0)
    && quickUsd <= targetUsd
    && targetUsd <= highUsd;

  if (!priceOk || soldUrls.length < 2 || !["high", "medium"].includes(confidence) || !reasonJa) {
    return {
      ok: false,
      needsManualSoldInput: true,
      reason: "型番・ケースサイズ・文字盤・付属品条件まで照合できるeBay Sold/Completed実績を2件以上確認できなかったため、AI価格は採用しません。",
      evidenceUrls,
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
    soldUrls,
    evidenceUrls,
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

    const prompt = `あなたは日本の中古ブランド品販売会社向けeBay.com市場価格調査担当です。\n\n確定済み情報:\n${JSON.stringify(facts, null, 2)}\n\nWEB検索でeBay.comのSold/Completed実績を調査してください。serial/date codeは使わず、既存ChatGPT説明・キーワードは検索補助にのみ使用してください。カテゴリ、製造国、Condition、Item Specificsは推測しません。部品取り、ジャンク、箱のみ、別型番などの異常比較対象は除外してください。\n\n時計でmodelNumberが確定している場合は同じ型番だけを比較対象にしてください。別型番や近似型番へ広げて自動価格を作ってはいけません。caseSizeがある場合は同じケースサイズだけを採用してください。dialColorまたはcolorがある場合は文字盤色・文字盤仕様が一致するものだけを採用し、明示的に異なる文字盤は除外してください。対象商品にないDiamond、Pyramid、Tapestry、MOP/Mother of Pearl、Custom/Aftermarket等の特殊文字盤は除外してください。accessoriesが本体のみの場合、Box、Papers、Full Set、Certificate、Warranty Card等が付属する成約は自動価格の比較対象から除外してください。Conditionも対象商品と大きく異なるものは除外してください。これらの条件を満たすSold/Completed実績が2件未満なら、近い仕様へ広げずok=falseにしてください。\n\n実際のeBay Sold/Completed商品URLを最低2件確認できる場合だけok=true。soldUrlsとcomparablesのURLは、今回のWEB検索で実際に取得・確認したeBay item URLだけを返してください。検索で確認していないURLを推測・生成してはいけません。出品中価格しか確認できない場合や根拠不足ならok=false。\n\n価格はUSD整数で QUICK=比較的早く売る価格、TARGET=しばらく待って現実的に売る中心価格、HIGH=時間をかけて狙う上限寄り価格。QUICK <= TARGET <= HIGH。\n\nJSONのみ返してください:\n{"ok":true,"pricing":{"quickUsd":0,"targetUsd":0,"highUsd":0},"confidence":"high|medium","reasonJa":"短い日本語理由","soldUrls":["https://www.ebay.com/itm/...","https://www.ebay.com/itm/..."],"evidenceUrls":[],"comparables":[{"title":"","url":"https://www.ebay.com/itm/...","soldPriceUsd":0,"similarityReason":""}]}\n失敗時:{"ok":false,"reasonJa":"理由","soldUrls":[],"evidenceUrls":[]}`;

    const web = await searchWeb(prompt);
    const parsed = parseJson(web.text);
    if (!parsed || parsed.ok === false) {
      return res.status(200).json({
        ok: false,
        needsManualSoldInput: true,
        reason: clean(parsed?.reasonJa || "市場調査結果を安全に確定できませんでした。"),
        evidenceUrls: uniqueUrls(web.sources),
        webModel: MODEL,
        researchedAt: new Date().toISOString()
      });
    }

    return res.status(200).json(validate(parsed, web.sources, facts));
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
