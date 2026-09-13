process.env.OPENAI_MODEL = "gpt-5.6-luna";
process.env.OPENAI_WEB_MODEL = "gpt-5.6-luna";
process.env.OPENAI_WEB_FALLBACK_MODEL = "gpt-5.6-luna";

const baseHandler = require("./chat");

function extractPromptField(message, label) {
  const escapedLabel = String(label || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = String(message || "").match(new RegExp(`^\\s*${escapedLabel}\\s*:\\s*(.*?)\\s*$`, "mi"));
  return match ? match[1].trim() : "";
}

function parseLegacyProductSummaryFacts(message) {
  const text = String(message || "");

  if (!/Write a concise Japanese sales summary\s*\(250[–-]300 chars/i.test(text)) {
    return null;
  }

  const roleMatch = text.match(/You are a ([^.\n]+?) product describer\./i);
  if (!roleMatch) return null;

  const role = roleMatch[1].toLowerCase();
  let category = "汎用商材";

  if (role.includes("bag")) category = "バッグ";
  if (role.includes("wallet")) category = "財布・小物";
  if (role.includes("apparel")) category = "アパレル";
  if (role.includes("jewelry")) category = "ジュエリー・貴金属";

  const facts = {
    category,
    brandJapanese: extractPromptField(text, "Brand"),
    modelNumber: extractPromptField(text, "Model Number"),
    productName: extractPromptField(text, "Product Name"),
    color: extractPromptField(text, "Color"),
    purity: extractPromptField(text, "Purity")
  };

  Object.keys(facts).forEach((key) => {
    if (!String(facts[key] || "").trim()) delete facts[key];
  });

  const hasProductIdentity = Boolean(
    facts.brandJapanese ||
    facts.modelNumber ||
    facts.productName ||
    facts.purity
  );

  return hasProductIdentity ? facts : null;
}

function cleanReply(value) {
  return String(value || "")
    .replace(/```[a-zA-Z]*\n?/g, "")
    .replace(/```/g, "")
    .replace(/^\s*(商品説明|販売用要約文|要約文|OUTPUT)\s*[:：]\s*/gmi, "")
    .replace(/[\u200B\u00A0\u3000]/g, "")
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+([、。！？,.])/g, "$1")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function countOccurrences(text, value) {
  const target = String(value || "").trim();
  if (!target) return 0;
  return String(text || "").split(target).length - 1;
}

function needsNaturalRewrite(description, facts) {
  const text = String(description || "").trim();
  if (!text) return true;

  const bannedPhrases = [
    "ブランド名は",
    "商品名は",
    "モデル番号は",
    "カラーは",
    "商品情報です",
    "確認済み",
    "ご案内します",
    "ご確認いただけます",
    "お探しの方に"
  ];

  if (bannedPhrases.some((phrase) => text.includes(phrase))) return true;
  if (text.length > 240) return true;

  const identityValues = [
    facts.brandJapanese,
    facts.modelNumber,
    facts.productName,
    facts.color
  ].filter(Boolean);

  return identityValues.some((value) => countOccurrences(text, value) > 1);
}

function buildNaturalRewritePrompt(facts) {
  return `
[INSTRUCTION]
以下の確認済み情報だけを使って、中古ブランド品EC向けの自然な日本語の商品説明を作成してください。

[STRICT RULES]
- 1〜3文で簡潔にまとめてください。
- 80〜180字を目安としますが、情報が少ない場合は短くて構いません。
- 同じ事実を言い換えて繰り返さないでください。
- 文字数を埋めるための水増しは禁止です。
- 「ブランド名は」「商品名は」「モデル番号は」「カラーは」「商品情報です」「確認済み」「ご案内します」「ご確認いただけます」「お探しの方に」は使わないでください。
- ブランド名、型番、商品名、カラーなどは、必要な場合だけ自然な文章の中で1回まで使用してください。
- 推測、状態、ランク、付属品、価格、相場、買取、質預かり、鑑定、真贋、購入を煽る表現は入れないでください。
- 見出し、箇条書き、URL、出典名は入れないでください。
- 説明文だけを出力してください。

[CONFIRMED FACTS]
${JSON.stringify(facts, null, 2)}

[OUTPUT]
`.trim();
}

function runBaseHandler(body) {
  return new Promise((resolve, reject) => {
    let statusCode = 200;
    let settled = false;

    const finish = (payload) => {
      if (settled) return;
      settled = true;
      resolve({ statusCode, payload });
    };

    const captureRes = {
      setHeader() {
        return captureRes;
      },
      status(code) {
        statusCode = code;
        return captureRes;
      },
      json(payload) {
        finish(payload);
        return captureRes;
      },
      end(payload) {
        finish(payload);
        return captureRes;
      }
    };

    Promise.resolve(baseHandler({ method: "POST", body }, captureRes))
      .then(() => {
        if (!settled) finish(null);
      })
      .catch(reject);
  });
}

async function createImprovedLegacyProductSummary(message) {
  const facts = parseLegacyProductSummaryFacts(message);
  if (!facts) return null;

  const webResult = await runBaseHandler({
    mode: "productOpenAiWebAutofill",
    facts
  });

  if (webResult.statusCode < 400 && webResult.payload) {
    const productDescription = cleanReply(webResult.payload.productDescription || "");

    const confirmedFacts = {
      ...facts,
      material: String(webResult.payload.material || "").trim(),
      lineName: String(webResult.payload.lineName || "").trim(),
      itemName: String(webResult.payload.itemName || "").trim()
    };

    Object.keys(confirmedFacts).forEach((key) => {
      if (!String(confirmedFacts[key] || "").trim()) delete confirmedFacts[key];
    });

    if (productDescription && !needsNaturalRewrite(productDescription, facts)) {
      return productDescription;
    }

    const rewriteResult = await runBaseHandler({
      message: buildNaturalRewritePrompt(confirmedFacts),
      system: "確認済み情報だけを使い、重複のない自然な日本語の商品説明だけを返してください。"
    });

    if (rewriteResult.statusCode < 400) {
      const rewritten = cleanReply(rewriteResult.payload?.reply || "");
      if (rewritten) return rewritten;
    }
  }

  const fallbackResult = await runBaseHandler({
    message: buildNaturalRewritePrompt(facts),
    system: "入力済みの事実だけを使い、重複のない自然な日本語の商品説明だけを返してください。"
  });

  if (fallbackResult.statusCode < 400) {
    const fallbackReply = cleanReply(fallbackResult.payload?.reply || "");
    if (fallbackReply) return fallbackReply;
  }

  return null;
}

module.exports = async (req, res) => {
  const message = req?.body?.message || "";
  const legacyFacts = parseLegacyProductSummaryFacts(message);

  if (!legacyFacts) {
    return baseHandler(req, res);
  }

  try {
    const improvedReply = await createImprovedLegacyProductSummary(message);
    if (improvedReply) {
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type");
      res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
      res.json({ reply: improvedReply });
      return;
    }
  } catch (e) {
  }

  req.body = {
    ...(req.body || {}),
    message: buildNaturalRewritePrompt(legacyFacts),
    system: "入力済みの事実だけを使い、重複のない自然な日本語の商品説明だけを返してください。"
  };

  return baseHandler(req, res);
};
