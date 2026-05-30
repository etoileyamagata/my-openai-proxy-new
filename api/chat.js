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
    if (!source || typeof source !== "object") return;

    const url = source.url || source.link || source.uri || "";
    const title = source.title || source.name || source.display_name || source.displayed_link || "";

    if (!url || seen.has(url)) return;

    seen.add(url);
    sources.push({
      title: String(title || "").trim(),
      url: String(url || "").trim()
    });
  };

  const scanAnnotations = (content) => {
    if (!content || typeof content !== "object") return;

    if (Array.isArray(content.annotations)) {
      content.annotations.forEach((annotation) => {
        if (annotation?.type === "url_citation") {
          addSource({
            title: annotation.title || "",
            url: annotation.url || ""
          });
        }
      });
    }
  };

  if (Array.isArray(responseJson?.sources)) {
    responseJson.sources.forEach(addSource);
  }

  if (Array.isArray(responseJson?.output)) {
    responseJson.output.forEach((item) => {
      if (Array.isArray(item?.sources)) {
        item.sources.forEach(addSource);
      }

      if (Array.isArray(item?.action?.sources)) {
        item.action.sources.forEach(addSource);
      }

      if (Array.isArray(item?.content)) {
        item.content.forEach((content) => {
          scanAnnotations(content);

          if (Array.isArray(content?.sources)) {
            content.sources.forEach(addSource);
          }
        });
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
      include: ["web_search_call.action.sources"],
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
      include: ["web_search_call.action.sources"],
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

function buildGenericProductSearchQuery(facts) {
  const terms = [
    facts.brandJapanese,
    facts.brandEnglish,
    facts.modelNumber,
    facts.modelSecondName,
    facts.productName,
    facts.productSecondName,
    facts.lineName,
    facts.itemName,
    facts.productType,
    facts.category,
    facts.productCategory,
    facts.selectedCategory,
    facts.selectedSubCategory
  ]
    .map((value) => String(value || "").trim())
    .filter(Boolean);

  const uniqueTerms = [...new Set(terms)];
  return `${uniqueTerms.join(" ")} 商品情報 仕様 素材 ライン 特徴`.replace(/\s{2,}/g, " ").trim();
}

async function createGenericProductOpenAiAutofill(facts) {
  const cleanFacts = compactFacts(facts);
  const searchQuery = buildGenericProductSearchQuery(cleanFacts);
  const categoryName = String(
    cleanFacts.category ||
    cleanFacts.productCategory ||
    cleanFacts.selectedCategory ||
    cleanFacts.itemCategory ||
    "汎用商材"
  ).trim();

  const prompt = `
[ROLE]
あなたは中古ブランド品・中古商材のEC出品文を作成する日本語ライターです。

[WEB検索]
次の検索クエリを使い、WEB上でブランド名・型番・品名・ライン名に一致する商品情報を確認してください。
検索クエリ: ${searchQuery}

[対象カテゴリ]
${categoryName}

[最重要ルール]
- 出力はJSONのみです。
- 使ってよい根拠は、PROVIDED_FACTS と WEB検索で確認できた内容だけです。
- WEB検索で確認できない情報を、一般知識・シリーズ一般論・推測で補わないでください。
- 型番違い、似た商品、同じブランドの別モデル、後継モデル、現行モデルの情報を混ぜないでください。
- 状態、保証、店舗名、価格、相場、定価、買取、質預かり、鑑定、真贋、購入を煽る表現は書かないでください。
- 希少性、資産価値、入手困難、限定、廃番、年代は、WEB検索でその商品に明示されている場合でも商品説明には入れないでください。
- 商品説明とキーワードにURL、出典名、引用符、見出し、箇条書きは入れないでください。
- 十分な根拠がない場合は短くして構いません。事実を水増ししないでください。
- PROVIDED_FACTSに既に入力されている内容は、WEB検索結果より優先してください。
- PROVIDED_FACTSに入力されている素材・色・ライン名・型番・商品名を、WEB検索結果で上書きしないでください。

[カテゴリ別の厳格ルール]
- バッグ、財布、小物の場合：ライン名、モデル名、形状、開閉方式、収納特徴、代表的な素材は、型番・品名と一致するWEB検索結果で確認できる場合だけ入れてください。
- アパレルの場合：アイテム種別、コレクション名、素材表記、デザイン特徴は、WEB検索結果またはPROVIDED_FACTSで確認できる場合だけ入れてください。サイズ感、季節、年代、着用感は書かないでください。
- ライターの場合：ガスライター、オイルライター、電子ライター、モデル名、着火方式、素材は、WEB検索結果またはPROVIDED_FACTSで確認できる場合だけ入れてください。着火可否、火花確認、メンテナンス歴、修理歴は書かないでください。
- ジュエリー、貴金属の場合：ブランドコレクション名、モチーフ名、デザイン特徴は確認できる場合だけ入れてください。品位、石種、カラット、重量、天然石、合成石、鑑別結果はPROVIDED_FACTSにある場合だけ扱い、WEB検索結果だけで補わないでください。
- 汎用商材の場合：ブランド、型番、品名から確認できる用途、シリーズ、仕様、素材、特徴だけを入れてください。確認できない仕様は触れないでください。

[商品説明ルール]
- 日本語のみ。
- 2〜4文。
- 目安は120〜240字。ただし根拠が不足する場合は短くしてよい。
- 状態説明、ランク、付属品、価格、保証、店舗案内は入れないでください。
- 「これは○○です」だけで終わらせず、確認できるライン、形状、素材感、デザイン、用途、機能のいずれかを自然に含めてください。
- ただし確認できない要素は入れないでください。

[仕様キーワードルール]
- 日本語中心。
- 半角スペース区切りの1行。
- 8〜20語を目安。ただし確認できる語が少ない場合は少なくてよい。
- ブランド名、型番、商品名の完全一致だけの語は避けてください。
- 未確認の素材、ライン、仕様、機能、石種、品位、サイズを検索キーワードに入れないでください。

[素材出力ルール]
- material は、PROVIDED_FACTSに素材入力がある場合はその内容を優先してください。
- PROVIDED_FACTSに素材入力がない場合、WEB検索で型番・品名と一致する素材が明示されている場合だけ material に入れてください。
- 素材が確認できない場合は material を空文字にしてください。

[ライン名・アイテム名出力ルール]
- lineName は、WEB検索またはPROVIDED_FACTSで確認できるブランドライン名だけを入れてください。
- itemName は、WEB検索またはPROVIDED_FACTSで確認できるアイテム種別・型名だけを入れてください。
- 確認できない場合は空文字にしてください。

[OUTPUT JSON SCHEMA]
{
  "productDescription": "商品説明文",
  "keywords": "半角スペース区切りの仕様検索キーワード",
  "material": "確認できた素材。確認できない場合は空文字",
  "lineName": "確認できたライン名。確認できない場合は空文字",
  "itemName": "確認できたアイテム名。確認できない場合は空文字",
  "confirmedFacts": {
    "material": false,
    "lineName": false,
    "itemName": false,
    "modelMatched": false
  }
}

[PROVIDED_FACTS]
${JSON.stringify(cleanFacts, null, 2)}
`.trim();

  const webResult = await createOpenAiWebSearchReply(prompt);
  const parsed = parseJsonObject(webResult.reply) || {};

  const confirmedFacts = parsed.confirmedFacts && typeof parsed.confirmedFacts === "object"
    ? parsed.confirmedFacts
    : {};

  const sources = Array.isArray(webResult.sources) ? webResult.sources : [];
  const hasSources = sources.length > 0;

  const cleanOptionalText = (value) => cleanPlainText(value)
    .replace(/\r?\n/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();

  let productDescription = cleanPlainText(parsed.productDescription || parsed.description || "");
  let keywords = cleanKeywords(parsed.keywords || parsed.searchKeywords || "");
  let material = cleanOptionalText(parsed.material || "");
  let lineName = cleanOptionalText(parsed.lineName || "");
  let itemName = cleanOptionalText(parsed.itemName || "");

  if (!hasSources) {
    material = String(cleanFacts.material || "").trim();
    lineName = String(cleanFacts.lineName || "").trim();
    itemName = String(cleanFacts.itemName || "").trim();
  }

  if (!confirmedFacts.material && !cleanFacts.material) {
    material = "";
  }

  if (!confirmedFacts.lineName && !cleanFacts.lineName) {
    lineName = "";
  }

  if (!confirmedFacts.itemName && !cleanFacts.itemName) {
    itemName = "";
  }

  return {
    reply: webResult.reply,
    productDescription,
    keywords,
    material,
    lineName,
    itemName,
    confirmedFacts,
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

    if (mode === "productOpenAiWebAutofill") {
      const result = await createGenericProductOpenAiAutofill(facts || {});
      res.json(result);
      return;
    }

    const reply = await createChatReply(message || "", system || "You are a helpful assistant.");
    res.json({ reply });
  } catch (e) {
    res.status(500).json({ error: "OpenAIエラー: " + e.message });
  }
};
