const OpenAI = require("openai");

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-5.4-mini";
const OPENAI_WEB_MODEL = process.env.OPENAI_WEB_MODEL || "gpt-5.4-mini";
const OPENAI_WEB_FALLBACK_MODEL = process.env.OPENAI_WEB_FALLBACK_MODEL || "gpt-4o-mini";

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

function extractResponseText(responseJson) {
  if (typeof responseJson?.output_text === "string" && responseJson.output_text.trim()) {
    return responseJson.output_text.trim();
  }

  const parts = [];

  if (Array.isArray(responseJson?.output)) {
    responseJson.output.forEach((item) => {
      if (Array.isArray(item?.content)) {
        item.content.forEach((content) => {
          if (typeof content?.text === "string") {
            parts.push(content.text);
          }
        });
      }
    });
  }

  return parts.join("\n").trim();
}

function extractSourcesFromResponse(responseJson) {
  const sources = [];
  const seen = new Set();

  const addSource = (source) => {
    const url = source?.url || source?.link || "";
    const title = source?.title || source?.name || "";
    if (!url || seen.has(url)) return;
    seen.add(url);
    sources.push({ title, url });
  };

  if (Array.isArray(responseJson?.output)) {
    responseJson.output.forEach((item) => {
      if (Array.isArray(item?.content)) {
        item.content.forEach((content) => {
          if (Array.isArray(content?.annotations)) {
            content.annotations.forEach((annotation) => {
              if (annotation?.type === "url_citation") {
                addSource({
                  title: annotation.title || "",
                  url: annotation.url || ""
                });
              }
            });
          }
        });
      }

      if (Array.isArray(item?.action?.sources)) {
        item.action.sources.forEach(addSource);
      }
    });
  }

  return sources.slice(0, 10);
}

async function postOpenAiResponses(payload) {
  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`
    },
    body: JSON.stringify(payload)
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    const message = data?.error?.message || data?.error || `OpenAI Responses API error: ${response.status}`;
    throw new Error(message);
  }

  return data;
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

async function createOpenAiWebSearchReply(prompt) {
  try {
    const responseJson = await postOpenAiResponses({
      model: OPENAI_WEB_MODEL,
      tools: [
        {
          type: "web_search",
          external_web_access: true,
          user_location: {
            type: "approximate",
            country: "JP"
          }
        }
      ],
      tool_choice: "auto",
      input: prompt
    });

    return {
      reply: extractResponseText(responseJson),
      sources: extractSourcesFromResponse(responseJson),
      webModel: OPENAI_WEB_MODEL,
      webTool: "web_search"
    };
  } catch (firstError) {
    const responseJson = await postOpenAiResponses({
      model: OPENAI_WEB_FALLBACK_MODEL,
      tools: [
        {
          type: "web_search_preview",
          search_context_size: "low",
          user_location: {
            type: "approximate",
            country: "JP"
          }
        }
      ],
      tool_choice: "auto",
      input: prompt
    });

    return {
      reply: extractResponseText(responseJson),
      sources: extractSourcesFromResponse(responseJson),
      webModel: OPENAI_WEB_FALLBACK_MODEL,
      webTool: "web_search_preview",
      fallbackReason: firstError.message
    };
  }
}

async function createWatchOpenAiAutofill(facts) {
  const cleanFacts = compactFacts(facts);
  const searchQuery = buildWatchSearchQuery(cleanFacts);

  const prompt = `
[ROLE]
あなたは中古ブランド時計のEC出品文を作成する日本語ライターです。

[WEB検索]
次の検索クエリを使い、WEB上で型番・品名に一致する時計仕様を確認してください。
検索クエリ: ${searchQuery}

[最重要ルール]
- 出力はJSONのみです。
- 使ってよい根拠は、PROVIDED_FACTS と WEB検索で確認できた内容だけです。
- WEB検索で確認できない仕様を、一般知識や推測で補わないでください。
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
`.trim();

  const webResult = await createOpenAiWebSearchReply(prompt);
  const parsed = parseJsonObject(webResult.reply) || {};

  const productDescription = cleanPlainText(parsed.productDescription || parsed.description || "");
  const keywords = cleanKeywords(parsed.keywords || parsed.searchKeywords || "");

  return {
    reply: webResult.reply,
    productDescription,
    keywords,
    searchStatus: "ok",
    searchQuery,
    webModel: webResult.webModel,
    webTool: webResult.webTool,
    fallbackReason: webResult.fallbackReason || "",
    sources: webResult.sources
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

    if (mode === "watchOpenAiWebAutofill") {
      const result = await createWatchOpenAiAutofill(facts || {});
      res.json(result);
      return;
    }

    if (mode === "watchWebAutofill") {
      const result = await createWatchOpenAiAutofill(facts || {});
      res.json(result);
      return;
    }

    const reply = await createChatReply(message || "", system || "You are a helpful assistant.");
    res.json({ reply });
  } catch (e) {
    res.status(500).json({ error: "OpenAIエラー: " + e.message });
  }
};
