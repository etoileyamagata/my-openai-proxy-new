process.env.OPENAI_MODEL = "gpt-5.6-luna";
process.env.OPENAI_WEB_MODEL = "gpt-5.6-luna";
process.env.OPENAI_WEB_FALLBACK_MODEL = "gpt-5.6-luna";

module.exports = require("./chat");
