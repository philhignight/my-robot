// utils.js

const fs = require('fs').promises;
const path = require('path');

// Configuration
const CODEBASE_PATH = (function() {
  let path = process.env.CODEBASE_PATH;
  if (path) {
    return path.trim(); // Remove any trailing spaces
  }
  
  // Auto-detect: if we're in ai-work, use parent directory
  if (__dirname.endsWith('ai-work')) {
    return require('path').dirname(__dirname);
  }
  
  return './test-project';
})();

async function ensureDir(dirPath) {
  try {
    await fs.mkdir(dirPath, { recursive: true });
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;
  }
}

async function readFileIfExists(filePath) {
  try {
    return await fs.readFile(filePath, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return '';
    throw err;
  }
}

function getActiveSelection(content) {
  const lines = content.split('\n');
  return lines
    .filter(function(line) { return line.startsWith('x '); })
    .map(function(line) { return line.slice(2).trim(); });
}

function getActiveMode(content) {
  const lines = content.split('\n');
  const activeLine = lines.find(function(line) { return line.startsWith('x '); });
  return activeLine ? activeLine.slice(2).trim() : 'exploration';
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
  const tools = [];
  
  // Remove the box wrapper if present
  const boxMatch = text.match(/┌─ ASSISTANT[^─]*─+\s*\n([\s\S]*?)\n\s*└─+/);
  let content = text;
  
  if (boxMatch) {
    // Extract content and remove box borders from each line
    const boxContent = boxMatch[1];
    const lines = boxContent.split('\n');
    const cleanedLines = [];
    
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      // Remove the leading "│ " 
      if (line.startsWith('│')) {
        const content = line.substring(1).trimStart();
        cleanedLines.push(content);
      }
    }
    
    content = cleanedLines.join('\n');
  }
  
  // Match tool patterns: [TOOLNAME] args on one line, then content until next tool or END tag
  const lines = content.split('\n');
  let i = 0;
  
  while (i < lines.length) {
    const line = lines[i].trim();
    
    // Check for tool start pattern
    const toolMatch = line.match(/^\[([A-Z_]+)\](?:\s+(.*))?$/);
    if (toolMatch) {
      const toolName = toolMatch[1];
      const args = toolMatch[2] || '';
      
      // Find where this tool ends (next tool, END tag, or end of content)
      let endIndex = lines.length;
      let hasEndTag = false;
      
      for (let j = i + 1; j < lines.length; j++) {
        const checkLine = lines[j].trim();
        // Check for END tag
        if (checkLine === '[END_' + toolName + ']') {
          endIndex = j;
          hasEndTag = true;
          break;
        }
        // Check for next tool
        if (checkLine.match(/^\[([A-Z_]+)\]/)) {
          endIndex = j;
          break;
        }
      }
      
      // Extract content lines
      const contentLines = lines.slice(i + 1, endIndex);
      const content = contentLines.join('\n').trim();
      
      // Parse based on tool type
      const params = parseToolParams(toolName, args, content);
      
      tools.push({
        name: toolName,
        params: params,
        startIndex: 0, // We'll update this if needed
        endIndex: 0
      });
      
      // Move past this tool (and END tag if present)
      i = hasEndTag ? endIndex + 1 : endIndex;
    } else {
      i++;
    }
  }
  
  return tools;
}

function parseToolParams(toolName, args, content) {
  const params = {};
  
  // Helper function to parse arguments with quoted string support
  function parseArgs(argString) {
    const args = [];
    let current = '';
    let inQuotes = false;
    let escapeNext = false;
    
    for (let i = 0; i < argString.length; i++) {
      const char = argString[i];
      
      if (escapeNext) {
        current += char;
        escapeNext = false;
        continue;
      }
      
      if (char === '\\') {
        escapeNext = true;
        continue;
      }
      
      if (char === '"') {
        inQuotes = !inQuotes;
        continue;
      }
      
      if (char === ' ' && !inQuotes) {
        if (current) {
          args.push(current);
          current = '';
        }
      } else {
        current += char;
      }
    }
    
    if (current) {
      args.push(current);
    }
    
    return args;
  }
  
  switch (toolName) {
    case 'READ_CODE':
    case 'READ_REQUIREMENTS':
      params.file_name = args || '.';  // Default to current directory
      params.path = args || '.';  // Support both for compatibility
      params.explanation = content;
      break;
      
    case 'SEARCH_NAME':
      const nameArgs = parseArgs(args);
      params.regex = nameArgs[0];
      params.folder = nameArgs[1] || '.';
      params.explanation = content;
      break;
      
    case 'SEARCH_CONTENT':
      const contentArgs = parseArgs(args);
      params.regex = contentArgs[0];
      params.folder = contentArgs[1] || '.';
      params.explanation = content;
      break;
      
    case 'MESSAGE':
      // For MESSAGE, all content is the message
      params.content = content;
      break;
      
    case 'CREATE':
      params.path = args;
      // Check if first line is a description comment
      const createLines = content.split('\n');
      if (createLines[0] && createLines[0].startsWith('# ')) {
        params.description = createLines[0].slice(2);
        params.contents = createLines.slice(1).join('\n');
      } else {
        params.contents = content;
      }
      break;
      
    case 'UPDATE':
      const updateArgs = args.split(/\s+/);
      params.file_name = updateArgs[0];
      params.start_line = updateArgs[1];
      params.end_line = updateArgs[2];
      // First line should be # description
      const updateLines = content.split('\n');
      if (updateLines[0] && updateLines[0].startsWith('# ')) {
        params.change_description = updateLines[0].slice(2);
        params.contents = updateLines.slice(1).join('\n');
      } else {
        // Fallback if no # description
        params.change_description = 'File update';
        params.contents = content;
      }
      break;
      
    case 'INSERT':
      const insertArgs = args.split(/\s+/);
      params.file_name = insertArgs[0];
      params.line_number = insertArgs[1];
      // First line should be # description
      const insertLines = content.split('\n');
      if (insertLines[0] && insertLines[0].startsWith('# ')) {
        params.change_description = insertLines[0].slice(2);
        params.contents = insertLines.slice(1).join('\n');
      } else {
        // Fallback if no # description
        params.change_description = 'Line insertion';
        params.contents = content;
      }
      break;
      
    case 'DELETE':
      params.file_name = args;
      params.explanation = content;
      break;
      
    case 'DISCOVERED':
      params.importance = parseInt(args) || 5;
      params.content = content;
      break;
      
    case 'SWITCH_TO':
      params.mode = args;
      break;
      
    case 'SWITCH_TO_EXPLORATION':
      params.mode = 'exploration';
      break;
      
    case 'SWITCH_TO_PLANNING':
      params.mode = 'planning';
      break;
      
    case 'SWITCH_TO_IMPLEMENTATION':
      params.mode = 'implementation';
      break;
      
    case 'EXPLORATION_FINDINGS':
      params.name = args;
      params.content = content;
      break;
      
    case 'DETAILED_PLAN':
      params.name = args;
      params.content = content;
      break;
      
    case 'COMMIT':
      // No params needed
      break;
  }
  
  return params;
}

function classifyTools(tools) {
  const informationTools = ['READ_CODE', 'READ_REQUIREMENTS', 'SEARCH_NAME', 'SEARCH_CONTENT'];
  const responseTools = ['MESSAGE', 'DISCOVERED', 'EXPLORATION_FINDINGS', 'DETAILED_PLAN', 
                        'CREATE', 'UPDATE', 'INSERT', 'DELETE',
                        'SWITCH_TO', 'SWITCH_TO_EXPLORATION', 'SWITCH_TO_PLANNING', 
                        'SWITCH_TO_IMPLEMENTATION', 'COMMIT'];
  
  const hasInfoTools = tools.some(t => informationTools.includes(t.name));
  const hasResponseTools = tools.some(t => responseTools.includes(t.name));
  
  if (hasInfoTools && hasResponseTools) {
    return { 
      type: 'mixed', 
      error: 'Cannot mix READ tools with WRITE tools in the same response'
    };
  }
  
  if (hasInfoTools) return { type: 'read' };
  if (hasResponseTools) return { type: 'write' };
  return { type: 'empty' };
}

function validateResponseType(text, tools) {
  const classification = classifyTools(tools);
  
  // Check if message has the required box format
  const hasBox = text.includes('┌─ ASSISTANT') && text.includes('└─');
  if (!hasBox) {
    return {
      valid: false,
      error: 'Response must be wrapped in ASCII box starting with ┌─ ASSISTANT ─'
    };
  }
  
  switch (classification.type) {
    case 'mixed':
      return { 
        valid: false, 
        error: classification.error 
      };
      
    case 'read':
      return { valid: true, type: 'read' };
      
    case 'write':
      return { valid: true, type: 'write' };
      
    case 'empty':
      return { 
        valid: false, 
        error: 'Response must contain at least one tool' 
      };
  }
}

function replaceToolsWithIndicators(text, tools) {
  // For assistant messages, preserve the original box format as-is
  return text.trim();
}

function hasBoxClosure(text) {
  return /└─+/.test(text);
}

function validateMessageFormat(text) {
  if (!text.includes('┌─ ASSISTANT') || !hasBoxClosure(text)) {
    throw new Error('Invalid format: Response must be wrapped in complete ASCII box');
  }
  
  // Check that lines start with "│ " (but don't require right border)
  const lines = text.split('\n');
  let inBox = false;
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.includes('┌─ ASSISTANT')) {
      inBox = true;
    } else if (line.includes('└─')) {
      inBox = false;
    } else if (inBox && line.trim() && !line.startsWith('│')) {
      throw new Error('Invalid format: Content lines must start with "│ "');
    }
  }
  
  return true;
}

async function searchFilesByName(folder, regex) {
  const pattern = new RegExp(regex, 'i');
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
  const pattern = new RegExp(regex, 'gm');
  const results = [];
  
  // Binary extensions to skip
  const binaryExtensions = [
    '.jar', '.ear', '.war', '.zip', '.tar', '.gz', '.7z', '.rar',
    '.exe', '.dll', '.so', '.dylib', '.lib', '.a', '.o',
    '.class', '.pyc', '.pyo', '.beam', '.elc',
    '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx',
    '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.ico', '.svg', '.webp',
    '.mp3', '.mp4', '.avi', '.mov', '.wmv', '.flv', '.webm',
    '.ttf', '.otf', '.woff', '.woff2', '.eot',
    '.db', '.sqlite', '.sqlite3',
    '.min.js', '.min.css'
  ];
  
  async function searchDir(dir) {
    try {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      
      for (let i = 0; i < entries.length; i++) {
        const entry = entries[i];
        const fullPath = path.join(dir, entry.name);
        
        if (entry.isDirectory()) {
          await searchDir(fullPath);
        } else {
          // Skip binary files
          const ext = path.extname(entry.name).toLowerCase();
          if (binaryExtensions.includes(ext)) {
            continue;
          }
          
          try {
            const content = await fs.readFile(fullPath, 'utf8');
            // Normalize line endings before processing
            const normalizedContent = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
            const lines = normalizedContent.split('\n');
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
                const existing = merged.find(function(m) {
                  return (match.start <= m.end && match.end >= m.start);
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
                const sectionLines = lines.slice(section.start, section.end + 1);
                const numberedLines = [];
                for (let m = 0; m < sectionLines.length; m++) {
                  const line = sectionLines[m];
                  const lineNum = section.start + m + 1;
                  const isMatch = pattern.test(line);
                  numberedLines.push(lineNum + ': ' + line + (isMatch ? ' // <-- MATCH' : ''));
                }
                
                results.push({
                  file: fullPath,
                  lines: (section.start + 1) + '-' + (section.end + 1),
                  content: numberedLines.join('\n')
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
  if (maxCount === undefined) maxCount = 200;
  
  const lines = discoveries.split('\n').filter(function(line) { return line.trim(); });
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
        weight: calculateImportanceWeight(parseInt(match[2]))
      });
    }
  }
  
  parsed.sort(function(a, b) {
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
    result.push('[' + item.date.toISOString().split('T')[0] + '] importance:' + item.importance + ' ' + item.content);
  }
  return result.join('\n');
}

function compactConversation(conversationHistory, maxLength) {
  if (maxLength === undefined) maxLength = 250000; // Default max length for conversation
  
  if (conversationHistory.length <= maxLength) {
    return conversationHistory;
  }
  
  const lines = conversationHistory.split('\n').filter(function(line) { return line.trim(); });
  
  // Find conversation exchanges (> for user, ┌─ ASSISTANT for assistant)
  const exchanges = [];
  let currentExchange = { user: '', assistant: '', other: [] };
  let inAssistantBox = false;
  let assistantLines = [];
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    
    if (line.startsWith('> ')) {
      // Start new exchange
      if (currentExchange.user || currentExchange.assistant.length > 0) {
        exchanges.push(currentExchange);
      }
      currentExchange = { user: line, assistant: '', other: [] };
    } else if (line.includes('┌─ ASSISTANT')) {
      inAssistantBox = true;
      assistantLines = [line];
    } else if (inAssistantBox) {
      assistantLines.push(line);
      if (line.includes('└─')) {
        inAssistantBox = false;
        currentExchange.assistant = assistantLines.join('\n');
        assistantLines = [];
      }
    } else if (line.startsWith('SYSTEM:')) {
      currentExchange.other.push(line);
    }
  }
  
  // Add the last exchange
  if (currentExchange.user || currentExchange.assistant.length > 0) {
    exchanges.push(currentExchange);
  }
  
  if (exchanges.length <= 10) {
    return conversationHistory; // Don't compact if very short
  }
  
  // Keep recent exchanges (last 10) and summarize older ones
  const recentExchanges = exchanges.slice(-10);
  const oldExchanges = exchanges.slice(0, -10);
  
  // Create summary of old exchanges
  const importantPoints = [];
  const decisions = [];
  const discoveries = [];
  
  for (let i = 0; i < oldExchanges.length; i++) {
    const exchange = oldExchanges[i];
    const userText = exchange.user;
    const assistantText = exchange.assistant;
    
    // Extract important information
    if (userText.includes('implement') || userText.includes('create') || userText.includes('build')) {
      decisions.push('User requested: ' + userText.replace('> ', ''));
    }
    
    if (assistantText.includes('[SWITCH_TO]')) {
      const modeMatch = assistantText.match(/\[SWITCH_TO\]\s+(\w+)/);
      if (modeMatch) {
        decisions.push('Mode change to ' + modeMatch[1]);
      }
    }
    
    // Look for discoveries in assistant text
    if (assistantText.includes('[DISCOVERED]')) {
      const discoveryMatch = assistantText.match(/\[DISCOVERED\]\s+(\d+)\s+([^\n]+)/);
      if (discoveryMatch) {
        discoveries.push('Discovery (importance ' + discoveryMatch[1] + '): ' + discoveryMatch[2]);
      }
    }
    
    // Look for key decisions in tool results
    for (let j = 0; j < exchange.other.length; j++) {
      const otherLine = exchange.other[j];
      if (otherLine.includes('Discovery') && otherLine.includes('importance')) {
        discoveries.push(otherLine);
      }
      if (otherLine.includes('committed') || otherLine.includes('created')) {
        decisions.push(otherLine);
      }
    }
  }
  
  // Build compact summary
  let summary = '=== CONVERSATION SUMMARY ===\n';
  
  if (decisions.length > 0) {
    summary += 'KEY DECISIONS:\n';
    for (let i = 0; i < Math.min(decisions.length, 15); i++) {
      summary += '- ' + decisions[i] + '\n';
    }
    summary += '\n';
  }
  
  if (discoveries.length > 0) {
    summary += 'KEY DISCOVERIES:\n';
    for (let i = 0; i < Math.min(discoveries.length, 10); i++) {
      summary += '- ' + discoveries[i] + '\n';
    }
    summary += '\n';
  }
  
  summary += '=== RECENT CONVERSATION ===\n';
  
  // Add recent exchanges
  for (let i = 0; i < recentExchanges.length; i++) {
    const exchange = recentExchanges[i];
    if (exchange.user) summary += exchange.user + '\n';
    if (exchange.assistant) summary += exchange.assistant + '\n';
    for (let j = 0; j < exchange.other.length; j++) {
      summary += exchange.other[j] + '\n';
    }
  }
  
  return summary;
}

function calculatePromptLength(basePrompt, modePrompt, goals, context, conversationHistory) {
  return (basePrompt + modePrompt + goals + context + conversationHistory).length;
}

async function getLineCount(filePath) {
  try {
    const content = await fs.readFile(filePath, 'utf8');
    // Normalize line endings before counting
    const normalizedContent = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    return normalizedContent.split('\n').length;
  } catch (err) {
    return 0;
  }
}

async function countFilesInDir(dirPath) {
  let count = 0;
  
  async function countDir(dir) {
    try {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      
      for (let i = 0; i < entries.length; i++) {
        const entry = entries[i];
        if (entry.name.startsWith('.')) continue;
        
        if (entry.isFile()) {
          count++;
        } else if (entry.isDirectory()) {
          await countDir(path.join(dir, entry.name));
        }
      }
    } catch (err) {
      // Skip inaccessible directories
    }
  }
  
  await countDir(dirPath);
  return count;
}

function getCodebasePath(relativePath) {
  if (relativePath === undefined) relativePath = '';
  return path.join(CODEBASE_PATH, relativePath);
}

function wrapText(text, maxWidth) {
  // No wrapping - just return the text as is
  return [text];
}

function formatInBox(content, width) {
  const lines = content.split('\n');
  
  // Build box
  let result = '┌─ ASSISTANT ─────────────────────────────────────────────────────────\n';
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    result += '│ ' + line + '\n';
  }
  
  result += '└─────────────────────────────────────────────────────────────────────';
  return result;
}

function wrapSystemMessage(content) {
  // No wrapping - just return content as is
  return content;
}

function fixBoxPadding(text) {
  const lines = text.split('\n');
  const fixedLines = [];
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    
    if (line.includes('┌─ ASSISTANT')) {
      // Top border - remove corner if present
      const fixedLine = line.replace(/┐\s*$/, '');
      fixedLines.push(fixedLine);
    } else if (line.includes('└─')) {
      // Bottom border - remove corner if present
      const fixedLine = line.replace(/┘\s*$/, '');
      fixedLines.push(fixedLine);
    } else if (line.startsWith('│')) {
      // Content line - just ensure it starts with "│ "
      const content = line.substring(1).trimStart();
      fixedLines.push('│ ' + content);
    } else {
      fixedLines.push(line);
    }
  }
  
  return fixedLines.join('\n');
}

// New functions for temporary block support
function findTemporaryBlock(conversation, startFrom = 0) {
  // Look for temporary content blocks in the conversation
  const tempStartPattern = /╔═ TEMPORARY: (.+?) ═+╗/;
  const lines = conversation.split('\n');
  
  for (let i = startFrom; i < lines.length; i++) {
    const match = lines[i].match(tempStartPattern);
    if (match) {
      // Found a temporary block, extract its details
      const title = match[1];
      let startLine = i;
      let endLine = -1;
      
      // Find the end of the block
      for (let j = i + 1; j < lines.length; j++) {
        if (lines[j].match(/╚═+╝/)) {
          endLine = j;
          break;
        }
      }
      
      if (endLine !== -1) {
        // Extract content lines (skip the box borders)
        const contentLines = [];
        for (let k = startLine + 1; k < endLine; k++) {
          const line = lines[k];
          // Remove the "║ " prefix
          if (line.startsWith('║ ')) {
            contentLines.push(line.substring(2));
          }
        }
        
        return {
          found: true,
          title: title,
          content: contentLines.join('\n'),
          startLine: startLine,
          endLine: endLine
        };
      }
    }
  }
  
  return { found: false };
}

function formatTemporaryBlock(title, content, blockNumber = null, totalBlocks = null) {
  const boxWidth = 70;
  // Normalize line endings before processing
  const normalizedContent = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const lines = normalizedContent.split('\n');
  let result = '';
  
  // Format the header with optional numbering
  let headerText = ' TEMPORARY: ' + title;
  if (blockNumber && totalBlocks) {
    headerText += ' (' + blockNumber + ' of ' + totalBlocks + ')';
  }
  headerText += ' ';
  
  if (headerText.length > boxWidth - 2) {
    headerText = headerText.substring(0, boxWidth - 5) + '... ';
  }
  const headerPadding = boxWidth - headerText.length - 2;
  result += '╔═' + headerText + '═'.repeat(Math.max(0, headerPadding)) + '═╗\n';
  
  // Add content lines WITHOUT padding or right border
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    result += '║ ' + line + '\n';
  }
  
  // Close the box
  result += '╚' + '═'.repeat(boxWidth - 2) + '╝';
  
  return result;
}

function removeTemporaryBlock(conversation, startLine, endLine) {
  const lines = conversation.split('\n');
  const before = lines.slice(0, startLine);
  const after = lines.slice(endLine + 1);
  
  return before.concat(after).join('\n');
}

module.exports = {
  CODEBASE_PATH: CODEBASE_PATH,
  ensureDir: ensureDir,
  readFileIfExists: readFileIfExists,
  getActiveSelection: getActiveSelection,
  getActiveMode: getActiveMode,
  parseToolBlocks: parseToolBlocks,
  classifyTools: classifyTools,
  validateResponseType: validateResponseType,
  replaceToolsWithIndicators: replaceToolsWithIndicators,
  validateMessageFormat: validateMessageFormat,
  hasBoxClosure: hasBoxClosure,
  searchFilesByName: searchFilesByName,
  searchFilesByContent: searchFilesByContent,
  calculateImportanceWeight: calculateImportanceWeight,
  compactDiscoveries: compactDiscoveries,
  compactConversation: compactConversation,
  calculatePromptLength: calculatePromptLength,
  getLineCount: getLineCount,
  countFilesInDir: countFilesInDir,
  getCodebasePath: getCodebasePath,
  wrapText: wrapText,
  formatInBox: formatInBox,
  wrapSystemMessage: wrapSystemMessage,
  fixBoxPadding: fixBoxPadding,
  findTemporaryBlock: findTemporaryBlock,
  formatTemporaryBlock: formatTemporaryBlock,
  removeTemporaryBlock: removeTemporaryBlock
};

// ==========================================

// process-response.js

const fs = require('fs').promises;
const path = require('path');
const utils = require('./utils');

async function processResponse() {
  try {
    const responseText = await utils.readFileIfExists('ai-response.md');
    if (!responseText.trim()) return;
    
    // Check for temporary blocks that need resolution
    const conversation = await utils.readFileIfExists('conversation.md');
    const tempBlock = utils.findTemporaryBlock(conversation);
    
    if (tempBlock.found) {
      // We're in extraction mode
      await handleExtractionResponse(responseText, tempBlock);
      return;
    }
    
    const pendingChanges = await utils.readFileIfExists('pending-changes.json');
    if (pendingChanges) {
      await handlePendingUpdate(responseText);
      return;
    }
    
    // Basic format validation
    try {
      utils.validateMessageFormat(responseText);
    } catch (formatError) {
      if (formatError.message.includes('complete ASCII box') && !responseText.includes('┌─ ASSISTANT')) {
        // Missing box entirely - don't add to conversation
        console.error('❌ Format Error:', formatError.message);
        await handleFormatError(formatError.message);
        return;
      } else if (formatError.message.includes('complete ASCII box')) {
        // Has box start but missing closure - incomplete message
        console.log('⚠ Incomplete message detected, requesting continuation');
        await handleIncompleteMessage(responseText);
        return;
      }
      console.error('❌ Format Error:', formatError.message);
      await handleFormatError(formatError.message);
      return;
    }
    
    // Parse tools
    const tools = utils.parseToolBlocks(responseText);
    
    // Strict response type validation
    const typeValidation = utils.validateResponseType(responseText, tools);
    if (!typeValidation.valid) {
      console.error('❌ Response Type Error:', typeValidation.error);
      await handleResponseTypeError(typeValidation.error, responseText);
      return;
    }
    
    console.log('✓ Processing ' + typeValidation.type + ' response');
    
    // Handle based on response type
    if (typeValidation.type === 'read') {
      await handleReadResponse(responseText, tools);
    } else {
      await handleWriteResponse(responseText, tools);
    }
    
  } catch (err) {
    console.error('Error processing response:', err);
    await handleFatalError('Error processing response: ' + err.message);
  }
}

async function handleFatalError(message) {
  console.error('💥 FATAL ERROR: ' + message);
  
  const errorMessage = 'SYSTEM: FATAL ERROR - ' + message + '\n\n' +
    'The system encountered an unrecoverable error and must exit.\n' +
    'Please check the logs and restart the watcher.';
  
  await updateConversation(errorMessage);
  
  // Exit the process
  process.exit(1);
}

async function handleExtractionResponse(responseText, tempBlock) {
  try {
    // For extraction, we accept plain text - no validation needed
    let extractedContent = responseText.trim();
    
    if (!extractedContent) {
      extractedContent = '[No relevant information found]';
    }
    
    // Remove the temporary block from conversation
    const conversation = await utils.readFileIfExists('conversation.md');
    const cleanedConversation = utils.removeTemporaryBlock(conversation, tempBlock.startLine, tempBlock.endLine);
    
    // Create permanent summary block
    const summaryBlock = formatSystemToolResult('SYSTEM: Read summary of ' + tempBlock.title.replace('TEMPORARY: ', '') + '\n' + extractedContent);
    
    // Update conversation with cleaned version + summary
    const lines = cleanedConversation.split('\n');
    const historyIndex = lines.findIndex(line => line.includes('=== CONVERSATION HISTORY ==='));
    const waitingIndex = lines.findIndex(line => line.includes('=== WAITING FOR YOUR MESSAGE ==='));
    
    let historyContent = '';
    if (historyIndex !== -1 && waitingIndex > historyIndex) {
      historyContent = lines.slice(historyIndex + 1, waitingIndex).join('\n').trim();
    }
    
    const newHistory = historyContent + (historyContent ? '\n\n' : '') + summaryBlock;
    const updated = '=== CONVERSATION HISTORY ===\n\n' + newHistory + '\n\n=== WAITING FOR YOUR MESSAGE ===\n[write here when ready]';
    
    await fs.writeFile('conversation.md', updated, 'utf8');
    console.log('✓ Extraction complete, summary added to conversation');
    
    // Clear response and build next prompt
    await fs.writeFile('ai-response.md', '', 'utf8');
    const buildPrompt = require('./message-to-prompt').buildPrompt;
    await buildPrompt();
    console.log('✓ Next prompt ready');
    
  } catch (err) {
    console.error('Error handling extraction response:', err);
    await handleFatalError('Failed to process extraction response: ' + err.message);
  }
}

async function handleResponseTypeError(errorMessage, responseText) {
  // If response has box format, add it to conversation
  if (responseText.includes('┌─ ASSISTANT')) {
    // Already has box format - fix padding if needed
    const cleanResponse = utils.fixBoxPadding(responseText);
    await updateConversation(cleanResponse);
  }
  // Otherwise, don't add to conversation - describe the error instead
  
  const errorResponse = 'SYSTEM: ERROR - ' + errorMessage + '\n\n' +
    'Response Rules:\n' +
    '1. READ Response: Use ONLY [READ_CODE], [READ_REQUIREMENTS], [SEARCH_NAME], [SEARCH_CONTENT]\n' +
    '2. WRITE Response: Use [MESSAGE] for text and/or action tools\n' +
    '3. Wrap response in ┌─ ASSISTANT ─ box\n\n' +
    (responseText.includes('┌─ ASSISTANT') ? 
      'Your last response violated these rules. Please try again.' :
      'Your response was missing the required ASCII box format. Here\'s what you wrote:\n\n' +
      '--- START OF YOUR INVALID RESPONSE ---\n' +
      responseText + '\n' +
      '--- END OF YOUR INVALID RESPONSE ---\n\n' +
      'Please reformat this response with the proper ASCII box.');
  
  await updateConversation(errorResponse);
  await fs.writeFile('ai-response.md', '', 'utf8');
  
  const buildPrompt = require('./message-to-prompt').buildPrompt;
  await buildPrompt();
  console.log('✓ Error prompt ready in generated-prompt.md');
}

async function handleReadResponse(responseText, tools) {
  // For read responses, just add the box format to conversation
  const cleanResponse = utils.replaceToolsWithIndicators(responseText, tools);
  await updateConversation(cleanResponse);
  
  const temporaryBlocks = [];
  const SEARCH_BLOCK_SIZE = 30000; // 30K characters per block
  
  // Process all read tools and prepare temporary blocks
  for (let i = 0; i < tools.length; i++) {
    const tool = tools[i];
    
    if (tool.name === 'READ_CODE' || tool.name === 'READ_REQUIREMENTS') {
      // Execute the tool to get the result
      const rawResult = await executeTool(tool);
      
      if (typeof rawResult === 'string' && rawResult.startsWith('Error:')) {
        // Error occurred, add to conversation normally
        await updateConversation('SYSTEM: Tool result (' + tool.name + ')\n' + rawResult);
      } else {
        // Extract just the content without the prefix
        let content = rawResult;
        let title = '';
        
        const lines = rawResult.split('\n');
        if (lines[0].startsWith('Content of ') || lines[0].startsWith('Contents of ')) {
          title = lines[0].replace('Content of ', '').replace('Contents of ', '').replace(':', '').trim();
          content = lines.slice(1).join('\n');
        } else {
          title = (tool.params.file_name || tool.params.path || '.');
        }
        
        // Add to temporary blocks list (one per file)
        temporaryBlocks.push({ title, content });
      }
    } else if (tool.name === 'SEARCH_CONTENT') {
      // Execute the search
      const rawResult = await executeTool(tool);
      
      if (typeof rawResult === 'string' && rawResult.startsWith('Error:')) {
        await updateConversation('SYSTEM: Tool result (' + tool.name + ')\n' + rawResult);
      } else {
        const title = 'Search results for "' + tool.params.regex + '"';
        
        // For search results, check if we need to split into multiple blocks
        if (rawResult.length <= SEARCH_BLOCK_SIZE) {
          temporaryBlocks.push({ title, content: rawResult });
        } else {
          // Split search results into blocks
          const lines = rawResult.split('\n');
          const searchBlocks = [];
          let currentBlock = [];
          let currentSize = 0;
          
          for (let j = 0; j < lines.length; j++) {
            const line = lines[j];
            const lineSize = line.length + 1; // +1 for newline
            
            // Check if this is a result boundary (new file match)
            const isNewResult = line.match(/^[^\s].*\(lines \d+-\d+\):$/);
            
            if (isNewResult && currentSize > 0 && currentSize + lineSize > SEARCH_BLOCK_SIZE) {
              // Start a new block at result boundary
              searchBlocks.push(currentBlock.join('\n'));
              currentBlock = [line];
              currentSize = lineSize;
            } else {
              currentBlock.push(line);
              currentSize += lineSize;
            }
          }
          
          // Add the last block
          if (currentBlock.length > 0) {
            searchBlocks.push(currentBlock.join('\n'));
          }
          
          // Create numbered blocks
          for (let k = 0; k < searchBlocks.length; k++) {
            temporaryBlocks.push({
              title: title,
              content: searchBlocks[k],
              blockNumber: k + 1,
              totalBlocks: searchBlocks.length
            });
          }
        }
      }
    } else if (tool.name === 'SEARCH_NAME') {
      // Other read tools process normally
      const result = await executeTool(tool);
      await updateConversation('SYSTEM: Tool result (' + tool.name + ')\n' + result);
    }
  }
  
  // Add all temporary blocks to conversation with numbering
  if (temporaryBlocks.length > 0) {
    for (let i = 0; i < temporaryBlocks.length; i++) {
      const block = temporaryBlocks[i];
      // Use block's own numbering if it has it (for split search results)
      const blockNumber = block.blockNumber || (i + 1);
      const totalBlocks = block.totalBlocks || temporaryBlocks.length;
      
      const tempBlock = utils.formatTemporaryBlock(block.title, block.content, blockNumber, totalBlocks);
      await updateConversation(tempBlock);
    }
  }
  
  // Clear response and build next prompt
  await fs.writeFile('ai-response.md', '', 'utf8');
  const buildPrompt = require('./message-to-prompt').buildPrompt;
  await buildPrompt();
  
  if (temporaryBlocks.length > 0) {
    console.log('✓ Added ' + temporaryBlocks.length + ' temporary content blocks, extraction prompt ready');
  } else {
    console.log('✓ Read operations complete, next prompt ready');
  }
}

async function handleWriteResponse(responseText, tools) {
  // Replace tool calls with readable indicators in conversation
  const cleanResponse = utils.replaceToolsWithIndicators(responseText, tools);
  await updateConversation(cleanResponse);
  
  // Separate tool types
  const messageTools = tools.filter(function(t) {
    return t.name === 'MESSAGE';
  });
  
  const specialTools = tools.filter(function(t) {
    return t.name === 'DISCOVERED' || t.name === 'SWITCH_TO' || 
           t.name === 'SWITCH_TO_EXPLORATION' || t.name === 'SWITCH_TO_PLANNING' ||
           t.name === 'SWITCH_TO_IMPLEMENTATION' ||
           t.name === 'EXPLORATION_FINDINGS' || t.name === 'DETAILED_PLAN';
  });
  
  const fileTools = tools.filter(function(t) {
    return t.name === 'CREATE' || t.name === 'UPDATE' || 
           t.name === 'INSERT' || t.name === 'DELETE';
  });
  
  // Handle MESSAGE tools - no execution needed, already in conversation
  // The content is already shown via replaceToolsWithIndicators
  
  // Handle special tools
  for (let i = 0; i < specialTools.length; i++) {
    const tool = specialTools[i];
    await handleSpecialTool(tool);
  }
  
  // Handle file operation tools
  for (let i = 0; i < fileTools.length; i++) {
    const tool = fileTools[i];
    const result = await executeTool(tool);
    
    if (tool.name === 'UPDATE' || tool.name === 'INSERT') {
      await requestFileConfirmation(tool, result);
      return; // Wait for confirmation
    }
    
    // Add tool result to conversation
    const resultText = typeof result === 'string' ? result : JSON.stringify(result);
    await updateConversation('SYSTEM: Tool result (' + tool.name + ')\n' + resultText);
  }
  
  await fs.writeFile('ai-response.md', '', 'utf8');
  const buildPrompt = require('./message-to-prompt').buildPrompt;
  await buildPrompt();
  console.log('✓ Write response processed, next prompt ready');
}

async function handleFormatError(errorMessage) {
  const responseText = await utils.readFileIfExists('ai-response.md');
  
  // Don't add malformed response to conversation
  // Instead, show the entire response in the error message
  const errorResponse = 'SYSTEM: ERROR - ' + errorMessage + '\n\n' +
    'Your response was:\n\n' +
    '--- START OF YOUR INVALID RESPONSE ---\n' +
    responseText + '\n' +
    '--- END OF YOUR INVALID RESPONSE ---\n\n' +
    'Please fix your response format. Remember to:\n' +
    '1. Start with: ┌─ ASSISTANT ─────────────────────────────────────────────────────────\n' +
    '2. Wrap each line with │ ...\n' +
    '3. End with: └─────────────────────────────────────────────────────────────────────';
  
  await updateConversation(errorResponse);
  await fs.writeFile('ai-response.md', '', 'utf8');
  
  const buildPrompt = require('./message-to-prompt').buildPrompt;
  await buildPrompt();
  console.log('✓ Error prompt ready in generated-prompt.md');
}

async function handleIncompleteMessage(responseText) {
  // Parse tools and clean the response
  const tools = utils.parseToolBlocks(responseText);
  const cleanResponse = utils.replaceToolsWithIndicators(responseText, tools);
  
  // Add the incomplete response to conversation
  await updateConversation(cleanResponse);
  
  // Get the last 100 characters to show context
  const lastPart = responseText.slice(-100);
  const continuationRequest = 'SYSTEM: Your message was cut off. Please continue from: "' + lastPart + '"';
  
  await updateConversation(continuationRequest);
  await fs.writeFile('ai-response.md', '', 'utf8');
  
  const buildPrompt = require('./message-to-prompt').buildPrompt;
  await buildPrompt();
  console.log('✓ Continuation prompt ready in generated-prompt.md');
}

async function handleSpecialTool(tool) {
  switch (tool.name) {
    case 'DISCOVERED':
      await handleDiscovery(tool.params);
      break;
    case 'SWITCH_TO':
    case 'SWITCH_TO_EXPLORATION':
    case 'SWITCH_TO_PLANNING':
    case 'SWITCH_TO_IMPLEMENTATION':
      await updateMode(tool.params.mode);
      break;
    case 'EXPLORATION_FINDINGS':
      await saveAiDocument('exploration-findings', tool.params);
      break;
    case 'DETAILED_PLAN':
      await saveAiDocument('implementation-plan', tool.params);
      break;
  }
}

async function saveAiDocument(type, params) {
  if (!params.name) {
    throw new Error('Missing required "name" field for ' + type);
  }
  
  await utils.ensureDir('ai-docs');
  const filename = 'ai-docs/' + params.name + '.md';
  await fs.writeFile(filename, params.content, 'utf8');
  
  console.log('✓ Saved ' + type + ': ' + filename);
}

async function handleDiscovery(params) {
  const importance = parseInt(params.importance) || 5;
  const content = params.content || '';
  
  const timestamp = new Date().toISOString().split('T')[0];
  const discoveryEntry = '[' + timestamp + '] importance:' + importance + ' ' + content;
  
  const existingDiscoveries = await utils.readFileIfExists('ai-managed/discoveries.md');
  const updated = existingDiscoveries + '\n' + discoveryEntry;
  
  const compacted = utils.compactDiscoveries(updated);
  await fs.writeFile('ai-managed/discoveries.md', compacted, 'utf8');
  
  console.log('✓ Added discovery (importance: ' + importance + ')');
}

async function updateMode(newMode) {
  const modeContent = await utils.readFileIfExists('mode.md');
  const lines = modeContent.split('\n');
  
  const updated = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    if (trimmed === newMode) {
      updated.push('x ' + newMode);
    } else if (line.startsWith('x ')) {
      updated.push('  ' + line.slice(2));
    } else {
      updated.push(line);
    }
  }
  
  await fs.writeFile('mode.md', updated.join('\n'), 'utf8');
  console.log('✓ Switched to ' + newMode + ' mode');
}

async function executeTool(tool) {
  switch (tool.name) {
    case 'READ_CODE':
    case 'READ_REQUIREMENTS':
      return await executeRead(tool.params);
    case 'SEARCH_NAME':
      return await executeSearchFilesByName(tool.params);
    case 'SEARCH_CONTENT':
      return await executeSearchFilesByContent(tool.params);
    case 'CREATE':
      return await executeCreateFile(tool.params);
    case 'UPDATE':
      return await executeUpdateFile(tool.params);
    case 'INSERT':
      return await executeInsertLines(tool.params);
    case 'DELETE':
      return await executeDeleteFile(tool.params);
    default:
      return 'Unknown tool: ' + tool.name;
  }
}

async function executeListDirectory(params) {
  try {
    const dirPath = utils.getCodebasePath(params.path || '.');
    
    // Binary extensions list
    const binaryExtensions = [
      '.jar', '.ear', '.war', '.zip', '.tar', '.gz', '.7z', '.rar',
      '.exe', '.dll', '.so', '.dylib', '.lib', '.a', '.o',
      '.class', '.pyc', '.pyo', '.beam', '.elc',
      '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx',
      '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.ico', '.svg', '.webp',
      '.mp3', '.mp4', '.avi', '.mov', '.wmv', '.flv', '.webm',
      '.ttf', '.otf', '.woff', '.woff2', '.eot',
      '.db', '.sqlite', '.sqlite3'
    ];
    
    async function buildTree(dir, prefix, depth = 0) {
      if (depth >= 2) return ''; // Limit to 2 levels deep
      
      let result = '';
      const entries = await fs.readdir(dir, { withFileTypes: true });
      
      // Separate and sort directories and files
      const dirs = [];
      const files = [];
      
      for (let i = 0; i < entries.length; i++) {
        const entry = entries[i];
        if (entry.name.startsWith('.')) continue;
        
        if (entry.isDirectory()) {
          dirs.push(entry.name);
        } else {
          files.push(entry.name);
        }
      }
      
      dirs.sort();
      files.sort();
      
      // Process directories
      for (let i = 0; i < dirs.length; i++) {
        const dirName = dirs[i];
        const isLast = (i === dirs.length - 1 && files.length === 0);
        const subPath = path.join(dir, dirName);
        
        result += prefix + (isLast ? '└── ' : '├── ') + dirName + '/\n';
        
        // Recursively build subtree (will stop at depth 2)
        const subTree = await buildTree(subPath, prefix + (isLast ? '    ' : '│   '), depth + 1);
        result += subTree;
      }
      
      // Process files
      for (let i = 0; i < files.length; i++) {
        const fileName = files[i];
        const isLast = (i === files.length - 1);
        const filePath = path.join(dir, fileName);
        const ext = path.extname(fileName).toLowerCase();
        const isBinary = binaryExtensions.includes(ext);
        
        if (isBinary) {
          result += prefix + (isLast ? '└── ' : '├── ') + fileName + ' (binary)\n';
        } else {
          const lineCount = await utils.getLineCount(filePath);
          result += prefix + (isLast ? '└── ' : '├── ') + fileName + ' (' + lineCount + ' lines)\n';
        }
      }
      
      return result;
    }
    
    const rootName = params.path || '.';
    let result = 'Contents of ' + rootName + ':\n';
    
    const tree = await buildTree(dirPath, '');
    if (tree) {
      result += tree;
    } else {
      result += '[Empty directory]';
    }
    
    return result;
  } catch (err) {
    return 'Error listing directory: ' + err.message;
  }
}

async function executeRead(params) {
  try {
    const targetPath = utils.getCodebasePath(params.file_name || params.path || '.');
    
    // Check if it's a directory or file
    const stats = await fs.stat(targetPath);
    
    if (stats.isDirectory()) {
      // Execute directory listing
      return await executeListDirectory({ path: params.file_name || params.path || '.' });
    } else {
      // Execute file reading
      return await executeReadFile({ file_name: params.file_name || params.path });
    }
  } catch (err) {
    // If stat fails, try as file first (backward compatibility)
    if (err.code === 'ENOENT') {
      return 'Error: ' + (params.file_name || params.path || '.') + ' not found';
    }
    return 'Error reading ' + (params.file_name || params.path || '.') + ': ' + err.message;
  }
}

async function executeReadFile(params) {
  try {
    const filePath = utils.getCodebasePath(params.file_name);
    
    // Check if file extension is binary/non-text
    const binaryExtensions = [
      '.jar', '.ear', '.war', '.zip', '.tar', '.gz', '.7z', '.rar',
      '.exe', '.dll', '.so', '.dylib', '.lib', '.a', '.o',
      '.class', '.pyc', '.pyo', '.beam', '.elc', '.o',
      '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx',
      '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.ico', '.svg', '.webp',
      '.mp3', '.mp4', '.avi', '.mov', '.wmv', '.flv', '.webm',
      '.ttf', '.otf', '.woff', '.woff2', '.eot',
      '.db', '.sqlite', '.sqlite3',
      '.min.js', '.min.css' // Often minified files are too large/unreadable
    ];
    
    const ext = path.extname(params.file_name).toLowerCase();
    if (binaryExtensions.includes(ext)) {
      return 'Error: Cannot read ' + params.file_name + ' - AI is not allowed to read non-text files. Binary and compressed files are not supported.';
    }
    
    const content = await fs.readFile(filePath, 'utf8');
    
    if (!content || content.trim() === '') {
      return params.file_name + ' is empty';
    }
    
    // Normalize line endings before processing
    const normalizedContent = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    const lines = normalizedContent.split('\n');
    const numberedLines = [];
    for (let i = 0; i < lines.length; i++) {
      numberedLines.push((i + 1) + ': ' + lines[i]);
    }
    return 'Content of ' + params.file_name + ':\n' + numberedLines.join('\n');
  } catch (err) {
    // Check if the error is due to the file being binary
    if (err.code === 'ERR_INVALID_ARG_TYPE' || err.toString().includes('Invalid character')) {
      return 'Error: Cannot read ' + params.file_name + ' - file appears to be binary. AI is only allowed to read text files.';
    }
    return 'Error reading ' + params.file_name + ': ' + err.message;
  }
}

async function executeSearchFilesByName(params) {
  try {
    const searchPath = utils.getCodebasePath(params.folder);
    const results = await utils.searchFilesByName(searchPath, params.regex);
    if (results.length === 0) {
      return 'No files found matching "' + params.regex + '" in ' + params.folder;
    }
    const relativePaths = [];
    for (let i = 0; i < results.length; i++) {
      relativePaths.push(path.relative(utils.CODEBASE_PATH, results[i]));
    }
    return 'Files found:\n' + relativePaths.join('\n');
  } catch (err) {
    return 'Error searching files: ' + err.message;
  }
}

async function executeSearchFilesByContent(params) {
  try {
    const searchPath = utils.getCodebasePath(params.folder);
    const results = await utils.searchFilesByContent(searchPath, params.regex);
    if (results.length === 0) {
      return 'No content found matching "' + params.regex + '" in ' + params.folder;
    }
    
    let output = 'Content matches for "' + params.regex + '":\n\n';
    for (let i = 0; i < results.length; i++) {
      const result = results[i];
      const relativePath = path.relative(utils.CODEBASE_PATH, result.file);
      output += relativePath + ' (lines ' + result.lines + '):\n' + result.content + '\n\n';
    }
    
    return output;
  } catch (err) {
    return 'Error searching content: ' + err.message;
  }
}

async function executeCreateFile(params) {
  try {
    const filePath = utils.getCodebasePath(params.path);
    await utils.ensureDir(path.dirname(filePath));
    await fs.writeFile(filePath, params.contents || '', 'utf8');
    
    return '✓ Created ' + params.path;
  } catch (err) {
    return 'Error creating ' + params.path + ': ' + err.message;
  }
}

async function executeUpdateFile(params) {
  try {
    const filePath = utils.getCodebasePath(params.file_name);
    const content = await fs.readFile(filePath, 'utf8');
    // Normalize line endings before processing
    const normalizedContent = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    const lines = normalizedContent.split('\n');
    
    const startIndex = parseInt(params.start_line) - 1;
    const endIndex = parseInt(params.end_line) - 1;
    
    if (startIndex < 0 || endIndex >= lines.length || startIndex > endIndex) {
      return 'Error: Invalid line range ' + params.start_line + '-' + params.end_line;
    }
    
    const before = lines.slice(0, startIndex);
    const after = lines.slice(endIndex + 1);
    const newContent = params.contents.split('\n');
    
    const updatedLines = before.concat(newContent).concat(after);
    const updatedContent = updatedLines.join('\n');
    
    return { 
      originalContent: normalizedContent, 
      modifiedContent: updatedContent,
      description: params.change_description || 'File update',
      filePath: filePath
    };
  } catch (err) {
    return 'Error updating ' + params.file_name + ': ' + err.message;
  }
}

async function executeInsertLines(params) {
  try {
    const filePath = utils.getCodebasePath(params.file_name);
    const content = await fs.readFile(filePath, 'utf8');
    // Normalize line endings before processing
    const normalizedContent = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    const lines = normalizedContent.split('\n');
    
    const insertIndex = parseInt(params.line_number) - 1;
    if (insertIndex < 0 || insertIndex > lines.length) {
      return 'Error: Invalid line number ' + params.line_number;
    }
    
    const newContent = params.contents.split('\n');
    const updatedLines = lines.slice(0, insertIndex).concat(newContent).concat(lines.slice(insertIndex));
    const updatedContent = updatedLines.join('\n');
    
    return { 
      originalContent: normalizedContent, 
      modifiedContent: updatedContent,
      description: params.change_description || 'Line insertion',
      filePath: filePath
    };
  } catch (err) {
    return 'Error inserting into ' + params.file_name + ': ' + err.message;
  }
}

async function executeDeleteFile(params) {
  try {
    const filePath = utils.getCodebasePath(params.file_name);
    await fs.unlink(filePath);
    
    return '✓ Deleted ' + params.file_name;
  } catch (err) {
    return 'Error deleting ' + params.file_name + ': ' + err.message;
  }
}

async function requestFileConfirmation(tool, result) {
  if (typeof result === 'string') {
    await updateConversation('SYSTEM: Tool result (' + tool.name + ')\n' + result);
    return;
  }
  
  const originalContent = result.originalContent;
  const modifiedContent = result.modifiedContent; 
  const description = result.description;
  const filePath = result.filePath;
  const originalLines = originalContent.split('\n');
  const modifiedLines = modifiedContent.split('\n');
  
  // For UPDATE operations, use the specified line range
  let previewStart, previewEnd, originalEnd;
  
  if (tool.name === 'UPDATE') {
    // Show the lines being replaced
    previewStart = parseInt(tool.params.start_line) - 1;
    originalEnd = parseInt(tool.params.end_line) - 1;
    // Show some context around the change in the new content
    previewEnd = Math.min(modifiedLines.length - 1, originalEnd + 20);
  } else {
    // For INSERT, find the first change
    let changeStart = 0;
    for (let i = 0; i < Math.min(originalLines.length, modifiedLines.length); i++) {
      if (originalLines[i] !== modifiedLines[i]) {
        changeStart = i;
        break;
      }
    }
    previewStart = Math.max(0, changeStart - 20);
    originalEnd = changeStart;
    previewEnd = Math.min(modifiedLines.length - 1, changeStart + 40);
  }
  
  const originalPreview = [];
  const originalSlice = originalLines.slice(previewStart, originalEnd + 1);
  for (let i = 0; i < originalSlice.length; i++) {
    originalPreview.push((previewStart + i + 1) + ': ' + originalSlice[i]);
  }
  
  const modifiedPreview = [];
  const modifiedSlice = modifiedLines.slice(previewStart, previewEnd + 1);
  for (let i = 0; i < modifiedSlice.length; i++) {
    modifiedPreview.push((previewStart + i + 1) + ': ' + modifiedSlice[i]);
  }
  
  // Create confirmation message with box format
  let confirmation = 'SYSTEM: PENDING UPDATE\nFile: ' + tool.params.file_name + '\nDescription: ' + description + '\n\n';
  confirmation += 'ORIGINAL CODE (lines ' + (previewStart + 1) + '-' + (originalEnd + 1) + '):\n';
  confirmation += originalPreview.join('\n') + '\n\n';
  confirmation += 'NEW CODE (lines ' + (previewStart + 1) + '-' + (previewEnd + 1) + '):\n';
  confirmation += modifiedPreview.join('\n') + '\n\n';
  confirmation += 'Reply with [COMMIT] to apply changes.';
  
  const pendingData = {
    file: tool.params.file_name,
    filePath: filePath,
    originalContent: originalContent,
    modifiedContent: modifiedContent,
    description: description,
    changes: [tool]
  };
  
  await fs.writeFile('pending-changes.json', JSON.stringify(pendingData, null, 2), 'utf8');
  
  await updateConversation(confirmation);
  await fs.writeFile('ai-response.md', '', 'utf8');
  
  const buildPrompt = require('./message-to-prompt').buildPrompt;
  await buildPrompt();
  console.log('✓ Confirmation prompt ready in generated-prompt.md');
  
  console.log('⚠ File operation pending confirmation: ' + tool.params.file_name);
}

async function handlePendingUpdate(responseText) {
  // Check if message is complete
  if (!utils.hasBoxClosure(responseText)) {
    console.log('⚠ Incomplete message during pending update, requesting continuation');
    await handleIncompleteMessage(responseText);
    return;
  }
  
  const pendingData = JSON.parse(await fs.readFile('pending-changes.json', 'utf8'));
  
  // Check for COMMIT tool in the new format
  const tools = utils.parseToolBlocks(responseText);
  const commitTool = tools.find(function(t) { return t.name === 'COMMIT'; });
  
  if (commitTool || responseText.includes('COMMIT')) {
    // Add the commit response to conversation first
    const cleanResponse = utils.replaceToolsWithIndicators(responseText, tools);
    await updateConversation(cleanResponse);
    
    await fs.writeFile(pendingData.filePath, pendingData.modifiedContent, 'utf8');
    await fs.unlink('pending-changes.json');
    
    console.log('✓ Committed changes to ' + pendingData.file);
    
    await gitCommitAndPush(pendingData.file, pendingData.description);
    
    await updateConversation('SYSTEM: Changes committed to ' + pendingData.file + ' and pushed to git');
    await fs.writeFile('ai-response.md', '', 'utf8');
    
    const buildPrompt = require('./message-to-prompt').buildPrompt;
    await buildPrompt();
    console.log('✓ Next prompt ready in generated-prompt.md');
    
  } else {
    const cleanResponse = utils.replaceToolsWithIndicators(responseText, tools);
    await updateConversation(cleanResponse);
    
    const fileOps = tools.filter(function(t) {
      return t.name === 'UPDATE' || t.name === 'INSERT';
    });
    
    if (fileOps.length > 0 && fileOps[0].params.file_name === pendingData.file) {
      console.log('Processing new file operations for same file...');
      // Process the new file operations
      for (let i = 0; i < fileOps.length; i++) {
        const result = await executeTool(fileOps[i]);
        await requestFileConfirmation(fileOps[i], result);
        return;
      }
    } else {
      await updateConversation('SYSTEM: Invalid response. Please use [COMMIT] to apply changes.');
      
      const buildPrompt = require('./message-to-prompt').buildPrompt;
      await buildPrompt();
      console.log('✓ Error prompt ready in generated-prompt.md');
    }
  }
}

async function updateConversationForPrompt() {
  // Don't add any markers - conversation already has the content
  // This function is now just a placeholder for compatibility
}

async function updateConversation(newMessage) {
  const conversation = await utils.readFileIfExists('conversation.md');
  
  // Apply wrapping based on message type
  let wrappedMessage = newMessage;
  
  if (newMessage.startsWith('SYSTEM:')) {
    // Check if this is a tool result that should be formatted in a box
    const isToolResult = newMessage.includes('Tool result (') || 
                        newMessage.includes('Tool execution complete') ||
                        newMessage.includes('Content of ') ||
                        newMessage.includes('Contents of ') ||
                        newMessage.includes('Files found:') ||
                        newMessage.includes('Content matches') ||
                        newMessage.includes('Read summary of ');
    
    if (isToolResult) {
      // Format as special system box
      wrappedMessage = formatSystemToolResult(newMessage);
    } else {
      // Regular system message - no wrapping
      wrappedMessage = newMessage;
    }
  } else if (newMessage.startsWith('> ')) {
    // User messages - no wrapping
    wrappedMessage = newMessage;
  } else if (newMessage.includes('┌─ ASSISTANT')) {
    // Fix box format for assistant messages (remove right border if present)
    wrappedMessage = fixAssistantBoxFormat(newMessage);
  } else if (newMessage.includes('╔═ TEMPORARY:')) {
    // Temporary blocks are already formatted
    wrappedMessage = newMessage;
  }
  
  const lines = conversation.split('\n');
  const historyIndex = lines.findIndex(function(line) { return line.includes('=== CONVERSATION HISTORY ==='); });
  const waitingIndex = lines.findIndex(function(line) { return line.includes('=== WAITING FOR YOUR MESSAGE ==='); });
  
  if (historyIndex === -1) {
    const updated = '=== CONVERSATION HISTORY ===\n\n' + wrappedMessage + '\n\n=== WAITING FOR YOUR MESSAGE ===\n[write here when ready]';
    await fs.writeFile('conversation.md', updated, 'utf8');
  } else {
    let historyContent = '';
    
    // Extract existing history
    if (waitingIndex > historyIndex) {
      historyContent = lines.slice(historyIndex + 1, waitingIndex).join('\n').trim();
    } else {
      historyContent = lines.slice(historyIndex + 1).join('\n').trim();
    }
    
    // Append new message to history
    const newHistory = historyContent + (historyContent ? '\n\n' : '') + wrappedMessage;
    
    // Rebuild file with input area at bottom
    const updated = '=== CONVERSATION HISTORY ===\n\n' + newHistory + '\n\n=== WAITING FOR YOUR MESSAGE ===\n[write here when ready]';
    
    await fs.writeFile('conversation.md', updated, 'utf8');
  }
}

function formatSystemToolResult(message) {
  // Normalize line endings first
  const normalizedMessage = message.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const lines = normalizedMessage.split('\n');
  const firstLine = lines[0];
  
  // Extract the title from the first line
  let title = firstLine.replace('SYSTEM:', '').trim();
  
  // Start building the formatted output
  let result = '';
  const boxWidth = 70;
  
  // Determine the type of content
  const isFileContent = title.includes('Content of ');
  const isDirectoryListing = title.includes('Contents of ');
  const isSearchResult = title.includes('Content matches') || title.includes('Files found');
  const isError = title.includes('Error');
  const isReadSummary = title.includes('Read summary of ');
  
  // Format the header - handle long titles
  let headerText = ' SYSTEM: ' + title + ' ';
  if (headerText.length > boxWidth - 2) {
    // Truncate and add ellipsis
    headerText = headerText.substring(0, boxWidth - 5) + '... ';
  }
  const headerPadding = boxWidth - headerText.length - 2;
  result += '╔═' + headerText + '═'.repeat(Math.max(0, headerPadding)) + '═╗\n';
  
  // Process content lines
  const contentLines = lines.slice(1);
  let lineCount = 0;
  let actualLineNumber = 0;
  
  for (let i = 0; i < contentLines.length; i++) {
    const line = contentLines[i];
    lineCount++;
    
    // For file content, track actual line numbers
    if (isFileContent && !isReadSummary) {
      const lineMatch = line.match(/^(\d+):\s/);
      if (lineMatch) {
        actualLineNumber = parseInt(lineMatch[1]);
      }
    }
    
    // Check if we need a continuation header (every 50 lines for file content)
    if (isFileContent && !isReadSummary && actualLineNumber > 50 && (actualLineNumber - 1) % 50 === 0) {
      const fileName = title.replace('Content of ', '').replace('Tool result (READ)', '').trim();
      const endLine = Math.min(actualLineNumber + 49, actualLineNumber + contentLines.length - i - 1);
      const contTitle = ' SYSTEM: Continuing ' + fileName + 
                       ' (lines ' + actualLineNumber + '-' + endLine + ') ';
      if (contTitle.length > boxWidth - 2) {
        // Handle long continuation titles
        const shortFileName = '...' + fileName.substring(fileName.length - 20);
        const shortContTitle = ' SYSTEM: ' + shortFileName + 
                              ' (lines ' + actualLineNumber + '-' + endLine + ') ';
        const contPadding = boxWidth - shortContTitle.length - 2;
        result += '╠═' + shortContTitle + '═'.repeat(Math.max(0, contPadding)) + '═╣\n';
      } else {
        const contPadding = boxWidth - contTitle.length - 2;
        result += '╠═' + contTitle + '═'.repeat(Math.max(0, contPadding)) + '═╣\n';
      }
    }
    
    // Format the content line without right border
    if (line.trim() || line === '') {
      result += '║ ' + line + '\n';
    }
  }
  
  // Close the box
  result += '╚' + '═'.repeat(boxWidth - 2) + '╝';
  
  return result;
}

function fixAssistantBoxFormat(text) {
  const lines = text.split('\n');
  const fixedLines = [];
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    
    if (line.includes('┌─ ASSISTANT')) {
      // Fix top border - should end with straight line, not corner
      const fixedLine = line.replace(/┐\s*$/, '');
      fixedLines.push(fixedLine);
    } else if (line.includes('└─')) {
      // Fix bottom border - should end with straight line, not corner
      const fixedLine = line.replace(/┘\s*$/, '');
      fixedLines.push(fixedLine);
    } else if (line.startsWith('│')) {
      // Remove right border and trim
      const content = line.substring(1).replace(/\s*│\s*$/, '').trimEnd();
      fixedLines.push('│ ' + content);
    } else {
      fixedLines.push(line);
    }
  }
  
  return fixedLines.join('\n');
}

async function gitCommitAndPush(fileName, description) {
  const exec = require('child_process').exec;
  const promisify = require('util').promisify;
  const execAsync = promisify(exec);
  
  try {
    await execAsync('git add "' + fileName + '"', { cwd: utils.CODEBASE_PATH });
    console.log('✓ Git added: ' + fileName);
    
    const commitMessage = 'AI: ' + description;
    await execAsync('git commit -m "' + commitMessage + '"', { cwd: utils.CODEBASE_PATH });
    console.log('✓ Git commit: ' + commitMessage);
    
    await execAsync('git push', { cwd: utils.CODEBASE_PATH });
    console.log('✓ Git push completed');
    
  } catch (error) {
    console.error('⚠ Git operation failed:', error.message);
  }
}

module.exports = { processResponse: processResponse };
