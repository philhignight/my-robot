// watcher.js
const fs = require("fs");
const buildPrompt = require("./message-to-prompt").buildPrompt;
const processResponse = require("./process-response").processResponse;
const utils = require("./utils");

const watchedFiles = {
  "conversation.md": handleConversationChange,
  "ai-response.md": processResponse,
};

async function handleConversationChange() {
  try {
    const conversation = await utils.readFileIfExists("conversation.md");

    const lines = conversation.split("\n");
    const messageIndex = lines.findIndex(function (line) {
      return line.includes("=== WAITING FOR YOUR MESSAGE ===");
    });

    if (messageIndex !== -1 && messageIndex + 1 < lines.length) {
      const messageContent = lines[messageIndex + 1];
      if (
        messageContent.trim() &&
        messageContent !== "[write here when ready]"
      ) {
        await moveMessageToHistory(messageContent);
        await buildPrompt();
        console.log("✓ New prompt ready in generated-prompt.md");
        return;
      }
    }
  } catch (err) {
    console.error("Error handling conversation change:", err);
  }
}

async function moveMessageToHistory(message) {
  const conversation = await utils.readFileIfExists("conversation.md");
  const lines = conversation.split("\n");

  const historyIndex = lines.findIndex(function (line) {
    return line.includes("=== CONVERSATION HISTORY ===");
  });

  if (historyIndex !== -1) {
    const before = lines.slice(0, historyIndex + 1);
    const after = lines.slice(historyIndex + 1);

    const updated = [
      "=== WAITING FOR YOUR MESSAGE ===",
      "[write here when ready]",
      "",
    ]
      .concat(before.slice(historyIndex))
      .concat(["USER: " + message])
      .concat(after);

    await require("fs").promises.writeFile(
      "conversation.md",
      updated.join("\n"),
      "utf8"
    );
    console.log("✓ Moved user message to history");
  }
}

async function createInitialFiles() {
  const initialFiles = {
    "conversation.md":
      "=== WAITING FOR YOUR MESSAGE ===\n[write here when ready]\n\n=== CONVERSATION HISTORY ===",
    "mode.md": "x exploration\n  planning\n  implementation",
    "goals.md": "# Project Goals\n\nAdd your high-level objectives here",
    "ai-response.md": "",
    "generated-prompt.md": "",
    "prompts/base.md":
      "# Base prompt template - create this file with tool format documentation",
    "prompts/exploration.md":
      '# EXPLORATION MODE\n\nYour job is to understand the codebase and requirements:\n\n- Use READ_FILE to examine key files\n- Use SEARCH_FILES_BY_NAME and SEARCH_FILES_BY_CONTENT to discover patterns\n- Ask clarifying questions about requirements  \n- Document findings with DISCOVERED blocks (importance 1-10)\n- When you have sufficient understanding, create/update exploration findings using:\n\nEXPLORATION_FINDINGS: [[[START]]]\n# Key Findings\n\n## Architecture\n- Current system uses X framework\n- Database is Y with Z schema\n\n## Key Issues\n- Problem 1: description\n- Problem 2: description\n\n## Recommendations\n- Next steps for implementation\n[[[END]]]\n\n- Recommend "SWITCH_TO: planning" when ready\n\nFocus on understanding, not solving yet. Be thorough in your exploration.',
    "prompts/planning.md":
      '# PLANNING MODE\n\nYour job is to create a detailed implementation plan:\n\n- Review the exploration findings to understand the current state\n- Ask final clarifying questions before implementation  \n- Break down work into specific, concrete tasks with file changes\n- Create detailed-plan.md with step-by-step implementation tasks\n- Each task should specify exactly which files to modify and how\n- Recommend "SWITCH_TO: implementation" when plan is complete\n\nBe thorough - implementation should have no surprises.',
    "prompts/implementation.md":
      '# IMPLEMENTATION MODE\n\nYour job is to execute the implementation plan:\n\n- Follow the detailed-plan.md exactly as specified\n- Use UPDATE_FILE, INSERT_LINES, CREATE_NEW_FILE tools to make changes\n- Include descriptive change_description for all file operations  \n- Work through plan items systematically\n- If you hit unexpected issues: "SWITCH_TO: exploration"\n- Focus on execution, not replanning',
  };

  const filenames = Object.keys(initialFiles);
  for (let i = 0; i < filenames.length; i++) {
    const filename = filenames[i];
    const content = initialFiles[filename];
    if (!fs.existsSync(filename)) {
      await utils.ensureDir(require("path").dirname(filename));
      await require("fs").promises.writeFile(filename, content, "utf8");
      console.log("✓ Created " + filename);
    }
  }
}

function startWatching() {
  console.log("🔍 Starting AI workflow watcher...");
  console.log("📁 Codebase path: " + utils.CODEBASE_PATH);

  createInitialFiles()
    .then(function () {
      console.log("✓ Initial files ready");

      return utils.generateFileStructure();
    })
    .then(function () {
      console.log("✓ Project file structure initialized");
      console.log("💡 Edit conversation.md to get started!");
    })
    .catch(function (err) {
      console.error("⚠ Error during initialization:", err.message);
    });

  const filenames = Object.keys(watchedFiles);
  for (let i = 0; i < filenames.length; i++) {
    const filename = filenames[i];
    fs.watchFile(filename, { interval: 1000 }, async function (curr, prev) {
      if (curr.mtime > prev.mtime) {
        console.log("📝 " + filename + " changed");
        try {
          await watchedFiles[filename]();
        } catch (err) {
          console.error("Error handling " + filename + ":", err.message);
        }
      }
    });
  }

  setInterval(function () {
    // Keep process alive
  }, 60000);

  console.log("✅ Watcher started. Monitoring files for changes...");
  console.log("📁 Watching: " + Object.keys(watchedFiles).join(", "));
}

process.on("SIGINT", function () {
  console.log("\n🛑 Stopping watcher...");
  const filenames = Object.keys(watchedFiles);
  for (let i = 0; i < filenames.length; i++) {
    fs.unwatchFile(filenames[i]);
  }
  process.exit(0);
});

if (require.main === module) {
  startWatching();
}

module.exports = { startWatching: startWatching };
