const OpenAI = require("openai");
const axios = require("axios");

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-5.4-mini";

function normalizeEnglishText(value) {
  return String(value || "")
    .replace(/```[a-zA-Z]*\n?/g, "")
    .replace(/```/g, "")
    .replace(/^\s*(ブランド名|英語名|商品名|出力|OUTPUT)\s*[:：]\s*/i, "")
    .replace(/[「」『』]/g, "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[™®©]/g, "")
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[^\x20-\x7E]/g, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function cleanPlainText(value) {
  return String(value || "")
    .replace(/```[a-zA-Z]*\n?/g, "")
    .replace(/```/g, "")
    .replace(/^\s*(商品説明|販売用要約文|要約文|OUTPUT)\s*[:：]\s*/gmi, "")
    .replace(/[\u200B\u00A0\u3000]/g, "")
    .replace(/\r\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function cleanKeywords(value) {
  return String(value || "")
    .replace(/```[a-zA-Z]*\n?/g, "")
    .replace(/```/g, "")
    .replace(/^\s*(SEOキーワード|検索キーワード|キーワード|仕様|OUTPUT)\s*[:：]\s*/gmi, "")
    .replace(/[、，,。]/g, " ")
    .replace(/[\u200B\u00A0\u3000]/g, "")
    .replace(/\r?\n/g, " ")
    .replace(/[【】\[\]（）()]/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
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

  try {
    return JSON.parse(raw.slice(start, end + 1));
  } catch (e) {
    return null;
  }
}

function compactFacts(facts) {
  const input = facts && typeof facts === "object" ? facts : {};
  return Object.fromEntries(
    Object.entries(input).filter(([, value]) => String(value || "").trim() !== "")
  );
}

function buildWatchSearchQuery(facts) {
  const terms = [
    facts.brandJapanese,
    facts.brandEnglish,
    facts.modelNumber,
    facts.modelSecondName,
    facts.productName,
    facts.productSecondName
  ]
    .map((value) => String(value || "").trim())
    .filter(Boolean);

  const uniqueTerms = [...new Set(terms)];
  return `${uniqueTerms.join(" ")} 腕時計 仕様 デイト 日付表示 ムーブメント 防水`.replace(/\s{2,}/g, " ").trim();
}

async function searchWithSerpApi(query) {
  if (!process.env.SERPAPI_API_KEY) {
    return {
      status: "skipped_no_serpapi_key",
      query,
      results: []
    };
  }

  if (!query) {
    return {
      status: "skipped_no_query",
      query,
      results: []
    };
  }

  try {
    const response = await axios.get("https://serpapi.com/search", {
      params: {
        engine: "google",
        q: query,
        api_key: process.env.SERPAPI_API_KEY,
        hl: "ja",
        gl: "jp",
        google_domain: "google.co.jp",
        num: 10
      },
      timeout: 12000
    });

    const organicResults = Array.isArray(response.data?.organic_results)
      ? response.data.organic_results
      : [];

    const results = organicResults.slice(0, 8).map((item, index) => ({
      position: item.position || index + 1,
      title: item.title || "",
      snippet: item.snippet || "",
      source: item.displayed_link || "",
      link: item.link || ""
    }));

    return {
      status: "ok",
      query,
      results
    };
  } catch (e) {
    return {
      status: "serpapi_error",
      query,
      error: e.message,
      results: []
    };
  }
}

async function createChatReply(message, systemContent) {
  const response = await openai.chat.completions.create({
    model: OPENAI_MODEL,
    messages: [
      { role: "system", content: systemContent || "You are a helpful assistant." },
      { role: "user", content: message || "" }
    ]
  });

  return response.choices?.[0]?.message?.content || "";
}

async function createWatchAutofill(facts) {
  const cleanFacts = compactFacts(facts);
  const searchQuery = buildWatchSearchQuery(cleanFacts);
  const searchPayload = await searchWithSerpApi(searchQuery);

  const prompt = `
[ROLE]
あなたは中古ブランド時計のEC出品文を作成する日本語ライターです。

[最重要ルール]
- 出力はJSONのみです。
- 使ってよい根拠は、PROVIDED_FACTS と SEARCH_RESULTS に含まれる内容だけです。
- SEARCH_RESULTSにない仕様を、一般知識や推測で補わないでください。
- 型番・品名から日付表示、クロノグラフ、GMT、ムーンフェイズ、コーアクシャル、マスタークロノメーター、防水、素材、対象性別、愛称などが確認できる場合のみ入れてください。
- 確認できない仕様、年式、限定情報、相場、定価、資産価値、希少性は書かないでください。
- 状態、保証、店舗名、価格、買取、質預かり、鑑定、購入を煽る表現は書かないでください。
- 「これは○○の時計です」だけで終わらせず、確認できるコレクション、デザイン、機構、表示機能、文字盤、素材、装着シーンのいずれかを自然に含めてください。
- 十分な根拠がない場合は短くして構いません。事実を水増ししないでください。
- 商品説明とキーワードにURL、出典名、引用符、見出し、箇条書きは入れないでください。

[商品説明ルール]
- 日本語のみ。
- 2〜4文。
- 目安は160〜280字。ただし根拠が不足する場合は短くしてよい。
- サイズや重量の数値は、PROVIDED_FACTSにあっても商品説明には入れないでください。

[仕様キーワードルール]
- 日本語中心。
- 半角スペース区切りの1行。
- 12〜24語を目安。ただし確認できる語が少ない場合は少なくてよい。
- ブランド名、型番、商品名の完全一致だけの語は避けてください。
- PROVIDED_FACTSにある文字盤色、素材、風防、駆動方式、ムーブメント、防水、性別は、検索用に有用なら入れてください。
- 確認済みの場合は、デイト表示 日付表示 クロノグラフ GMT ムーンフェイズ パワーリザーブ表示 自動巻き 手巻き クオーツ ソーラー 電波時計 コーアクシャル マスタークロノメーター クロノメーター サファイアガラス 防水 メンズ レディース ボーイズ などを入れてください。

[OUTPUT JSON SCHEMA]
{
  "productDescription": "商品説明文",
  "keywords": "半角スペース区切りの仕様検索キーワード"
}

[PROVIDED_FACTS]
${JSON.stringify(cleanFacts, null, 2)}

[SEARCH_RESULTS]
${JSON.stringify(searchPayload.results, null, 2)}
`.trim();

  const reply = await createChatReply(
    prompt,
    "You generate strictly factual Japanese EC listing copy. Output JSON only."
  );

  const parsed = parseJsonObject(reply) || {};

  return {
    reply,
    productDescription: cleanPlainText(parsed.productDescription || ""),
    keywords: cleanKeywords(parsed.keywords || ""),
    searchStatus: searchPayload.status,
    searchQuery: searchPayload.query,
    sources: searchPayload.results.map((item) => ({
      title: item.title,
      source: item.source,
      link: item.link
    }))
  };
}

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");

  if (req.method === "OPTIONS") {
    res.status(200).end();
    return;
  }

  if (req.method !== "POST") {
    res.status(405).json({ error: "POSTのみ対応しています" });
    return;
  }

  try {
    const body = req.body || {};
    const { message, mode, facts, system } = body;

    if (mode === "watchWebAutofill") {
      const result = await createWatchAutofill(facts || {});
      res.json(result);
      return;
    }

    const reply = await createChatReply(message || "", system || "You are a helpful assistant.");
    res.json({ reply });
  } catch (e) {
    res.status(500).json({ error: "OpenAIエラー: " + e.message });
  }
};
