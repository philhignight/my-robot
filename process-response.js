// process-response.js
const fs = require("fs").promises;
const path = require("path");
const utils = require("./utils");

async function processResponse() {
  try {
    const responseText = await utils.readFileIfExists("ai-response.md");
    if (!responseText.trim()) return;

    const pendingChanges = await utils.readFileIfExists("pending-changes.json");
    if (pendingChanges) {
      await handlePendingUpdate(responseText);
      return;
    }

    if (!utils.hasMessageEnd(responseText)) {
      await handleIncompleteMessage(responseText);
      return;
    }

    const blocks = utils.parseBlocks(responseText);
    const tools = utils.parseToolBlocks(responseText);

    if (blocks.DISCOVERED) {
      await handleDiscovery(blocks.DISCOVERED);
    }

    const blockKeys = Object.keys(blocks);
    for (let i = 0; i < blockKeys.length; i++) {
      const key = blockKeys[i];
      if (key !== "DISCOVERED") {
        await handleBlock(key, blocks[key]);
      }
    }

    if (tools.length > 0) {
      await handleTools(tools);
      return;
    }

    await updateConversation(responseText);

    const buildPrompt = require("./message-to-prompt").buildPrompt;
    await buildPrompt();
    console.log("✓ Next prompt ready in generated-prompt.md");

    await fs.writeFile("ai-response.md", "", "utf8");
    console.log("✓ Processed AI response");
  } catch (err) {
    console.error("Error processing response:", err);
  }
}

async function handlePendingUpdate(responseText) {
  const pendingData = JSON.parse(
    await fs.readFile("pending-changes.json", "utf8")
  );

  if (responseText.includes("COMMIT")) {
    await fs.writeFile(
      pendingData.filePath,
      pendingData.modifiedContent,
      "utf8"
    );
    await fs.unlink("pending-changes.json");

    console.log("✓ Committed changes to " + pendingData.file);

    await utils.updateFileInStructure();
    await gitCommitAndPush(pendingData.file, pendingData.description);

    await updateConversation(
      "ASSISTANT: Changes committed to " +
        pendingData.file +
        " and pushed to git"
    );
    await fs.writeFile("ai-response.md", "", "utf8");

    const buildPrompt = require("./message-to-prompt").buildPrompt;
    await buildPrompt();
    console.log("✓ Next prompt ready in generated-prompt.md");
  } else {
    const tools = utils.parseToolBlocks(responseText);
    const fileOps = tools.filter(function (t) {
      return t.name === "UPDATE_FILE" || t.name === "INSERT_LINES";
    });

    if (
      fileOps.length > 0 &&
      fileOps[0].params.file_name === pendingData.file
    ) {
      console.log("Processing new file operations for same file...");
    } else {
      console.log("⚠ Invalid response to pending update");
    }
  }
}

async function handleIncompleteMessage(responseText) {
  const lastPart = responseText.slice(-50);
  const continuation =
    'Please continue from where you left off: "' + lastPart + '"';

  const conversation = await utils.readFileIfExists("conversation.md");
  const updated = conversation.replace(
    "=== WAITING FOR YOUR MESSAGE ===\n[write here when ready]",
    "=== AI NEEDS TO CONTINUE ===\n" + continuation
  );

  await fs.writeFile("conversation.md", updated, "utf8");
  console.log("⚠ Incomplete message detected, requesting continuation");

  const buildPrompt = require("./message-to-prompt").buildPrompt;
  await buildPrompt();
  console.log("✓ Continuation prompt ready in generated-prompt.md");
}

async function handleDiscovery(discoveryText) {
  const lines = discoveryText.split("\n");
  let importance = 5;
  let content = discoveryText;

  const importanceMatch = lines[0].match(/^importance:\s*(\d+)$/);
  if (importanceMatch) {
    importance = parseInt(importanceMatch[1]);
    content = lines.slice(1).join("\n").trim();
  }

  const timestamp = new Date().toISOString().split("T")[0];
  const discoveryEntry =
    "[" + timestamp + "] importance:" + importance + " " + content;

  const existingDiscoveries = await utils.readFileIfExists(
    "ai-managed/discoveries.md"
  );
  const updated = existingDiscoveries + "\n" + discoveryEntry;

  const compacted = utils.compactDiscoveries(updated);
  await fs.writeFile("ai-managed/discoveries.md", compacted, "utf8");

  console.log("✓ Added discovery (importance: " + importance + ")");
}

async function handleBlock(key, value) {
  switch (key) {
    case "SWITCH_TO":
      await updateMode(value);
      break;
    case "DETAILED_PLAN":
      await fs.writeFile("ai-managed/detailed-plan.md", value, "utf8");
      console.log("✓ Updated implementation plan");
      break;
    case "EXPLORATION_FINDINGS":
      await fs.writeFile("ai-managed/exploration-findings.md", value, "utf8");
      console.log("✓ Updated exploration findings");
      break;
    default:
      const filename = "ai-managed/" + key.toLowerCase() + ".md";
      await fs.writeFile(filename, value, "utf8");
      console.log("✓ Updated " + filename);
  }
}

async function updateMode(newMode) {
  const modeContent = await utils.readFileIfExists("mode.md");
  const lines = modeContent.split("\n");

  const updated = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    if (trimmed === newMode) {
      updated.push("x " + newMode);
    } else if (line.startsWith("x ")) {
      updated.push("  " + line.slice(2));
    } else {
      updated.push(line);
    }
  }

  await fs.writeFile("mode.md", updated.join("\n"), "utf8");
  console.log("✓ Switched to " + newMode + " mode");
}

async function handleTools(tools) {
  for (let i = 0; i < tools.length; i++) {
    const tool = tools[i];
    if (tool.name === "COMMIT") {
      continue;
    }

    const result = await executeTool(tool);

    if (tool.name === "UPDATE_FILE" || tool.name === "INSERT_LINES") {
      await requestFileConfirmation(tool, result);
      return;
    }

    await addToolResult(tool, result);
  }
}

async function executeTool(tool) {
  switch (tool.name) {
    case "READ_FILE":
      return await executeReadFile(tool.params);
    case "SEARCH_FILES_BY_NAME":
      return await executeSearchFilesByName(tool.params);
    case "SEARCH_FILES_BY_CONTENT":
      return await executeSearchFilesByContent(tool.params);
    case "CREATE_NEW_FILE":
      return await executeCreateFile(tool.params);
    case "UPDATE_FILE":
      return await executeUpdateFile(tool.params);
    case "INSERT_LINES":
      return await executeInsertLines(tool.params);
    case "DELETE_FILE":
      return await executeDeleteFile(tool.params);
    default:
      return "Unknown tool: " + tool.name;
  }
}

async function executeReadFile(params) {
  try {
    const filePath = utils.getCodebasePath(params.file_name);
    const content = await fs.readFile(filePath, "utf8");
    const lines = content.split("\n");
    const numberedLines = [];
    for (let i = 0; i < lines.length; i++) {
      numberedLines.push(i + 1 + ": " + lines[i]);
    }
    return "Content of " + params.file_name + ":\n" + numberedLines.join("\n");
  } catch (err) {
    return "Error reading " + params.file_name + ": " + err.message;
  }
}

async function executeSearchFilesByName(params) {
  try {
    const searchPath = utils.getCodebasePath(params.folder);
    const results = await utils.searchFilesByName(searchPath, params.regex);
    if (results.length === 0) {
      return (
        'No files found matching "' + params.regex + '" in ' + params.folder
      );
    }
    const relativePaths = [];
    for (let i = 0; i < results.length; i++) {
      relativePaths.push(path.relative(utils.CODEBASE_PATH, results[i]));
    }
    return "Files found:\n" + relativePaths.join("\n");
  } catch (err) {
    return "Error searching files: " + err.message;
  }
}

async function executeSearchFilesByContent(params) {
  try {
    const searchPath = utils.getCodebasePath(params.folder);
    const results = await utils.searchFilesByContent(searchPath, params.regex);
    if (results.length === 0) {
      return (
        'No content found matching "' + params.regex + '" in ' + params.folder
      );
    }

    let output = 'Content matches for "' + params.regex + '":\n\n';
    for (let i = 0; i < results.length; i++) {
      const result = results[i];
      const relativePath = path.relative(utils.CODEBASE_PATH, result.file);
      output +=
        relativePath +
        " (lines " +
        result.lines +
        "):\n" +
        result.content +
        "\n\n";
    }

    return output;
  } catch (err) {
    return "Error searching content: " + err.message;
  }
}

async function executeCreateFile(params) {
  try {
    const filePath = utils.getCodebasePath(params.path);
    await utils.ensureDir(path.dirname(filePath));
    await fs.writeFile(filePath, params.contents, "utf8");

    await utils.updateFileInStructure();

    return "✓ Created " + params.path;
  } catch (err) {
    return "Error creating " + params.path + ": " + err.message;
  }
}

async function executeUpdateFile(params) {
  try {
    const filePath = utils.getCodebasePath(params.file_name);
    const content = await fs.readFile(filePath, "utf8");
    const lines = content.split("\n");

    const startIndex = parseInt(params.start_line) - 1;
    const endIndex = parseInt(params.end_line) - 1;

    if (startIndex < 0 || endIndex >= lines.length || startIndex > endIndex) {
      return (
        "Error: Invalid line range " + params.start_line + "-" + params.end_line
      );
    }

    const before = lines.slice(0, startIndex);
    const after = lines.slice(endIndex + 1);
    const newContent = params.contents.split("\n");

    const updatedLines = before.concat(newContent).concat(after);
    const updatedContent = updatedLines.join("\n");

    return {
      originalContent: content,
      modifiedContent: updatedContent,
      description: params.change_description || "File update",
      filePath: filePath,
    };
  } catch (err) {
    return "Error updating " + params.file_name + ": " + err.message;
  }
}

async function executeInsertLines(params) {
  try {
    const filePath = utils.getCodebasePath(params.file_name);
    const content = await fs.readFile(filePath, "utf8");
    const lines = content.split("\n");

    const insertIndex = parseInt(params.line_number) - 1;
    if (insertIndex < 0 || insertIndex > lines.length) {
      return "Error: Invalid line number " + params.line_number;
    }

    const newContent = params.contents.split("\n");
    const updatedLines = lines
      .slice(0, insertIndex)
      .concat(newContent)
      .concat(lines.slice(insertIndex));
    const updatedContent = updatedLines.join("\n");

    return {
      originalContent: content,
      modifiedContent: updatedContent,
      description: params.change_description || "Line insertion",
      filePath: filePath,
    };
  } catch (err) {
    return "Error inserting into " + params.file_name + ": " + err.message;
  }
}

async function executeDeleteFile(params) {
  try {
    const filePath = utils.getCodebasePath(params.file_name);
    await fs.unlink(filePath);

    await utils.updateFileInStructure();

    return "✓ Deleted " + params.file_name;
  } catch (err) {
    return "Error deleting " + params.file_name + ": " + err.message;
  }
}

async function requestFileConfirmation(tool, result) {
  if (typeof result === "string") {
    await addToolResult(tool, result);
    return;
  }

  const originalContent = result.originalContent;
  const modifiedContent = result.modifiedContent;
  const description = result.description;
  const filePath = result.filePath;
  const originalLines = originalContent.split("\n");
  const modifiedLines = modifiedContent.split("\n");

  let changeStart = 0;
  for (
    let i = 0;
    i < Math.min(originalLines.length, modifiedLines.length);
    i++
  ) {
    if (originalLines[i] !== modifiedLines[i]) {
      changeStart = i;
      break;
    }
  }

  const previewStart = Math.max(0, changeStart - 20);
  const previewEnd = Math.min(modifiedLines.length - 1, changeStart + 40);

  const originalPreview = [];
  const originalSlice = originalLines.slice(previewStart, changeStart + 1);
  for (let i = 0; i < originalSlice.length; i++) {
    originalPreview.push(previewStart + i + 1 + ": " + originalSlice[i]);
  }

  const modifiedPreview = [];
  const modifiedSlice = modifiedLines.slice(previewStart, previewEnd + 1);
  for (let i = 0; i < modifiedSlice.length; i++) {
    modifiedPreview.push(previewStart + i + 1 + ": " + modifiedSlice[i]);
  }

  const confirmation =
    "PENDING UPDATE for " +
    tool.params.file_name +
    "\nDESCRIPTION: " +
    description +
    "\n\nORIGINAL CODE (lines " +
    (previewStart + 1) +
    "-" +
    (changeStart + 1) +
    "):\n" +
    originalPreview.join("\n") +
    "\n\nNEW CODE (lines " +
    (previewStart + 1) +
    "-" +
    (previewEnd + 1) +
    "):\n" +
    modifiedPreview.join("\n") +
    "\n\nReply with COMMIT to apply, or send new UPDATE_FILE/INSERT_LINES for this file.";

  const pendingData = {
    file: tool.params.file_name,
    filePath: filePath,
    originalContent: originalContent,
    modifiedContent: modifiedContent,
    description: description,
    changes: [tool],
  };

  await fs.writeFile(
    "pending-changes.json",
    JSON.stringify(pendingData, null, 2),
    "utf8"
  );

  await updateConversation("ASSISTANT: " + confirmation);
  await fs.writeFile("ai-response.md", "", "utf8");

  const buildPrompt = require("./message-to-prompt").buildPrompt;
  await buildPrompt();
  console.log("✓ Confirmation prompt ready in generated-prompt.md");

  console.log(
    "⚠ File operation pending confirmation: " + tool.params.file_name
  );
}

async function addToolResult(tool, result) {
  const resultText =
    typeof result === "string" ? result : JSON.stringify(result);

  const toolSummary =
    "ASSISTANT: Tool " + tool.name + " executed:\n" + resultText;
  await updateConversation(toolSummary);

  const buildPrompt = require("./message-to-prompt").buildPrompt;
  await buildPrompt();
  console.log("✓ Next prompt ready in generated-prompt.md");
}

async function updateConversation(newMessage) {
  const conversation = await utils.readFileIfExists("conversation.md");

  const lines = conversation.split("\n");
  const historyIndex = lines.findIndex(function (line) {
    return line.includes("=== CONVERSATION HISTORY ===");
  });

  if (historyIndex === -1) {
    const updated =
      "=== WAITING FOR YOUR MESSAGE ===\n[write here when ready]\n\n=== CONVERSATION HISTORY ===\n" +
      newMessage;
    await fs.writeFile("conversation.md", updated, "utf8");
  } else {
    const before = lines.slice(0, historyIndex + 1);
    const after = lines.slice(historyIndex + 1);

    const updated = [
      "=== WAITING FOR YOUR MESSAGE ===",
      "[write here when ready]",
      "",
    ]
      .concat(before.slice(historyIndex))
      .concat([newMessage])
      .concat(after);

    await fs.writeFile("conversation.md", updated.join("\n"), "utf8");
  }
}

async function gitCommitAndPush(fileName, description) {
  const exec = require("child_process").exec;
  const promisify = require("util").promisify;
  const execAsync = promisify(exec);

  try {
    await execAsync('git add "' + fileName + '"', { cwd: utils.CODEBASE_PATH });
    console.log("✓ Git added: " + fileName);

    const commitMessage = "AI: " + description;
    await execAsync('git commit -m "' + commitMessage + '"', {
      cwd: utils.CODEBASE_PATH,
    });
    console.log("✓ Git commit: " + commitMessage);

    await execAsync("git push", { cwd: utils.CODEBASE_PATH });
    console.log("✓ Git push completed");
  } catch (error) {
    console.error("⚠ Git operation failed:", error.message);
  }
}

module.exports = { processResponse: processResponse };
