// utils.js
const fs = require("fs").promises;
const path = require("path");

// Configuration
const CODEBASE_PATH = (function () {
  let path = process.env.CODEBASE_PATH;
  if (path) {
    return path.trim(); // Remove any trailing spaces
  }

  // Auto-detect: if we're in ai-work, use parent directory
  if (__dirname.endsWith("ai-work")) {
    return require("path").dirname(__dirname);
  }

  return "./test-project";
})();

// In-memory file structure cache
let fileStructure = null;

async function ensureDir(dirPath) {
  try {
    await fs.mkdir(dirPath, { recursive: true });
  } catch (err) {
    if (err.code !== "EEXIST") throw err;
  }
}

async function readFileIfExists(filePath) {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch (err) {
    if (err.code === "ENOENT") return "";
    throw err;
  }
}

function getActiveSelection(content) {
  const lines = content.split("\n");
  return lines
    .filter(function (line) {
      return line.startsWith("x ");
    })
    .map(function (line) {
      return line.slice(2).trim();
    });
}

function getActiveMode(content) {
  const lines = content.split("\n");
  const activeLine = lines.find(function (line) {
    return line.startsWith("x ");
  });
  return activeLine ? activeLine.slice(2).trim() : "exploration";
}

function parseBlocks(text) {
  const blocks = {};
  const regex = /^(\w+): \[\[\[START\]\]\]\n(.*?)\n\[\[\[END\]\]\]/gms;
  let match;

  while ((match = regex.exec(text)) !== null) {
    const key = match[1];
    const value = match[2];
    blocks[key] = value.trim();
  }

  return blocks;
}

function parseToolBlocks(text) {
  const toolMatch = text.match(
    /TOOLS: \[\[\[TOOLS\]\]\]\n(.*?)\n\[\[\[\/\]\]\]/s
  );
  if (!toolMatch) return [];

  const toolsContent = toolMatch[1];
  const tools = [];
  const toolRegex = /^(\w+): \[\[\[VALUE\]\]\]\n(.*?)\n\[\[\[\/\]\]\]/gms;
  let match;

  while ((match = toolRegex.exec(toolsContent)) !== null) {
    const toolName = match[1];
    const params = match[2];
    const paramLines = params.split("\n");
    const parsedParams = {};

    for (let i = 0; i < paramLines.length; i++) {
      const line = paramLines[i];
      const colonIndex = line.indexOf(":");
      if (colonIndex > -1) {
        const key = line.slice(0, colonIndex).trim();
        const value = line.slice(colonIndex + 1).trim();
        parsedParams[key] = value;
      }
    }

    tools.push({ name: toolName, params: parsedParams });
  }

  return tools;
}

function hasMessageEnd(text) {
  return text.includes("[[[MESSAGE_END]]]");
}

async function searchFilesByName(folder, regex) {
  const pattern = new RegExp(regex, "i");
  const results = [];

  async function searchDir(dir) {
    try {
      const entries = await fs.readdir(dir, { withFileTypes: true });

      for (let i = 0; i < entries.length; i++) {
        const entry = entries[i];
        const fullPath = path.join(dir, entry.name);

        if (entry.isDirectory()) {
          await searchDir(fullPath);
        } else if (pattern.test(entry.name)) {
          results.push(fullPath);
        }
      }
    } catch (err) {
      // Skip inaccessible directories
    }
  }

  await searchDir(folder);
  return results;
}

async function searchFilesByContent(folder, regex) {
  const pattern = new RegExp(regex, "gm");
  const results = [];

  async function searchDir(dir) {
    try {
      const entries = await fs.readdir(dir, { withFileTypes: true });

      for (let i = 0; i < entries.length; i++) {
        const entry = entries[i];
        const fullPath = path.join(dir, entry.name);

        if (entry.isDirectory()) {
          await searchDir(fullPath);
        } else {
          try {
            const content = await fs.readFile(fullPath, "utf8");
            const lines = content.split("\n");
            const matches = [];

            for (let j = 0; j < lines.length; j++) {
              const line = lines[j];
              const index = j;
              if (pattern.test(line)) {
                const start = Math.max(0, index - 10);
                const end = Math.min(lines.length - 1, index + 10);
                matches.push({ lineNum: index + 1, start: start, end: end });
              }
            }

            if (matches.length > 0) {
              const merged = [];
              for (let k = 0; k < matches.length; k++) {
                const match = matches[k];
                const existing = merged.find(function (m) {
                  return match.start <= m.end && match.end >= m.start;
                });
                if (existing) {
                  existing.start = Math.min(existing.start, match.start);
                  existing.end = Math.max(existing.end, match.end);
                } else {
                  merged.push(match);
                }
              }

              for (let l = 0; l < merged.length; l++) {
                const section = merged[l];
                const sectionLines = lines.slice(
                  section.start,
                  section.end + 1
                );
                const numberedLines = [];
                for (let m = 0; m < sectionLines.length; m++) {
                  const line = sectionLines[m];
                  const lineNum = section.start + m + 1;
                  const isMatch = pattern.test(line);
                  numberedLines.push(
                    lineNum + ": " + line + (isMatch ? " // <-- MATCH" : "")
                  );
                }

                results.push({
                  file: fullPath,
                  lines: section.start + 1 + "-" + (section.end + 1),
                  content: numberedLines.join("\n"),
                });
              }
            }
          } catch (err) {
            // Skip non-text files
          }
        }
      }
    } catch (err) {
      // Skip inaccessible directories
    }
  }

  await searchDir(folder);
  return results;
}

function calculateImportanceWeight(importance) {
  return Math.pow(2.5, importance - 1);
}

function compactDiscoveries(discoveries, maxCount) {
  if (maxCount === undefined) maxCount = 50;

  const lines = discoveries.split("\n").filter(function (line) {
    return line.trim();
  });
  if (lines.length <= maxCount) return discoveries;

  const parsed = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const match = line.match(/^\[([^\]]+)\] importance:(\d+) (.+)$/);
    if (match) {
      parsed.push({
        date: new Date(match[1]),
        importance: parseInt(match[2]),
        content: match[3],
        weight: calculateImportanceWeight(parseInt(match[2])),
      });
    }
  }

  parsed.sort(function (a, b) {
    if (a.importance === 10 && b.importance !== 10) return -1;
    if (b.importance === 10 && a.importance !== 10) return 1;

    const weightDiff = b.weight - a.weight;
    if (Math.abs(weightDiff) > 0.1) return weightDiff;

    return b.date - a.date;
  });

  const kept = parsed.slice(0, maxCount);
  const result = [];
  for (let i = 0; i < kept.length; i++) {
    const item = kept[i];
    result.push(
      "[" +
        item.date.toISOString().split("T")[0] +
        "] importance:" +
        item.importance +
        " " +
        item.content
    );
  }
  return result.join("\n");
}

async function generateFileStructure() {
  const structure = await buildDirectoryTree(CODEBASE_PATH, 0);
  fileStructure = structure;
  return structure;
}

async function buildDirectoryTree(dirPath, depth) {
  const indent = "  ".repeat(depth);
  let result = "";

  try {
    const entries = await fs.readdir(dirPath, { withFileTypes: true });

    const dirs = entries
      .filter(function (e) {
        return e.isDirectory();
      })
      .sort(function (a, b) {
        return a.name.localeCompare(b.name);
      });
    const files = entries
      .filter(function (e) {
        return e.isFile();
      })
      .sort(function (a, b) {
        return a.name.localeCompare(b.name);
      });

    for (let i = 0; i < dirs.length; i++) {
      const dir = dirs[i];
      if (dir.name.startsWith(".")) continue;

      result += indent + dir.name + "/\n";
      const subdirPath = path.join(dirPath, dir.name);
      result += await buildDirectoryTree(subdirPath, depth + 1);
    }

    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      if (file.name.startsWith(".")) continue;

      const filePath = path.join(dirPath, file.name);
      const lineCount = await getLineCount(filePath);
      result += indent + file.name + " (" + lineCount + " lines)\n";
    }
  } catch (err) {
    result += indent + "[Error reading directory: " + err.message + "]\n";
  }

  return result;
}

async function getLineCount(filePath) {
  try {
    const content = await fs.readFile(filePath, "utf8");
    return content.split("\n").length;
  } catch (err) {
    return 0;
  }
}

async function updateFileInStructure() {
  fileStructure = await generateFileStructure();
}

function getFileStructure() {
  return fileStructure || "";
}

function getCodebasePath(relativePath) {
  if (relativePath === undefined) relativePath = "";
  return path.join(CODEBASE_PATH, relativePath);
}

module.exports = {
  CODEBASE_PATH: CODEBASE_PATH,
  ensureDir: ensureDir,
  readFileIfExists: readFileIfExists,
  getActiveSelection: getActiveSelection,
  getActiveMode: getActiveMode,
  parseBlocks: parseBlocks,
  parseToolBlocks: parseToolBlocks,
  hasMessageEnd: hasMessageEnd,
  searchFilesByName: searchFilesByName,
  searchFilesByContent: searchFilesByContent,
  calculateImportanceWeight: calculateImportanceWeight,
  compactDiscoveries: compactDiscoveries,
  generateFileStructure: generateFileStructure,
  updateFileInStructure: updateFileInStructure,
  getFileStructure: getFileStructure,
  getCodebasePath: getCodebasePath,
};
