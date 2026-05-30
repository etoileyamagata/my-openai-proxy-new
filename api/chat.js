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
  return `${uniqueTerms.join(" ")} 腕時計 仕様 スペック`.replace(/\s{2,}/g, " ").trim();
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
- WEB検索で確認できない仕様を、一般知識・一般的なシリーズ知識・推測で補わないでください。
- 型番と品名が一致しているページで確認できた仕様だけを使用してください。
- 型番違い、似たモデル、同じシリーズの別モデル、後継モデル、現行モデルの仕様を混ぜないでください。
- 確認できない仕様、年式、限定情報、相場、定価、資産価値、希少性は書かないでください。
- 状態、保証、店舗名、価格、買取、質預かり、鑑定、購入を煽る表現は書かないでください。
- 商品説明とキーワードにURL、出典名、引用符、見出し、箇条書きは入れないでください。
- 「これは○○の時計です」だけで終わらせず、確認できるコレクション、デザイン、機構、装着シーンのいずれかを自然に含めてください。
- 十分な根拠がない場合は短くして構いません。事実を水増ししないでください。

[機能仕様の厳格ルール]
- 日付表示、デイト表示、デイト、カレンダー表示、日付窓は、WEB検索でその型番に明示されている場合だけ confirmedFeatures.dateDisplay を true にしてください。
- クロノグラフ、GMT、ムーンフェイズ、パワーリザーブ表示、コーアクシャル、マスタークロノメーター、クロノメーター、サファイアガラス、防水性能、ソーラー、電波時計も、WEB検索でその型番に明示されている場合だけ true にしてください。
- 明示確認できない機能は、confirmedFeatures で必ず false にしてください。
- confirmedFeatures が false の機能名は、productDescription と keywords に絶対に入れないでください。

[商品説明ルール]
- 日本語のみ。
- 2〜4文。
- 目安は120〜240字。ただし根拠が不足する場合は短くしてよい。
- サイズや重量の数値は、PROVIDED_FACTSにあっても商品説明には入れないでください。
- 未確認の機能名を商品説明に入れないでください。

[仕様キーワードルール]
- 日本語中心。
- 半角スペース区切りの1行。
- 8〜20語を目安。ただし確認できる語が少ない場合は少なくてよい。
- ブランド名、型番、商品名の完全一致だけの語は避けてください。
- 未確認の機能名を検索キーワードに入れないでください。

[OUTPUT JSON SCHEMA]
{
  "productDescription": "商品説明文",
  "keywords": "半角スペース区切りの仕様検索キーワード",
  "confirmedFeatures": {
    "dateDisplay": false,
    "chronograph": false,
    "gmt": false,
    "moonPhase": false,
    "powerReserveDisplay": false,
    "coAxial": false,
    "masterChronometer": false,
    "chronometer": false,
    "sapphireCrystal": false,
    "waterResistance": false,
    "solar": false,
    "radioControlled": false
  }
}

[PROVIDED_FACTS]
${JSON.stringify(cleanFacts, null, 2)}
`.trim();

  const webResult = await createOpenAiWebSearchReply(prompt);
  const parsed = parseJsonObject(webResult.reply) || {};

  const confirmedFeatures = parsed.confirmedFeatures && typeof parsed.confirmedFeatures === "object"
    ? parsed.confirmedFeatures
    : {};

  const sources = Array.isArray(webResult.sources) ? webResult.sources : [];
  const hasSources = sources.length > 0;

  const isConfirmed = (key) => {
    if (!hasSources) return false;
    return confirmedFeatures[key] === true;
  };

  const removeSentencesContaining = (text, terms) => {
    const sentences = String(text || "").match(/[^。！？]*[。！？]?/g) || [];
    return sentences
      .filter((sentence) => {
        const trimmed = sentence.trim();
        if (!trimmed) return false;
        return !terms.some((term) => trimmed.includes(term));
      })
      .join("")
      .trim();
  };

  const removeKeywordTokens = (text, tokens, regexRules) => {
    return String(text || "")
      .split(/\s+/)
      .filter((token) => {
        if (!token) return false;
        if (tokens.includes(token)) return false;
        return !regexRules.some((rule) => rule.test(token));
      })
      .join(" ")
      .replace(/\s{2,}/g, " ")
      .trim();
  };

  let productDescription = cleanPlainText(parsed.productDescription || parsed.description || "");
  let keywords = cleanKeywords(parsed.keywords || parsed.searchKeywords || "");

  const featureRules = [
    {
      key: "dateDisplay",
      sentenceTerms: ["日付表示", "デイト表示", "カレンダー表示", "日付窓", "日付を表示", "3時位置に日付"],
      keywordTokens: ["日付表示", "デイト表示", "デイト", "カレンダー表示", "日付窓"],
      keywordRegex: []
    },
    {
      key: "chronograph",
      sentenceTerms: ["クロノグラフ"],
      keywordTokens: ["クロノグラフ"],
      keywordRegex: []
    },
    {
      key: "gmt",
      sentenceTerms: ["GMT"],
      keywordTokens: ["GMT"],
      keywordRegex: []
    },
    {
      key: "moonPhase",
      sentenceTerms: ["ムーンフェイズ"],
      keywordTokens: ["ムーンフェイズ"],
      keywordRegex: []
    },
    {
      key: "powerReserveDisplay",
      sentenceTerms: ["パワーリザーブ表示"],
      keywordTokens: ["パワーリザーブ表示"],
      keywordRegex: []
    },
    {
      key: "coAxial",
      sentenceTerms: ["コーアクシャル", "Co-Axial", "Co Axial"],
      keywordTokens: ["コーアクシャル", "Co-Axial", "Co", "Axial"],
      keywordRegex: []
    },
    {
      key: "masterChronometer",
      sentenceTerms: ["マスタークロノメーター", "Master Chronometer"],
      keywordTokens: ["マスタークロノメーター", "Master", "Chronometer"],
      keywordRegex: []
    },
    {
      key: "chronometer",
      sentenceTerms: ["クロノメーター"],
      keywordTokens: ["クロノメーター"],
      keywordRegex: []
    },
    {
      key: "sapphireCrystal",
      sentenceTerms: ["サファイアガラス", "サファイアクリスタル"],
      keywordTokens: ["サファイアガラス", "サファイアクリスタル"],
      keywordRegex: []
    },
    {
      key: "waterResistance",
      sentenceTerms: ["防水", "防水性能"],
      keywordTokens: ["防水", "防水性能"],
      keywordRegex: [/^\d+m防水$/, /^\d+M防水$/, /^\d+気圧防水$/, /^\d+ATM$/]
    },
    {
      key: "solar",
      sentenceTerms: ["ソーラー"],
      keywordTokens: ["ソーラー"],
      keywordRegex: []
    },
    {
      key: "radioControlled",
      sentenceTerms: ["電波時計", "電波受信"],
      keywordTokens: ["電波時計", "電波受信"],
      keywordRegex: []
    }
  ];

  featureRules.forEach((rule) => {
    if (!isConfirmed(rule.key)) {
      productDescription = removeSentencesContaining(productDescription, rule.sentenceTerms);
      keywords = removeKeywordTokens(keywords, rule.keywordTokens, rule.keywordRegex);
    }
  });

  return {
    reply: webResult.reply,
    productDescription,
    keywords,
    confirmedFeatures,
    searchStatus: "ok",
    searchQuery,
    webModel: webResult.webModel,
    webTool: webResult.webTool,
    fallbackReason: webResult.fallbackReason || "",
    sources
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
