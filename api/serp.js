// my-openai-proxy-new/api/serp.js
const axios = require("axios");

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");

  if (req.method === "OPTIONS") {
    res.status(200).end();
    return;
  }

  try {
    const { q } = req.body;
    const response = await axios.get("https://serpapi.com/search", {
      params: {
        q,
        api_key: process.env.SERPAPI_API_KEY,
        hl: "ja",
        gl: "jp",
      },
    });
    res.json(response.data);
  } catch (e) {
    res.status(500).json({ error: "SerpAPIエラー: " + e.message });
  }
};
