const core = require("./ebay-market-core");
const prompts = require("./ebay-market-prompts");

async function searchWeb(prompt, searchContextSize = "medium") {
  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`
    },
    body: JSON.stringify({
      model: core.MODEL,
      tools: [{ type: "web_search", search_context_size: searchContextSize, user_location: { type: "approximate", country: "JP" } }],
      tool_choice: "auto",
      include: ["web_search_call.action.sources"],
      max_output_tokens: 5000,
      input: prompt
    })
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data?.error?.message || data?.error || `OpenAI Responses API error: ${response.status}`);
  return { text: core.responseText(data), sources: core.sourceUrls(data) };
}

function chunks(values, size) {
  const out = [];
  for (let i = 0; i < values.length; i += size) out.push(values.slice(i, i + size));
  return out;
}

async function verifyCandidates(facts, candidates) {
  const comparables = [];
  const evidence = [];
  for (const batch of chunks(candidates, core.VERIFY_BATCH_SIZE)) {
    const response = await searchWeb(prompts.verificationPrompt(facts, batch), "high");
    evidence.push(...response.sources);
    const parsed = core.parseJson(response.text);
    if (Array.isArray(parsed?.comparables)) comparables.push(...parsed.comparables);
    else if (Array.isArray(parsed?.verifiedComparables)) comparables.push(...parsed.verifiedComparables);
  }
  return { comparables, sources: core.uniqEbayUrls(evidence) };
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
    const facts = core.marketFacts(req.body?.facts || {});
    if (!facts.categoryId || !facts.brandEnglish) return res.status(400).json({ ok: false, error: "categoryId and brandEnglish are required" });

    const discovery1 = await searchWeb(prompts.discoveryPrompt(facts), "medium");
    const parsed1 = core.parseJson(discovery1.text);
    let candidates = core.rankCandidates(Array.isArray(parsed1?.candidateUrls) ? parsed1.candidateUrls : [], discovery1.sources);

    if (!candidates.length) {
      const reason = core.clean(parsed1?.reasonJa || "eBay Sold/Completed候補を確認できませんでした。");
      return res.status(200).json({
        ok: false, needsManualSoldInput: true, reason, reasonJa: reason, soldUrls: [],
        evidenceUrls: core.uniqEbayUrls(discovery1.sources), comparables: [], confirmedComparableCount: 0,
        exactPriceComparableCount: 0, supportPriceComparableCount: 0, pricingMethod: "server_quantile_v3",
        webModel: core.MODEL, researchedAt: new Date().toISOString()
      });
    }

    const verification1 = await verifyCandidates(facts, candidates);
    let rawComparables = verification1.comparables;
    let verificationSources = verification1.sources;
    let assessed = core.mergeAndAssess(rawComparables, candidates, facts);
    let result = core.resultFromAssessment(assessed, verificationSources);

    if (result.ok !== true && candidates.length < core.MAX_TOTAL_CANDIDATES) {
      const context = `対象条件まで確認できたSold=${result.confirmedComparableCount || 0}件、確定USD実売価格=${result.exactPriceComparableCount || 0}件、補助価格=${result.supportPriceComparableCount || 0}件。自動相場算定に不足する根拠を増やしてください。`;
      const discovery2 = await searchWeb(prompts.discoveryPrompt(facts, candidates, context), "medium");
      const parsed2 = core.parseJson(discovery2.text);
      const existingIds = new Set(candidates.map(core.ebayItemId));
      const recovery = core.rankCandidates(Array.isArray(parsed2?.candidateUrls) ? parsed2.candidateUrls : [], discovery2.sources, core.MAX_RECOVERY_CANDIDATES)
        .filter(url => !existingIds.has(core.ebayItemId(url)));

      if (recovery.length) {
        const verification2 = await verifyCandidates(facts, recovery);
        candidates = [...candidates, ...recovery].slice(0, core.MAX_TOTAL_CANDIDATES);
        rawComparables = [...rawComparables, ...verification2.comparables];
        verificationSources = core.uniqEbayUrls([...verificationSources, ...verification2.sources]);
        assessed = core.mergeAndAssess(rawComparables, candidates, facts);
        result = core.resultFromAssessment(assessed, verificationSources);
      }
    }

    return res.status(200).json(result);
  } catch (error) {
    return res.status(500).json({
      ok: false, needsManualSoldInput: true,
      error: error instanceof Error ? error.message : String(error),
      webModel: core.MODEL, researchedAt: new Date().toISOString()
    });
  }
};
