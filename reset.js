// reset.js
const fs = require("fs").promises;
const path = require("path");

async function resetConversationFiles() {
  console.log("🔄 Resetting conversation files...");

  try {
    // Reset conversation.md to initial state
    const initialConversation =
      "=== WAITING FOR YOUR MESSAGE ===\n[write here when ready]\n\n=== CONVERSATION HISTORY ===";
    await fs.writeFile("conversation.md", initialConversation, "utf8");
    console.log("✓ Reset conversation.md");

    // Clear ai-response.md
    await fs.writeFile("ai-response.md", "", "utf8");
    console.log("✓ Cleared ai-response.md");

    // Clear generated-prompt.md
    await fs.writeFile("generated-prompt.md", "", "utf8");
    console.log("✓ Cleared generated-prompt.md");

    // Clear ai-managed folder contents but keep the folder
    try {
      const aiManagedPath = "ai-managed";
      const files = await fs.readdir(aiManagedPath);

      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        const filePath = path.join(aiManagedPath, file);
        const stat = await fs.lstat(filePath);

        if (stat.isFile()) {
          await fs.unlink(filePath);
          console.log("✓ Deleted " + filePath);
        }
      }
    } catch (err) {
      if (err.code !== "ENOENT") {
        console.log("⚠ Could not clear ai-managed folder:", err.message);
      }
    }

    // Remove pending changes if any
    try {
      await fs.unlink("pending-changes.json");
      console.log("✓ Cleared pending changes");
    } catch (err) {
      // File doesn't exist, which is fine
    }

    console.log("");
    console.log("✅ Reset complete! Conversation files cleared.");
    console.log("📁 Preserved: prompts/, mode.md, goals.md");
    console.log('💡 Run "npm run ai" to start fresh conversation');
  } catch (err) {
    console.error("❌ Error during reset:", err.message);
    process.exit(1);
  }
}

// Confirmation prompt
async function confirmReset() {
  const readline = require("readline");
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise(function (resolve) {
    rl.question(
      "This will clear all conversation history and AI discoveries. Continue? (y/N): ",
      function (answer) {
        rl.close();
        resolve(answer.toLowerCase() === "y" || answer.toLowerCase() === "yes");
      }
    );
  });
}

async function main() {
  console.log("🔄 AI Workflow Reset Tool");
  console.log("This will reset:");
  console.log("  - conversation.md (back to initial state)");
  console.log("  - ai-response.md (cleared)");
  console.log("  - generated-prompt.md (cleared)");
  console.log("  - ai-managed/ folder (all discoveries, findings, plans)");
  console.log("  - pending-changes.json (if exists)");
  console.log("");
  console.log("This will preserve:");
  console.log("  - prompts/ folder");
  console.log("  - mode.md");
  console.log("  - goals.md");
  console.log("");

  const confirmed = await confirmReset();

  if (confirmed) {
    await resetConversationFiles();
  } else {
    console.log("Reset cancelled.");
  }
}

if (require.main === module) {
  main();
}
