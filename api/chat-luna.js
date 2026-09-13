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

function buildSalesRecommendationPrompt(context) {
  return `
[ROLE]
あなたは中古ブランド品を扱うECショップの経験豊富な販売員です。
入力された商品を理解したうえで、購入を検討しているお客様に魅力が伝わる自然な商品説明を書いてください。

[目的]
- 単なる項目の読み上げではなく、「どのような商品か」「どこが魅力か」「どのような使い方や人に向いているか」が伝わる説明にしてください。
- 商品の特徴から合理的に導ける範囲で、使用イメージやおすすめ対象まで自然につなげてください。
- おすすめ表現は販売員として自然な範囲にし、誇大表現や根拠のない断定はしないでください。

[最重要ルール]
- 出力は商品説明本文だけです。
- 日本語のみ、2〜4文を基本とします。
- 100〜220字程度を目安にしますが、情報が少ない場合は短くして構いません。
- 同じブランド名、型番、商品名、特徴を言い換えて何度も繰り返さないでください。
- 文字数を埋めるための水増しは禁止です。
- PROVIDED_FACTS と WEB_VERIFIED_CONTEXT にある情報だけを商品の事実として使用してください。
- WEB_VERIFIED_CONTEXT にない仕様、素材、ライン、年代、人気、希少性、資産価値、耐久性、収納力、サイズ感を勝手に補わないでください。
- 「ブランド名は」「商品名は」「モデル番号は」「商品情報です」「確認済み」「ご案内します」「ご確認いただけます」「お探しの方に」は使わないでください。
- 状態、ランク、傷、汚れ、付属品、保証、価格、相場、買取、質預かり、鑑定、真贋、店舗案内は書かないでください。

[カラーに関する絶対ルール]
- カラー情報はAILISから商品説明生成へ渡されていません。
- 商品の色、カラー名、配色、色調は一切説明に入れないでください。
- WEB_VERIFIED_CONTEXT 内の文章に色の記載が含まれていても、その部分は無視してください。
- WEB検索からカラーを推測・補完してはいけません。
- ただし「K18YG」「イエローゴールド」などが PROVIDED_FACTS の品位・素材情報として明示されている場合は、素材名としてのみ使用できます。

[おすすめ表現のルール]
- 確認できた形状、素材、構造、仕様、デザインから自然に導ける用途・おすすめ対象は書いて構いません。
- 例：コンパクトな形状が確認できる場合、「荷物を絞って持ち歩きたい方におすすめ」と表現できます。
- 例：ショルダーストラップ仕様が確認できる場合、「両手を空けて使いたい場面にも取り入れやすい」と表現できます。
- 根拠になる特徴が確認できない場合は、無理に「おすすめ」を作らず商品の魅力だけを簡潔に説明してください。
- 「絶対に買うべき」「一生使える」「誰にでも似合う」「資産価値が高い」など、根拠のない強い販売表現は禁止です。

[文章構成]
1. 商品のブランド・モデルと、確認できた代表的な特徴を自然に紹介する。
2. 素材・ライン・形状・構造・デザインなど、確認できた魅力を説明する。
3. その特徴から自然に導ける使い方や、おすすめしたい人を添える。

[PROVIDED_FACTS]
${JSON.stringify(context.providedFacts || {}, null, 2)}

[WEB_VERIFIED_CONTEXT]
${JSON.stringify(context.webVerifiedContext || {}, null, 2)}

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

async function createSalesRecommendation(message) {
  const facts = parseLegacyProductSummaryFacts(message);
  if (!facts) return null;

  let webVerifiedContext = {};

  try {
    const webResult = await runBaseHandler({
      mode: "productOpenAiWebAutofill",
      facts
    });

    if (webResult.statusCode < 400 && webResult.payload) {
      const payload = webResult.payload;
      const sources = Array.isArray(payload.sources) ? payload.sources : [];
      const confirmedFacts = payload.confirmedFacts && typeof payload.confirmedFacts === "object"
        ? payload.confirmedFacts
        : {};

      const modelMatched = facts.modelNumber
        ? confirmedFacts.modelMatched === true
        : sources.length > 0;

      if (sources.length > 0 && modelMatched) {
        webVerifiedContext = {
          productSummary: cleanReply(payload.productDescription || ""),
          material: String(payload.material || "").trim(),
          lineName: String(payload.lineName || "").trim(),
          itemName: String(payload.itemName || "").trim()
        };

        Object.keys(webVerifiedContext).forEach((key) => {
          if (!String(webVerifiedContext[key] || "").trim()) {
            delete webVerifiedContext[key];
          }
        });
      }
    }
  } catch (e) {
    webVerifiedContext = {};
  }

  const rewriteResult = await runBaseHandler({
    message: buildSalesRecommendationPrompt({
      providedFacts: facts,
      webVerifiedContext
    }),
    system: "確認できた商品情報だけを事実として使い、カラーには一切触れず、商品の魅力とおすすめ対象が自然に伝わるEC向け商品説明だけを返してください。"
  });

  if (rewriteResult.statusCode < 400) {
    const reply = cleanReply(rewriteResult.payload?.reply || "");
    if (reply) return reply;
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
    const improvedReply = await createSalesRecommendation(message);

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
    message: buildSalesRecommendationPrompt({
      providedFacts: legacyFacts,
      webVerifiedContext: {}
    }),
    system: "入力済みの商品情報だけを使い、カラーには一切触れず、商品の魅力が自然に伝わる短いEC向け商品説明だけを返してください。"
  };

  return baseHandler(req, res);
};
