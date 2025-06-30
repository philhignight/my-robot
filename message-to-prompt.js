// message-to-prompt.js
const fs = require("fs").promises;
const utils = require("./utils");

async function buildPrompt() {
  try {
    await utils.ensureDir("ai-managed");

    if (!utils.getFileStructure()) {
      console.log("🔍 Generating project file structure...");
      await utils.generateFileStructure();
      console.log("✓ File structure generated");
    }

    const mode = utils.getActiveMode(await utils.readFileIfExists("mode.md"));
    const goals = await utils.readFileIfExists("goals.md");
    const context = await utils.readFileIfExists("ai-managed/context.md");
    const conversation = await utils.readFileIfExists("conversation.md");
    const basePrompt = await utils.readFileIfExists("prompts/base.md");
    const modePrompt = await utils.readFileIfExists("prompts/" + mode + ".md");
    const fileStructure = utils.getFileStructure();

    // Extract just the conversation history
    const lines = conversation.split("\n");
    const historyIndex = lines.findIndex(function (line) {
      return line.includes("=== CONVERSATION HISTORY ===");
    });
    let conversationHistory = "";
    if (historyIndex !== -1 && historyIndex + 1 < lines.length) {
      conversationHistory = lines
        .slice(historyIndex + 1)
        .join("\n")
        .trim();
    }

    let phaseResults = "";
    if (mode === "planning") {
      const findings = await utils.readFileIfExists(
        "ai-managed/exploration-findings.md"
      );
      if (findings.trim()) {
        phaseResults = "\n\nEXPLORATION FINDINGS:\n" + findings;
      }
    } else if (mode === "implementation") {
      const plan = await utils.readFileIfExists("ai-managed/detailed-plan.md");
      if (plan.trim()) {
        phaseResults = "\n\nIMPLEMENTATION PLAN:\n" + plan;
      }
    }

    // Build prompt with conditional sections
    let prompt =
      basePrompt +
      "\n\n" +
      modePrompt +
      "\n\nGOALS:\n" +
      goals +
      "\n\nPROJECT STRUCTURE:\n" +
      fileStructure +
      phaseResults;

    // Only include context if it has content
    if (context.trim()) {
      prompt += "\n\nCONTEXT:\n" + context;
    }

    // Only include conversation if there's history
    if (conversationHistory) {
      prompt += "\n\nCONVERSATION HISTORY:\n" + conversationHistory;
    }

    // Add instruction for AI to respond
    prompt +=
      "\n\nGenerate your response as the assistant. Remember to end with [[[MESSAGE_END]]].";

    await fs.writeFile("generated-prompt.md", prompt, "utf8");
    console.log("✓ Built prompt for " + mode + " mode");

    if (prompt.length > 500000) {
      console.log(
        "⚠ Warning: Prompt is " +
          prompt.length +
          " chars, approaching 600k limit"
      );
    }
  } catch (err) {
    console.error("Error building prompt:", err);
  }
}

module.exports = { buildPrompt: buildPrompt };
