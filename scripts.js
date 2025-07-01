async function buildPrompt() {
  try {
    await utils.ensureDir('ai-managed');
    
    const mode = utils.getActiveMode(await utils.readFileIfExists('mode.md'));
    const goals = await utils.readFileIfExists('goals.md');
    const context = await utils.readFileIfExists('ai-managed/context.md');
    const conversation = await utils.readFileIfExists('conversation.md');
    const basePrompt = await utils.readFileIfExists('prompts/base.md');
    const modePrompt = await utils.readFileIfExists('prompts/' + mode + '.md');
    
    // Generate 2-level directory listing
    const listTool = {
      name: 'LIST',
      params: { path: '.', maxDepth: 2 }
    };
    const projectStructure = await executeTwoLevelList(listTool.params);
    
    // Extract just the conversation history
    const lines = conversation.split('\n');
    const historyIndex = lines.findIndex(function(line) { return line.includes('=== CONVERSATION HISTORY ==='); });
    const waitingIndex = lines.findIndex(function(line) { return line.includes('=== WAITING FOR YOUR MESSAGE ==='); });
    
    let conversationHistory = '';
    if (historyIndex !== -1) {
      // Only get content between history marker and waiting marker
      if (waitingIndex > historyIndex) {
        conversationHistory = lines.slice(historyIndex + 1, waitingIndex).join('\n').trim();
      } else {
        conversationHistory = lines.slice(historyIndex + 1).join('\n').trim();
      }
      
      // Remove any "=== AI RESPONSE READY ===" lines that might have been left
      conversationHistory = conversationHistory.split('\n')
        .filter(function(line) { 
          return !line.includes('=== AI RESPONSE READY ===') && 
                 !line.includes('Copy the contents of generated-prompt.md');
        })
        .join('\n');
    }
    
    // Check if we need to compact the conversation
    const estimatedLength = utils.calculatePromptLength(basePrompt, modePrompt, goals, context, conversationHistory);
    
    if (estimatedLength > 500000 && conversationHistory.length > 10000) {
      console.log('📝 Compacting conversation history...');
      conversationHistory = utils.compactConversation(conversationHistory, 30000);
      console.log('✓ Conversation compacted');
    }
    
    // Build prompt with conditional sections
    let prompt = basePrompt + '\n\n' + modePrompt;
    
    // Only include goals if it has meaningful content
    if (goals.trim() && goals.trim() !== '# Project Goals\n\nAdd your high-level objectives here') {
      prompt += '\n\nGOALS:\n' + goals;
    }
    
    // Add project structure to context
    let fullContext = 'PROJECT STRUCTURE (2 levels):\n' + projectStructure;
    if (context.trim()) {
      fullContext += '\n\nADDITIONAL CONTEXT:\n' + context;
    }
    prompt += '\n\nCONTEXT:\n' + fullContext;
    
    // Only include conversation if there's history
    if (conversationHistory) {
      prompt += '\n\nCONVERSATION HISTORY:\n' + conversationHistory;
    }
    
    // Add instruction for AI to respond
    prompt += '\n\nGenerate your response as the assistant.';
    
    await fs.writeFile('generated-prompt.md', prompt, 'utf8');
    console.log('✓ Built prompt for ' + mode + ' mode');
    
    if (prompt.length > 500000) {
      console.log('⚠ Warning: Prompt is ' + prompt.length + ' chars, approaching 600k limit');
      if (prompt.length > 550000) {
        console.log('⚠ Consider running "npm run reset" if prompt becomes too large');
      }
    }
    
  } catch (err) {
    console.error('Error building prompt:', err);
  }
}// utils.js
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
  const boxMatch = text.match(/┌─ ASSISTANT[^┐]*┐\s*([\s\S]*?)\s*└─+┘/);
  let content = text;
  
  if (boxMatch) {
    // Extract content and remove box borders from each line
    const boxContent = boxMatch[1];
    const lines = boxContent.split('\n');
    const cleanedLines = [];
    
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      // Remove the leading "│ " and trailing " │" or "│"
      const cleaned = line.replace(/^│\s?/, '').replace(/\s*│\s*$/, '');
      if (cleaned.length > 0) {
        cleanedLines.push(cleaned);
      }
    }
    
    // Join continuation lines (lines starting with "... ")
    const joinedLines = [];
    let currentLine = '';
    
    for (let i = 0; i < cleanedLines.length; i++) {
      const line = cleanedLines[i];
      if (line.startsWith('... ')) {
        // Continuation line - append to current line
        currentLine += line.slice(4); // Remove "... " prefix
      } else {
        // New line - save previous and start new
        if (currentLine) {
          joinedLines.push(currentLine);
        }
        currentLine = line;
      }
    }
    if (currentLine) {
      joinedLines.push(currentLine);
    }
    
    content = joinedLines.join('\n');
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
  
  switch (toolName) {
    case 'LIST':
      params.path = args || '.';
      params.explanation = content;
      break;
      
    case 'READ':
      params.file_name = args;
      params.explanation = content;
      break;
      
    case 'SEARCH_NAME':
      const nameArgs = args.split(/\s+/);
      params.regex = nameArgs[0];
      params.folder = nameArgs[1] || '.';
      params.explanation = content;
      break;
      
    case 'SEARCH_CONTENT':
      const contentArgs = args.split(/\s+/);
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
  const informationTools = ['LIST', 'READ', 'SEARCH_NAME', 'SEARCH_CONTENT'];
  const responseTools = ['MESSAGE', 'DISCOVERED', 'EXPLORATION_FINDINGS', 'DETAILED_PLAN', 
                        'CREATE', 'UPDATE', 'INSERT', 'DELETE',
                        'SWITCH_TO', 'COMMIT'];
  
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
      error: 'Response must be wrapped in ASCII box starting with ┌─ ASSISTANT ─┐'
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
  return /└─+┘/.test(text);
}

function validateMessageFormat(text) {
  if (!text.includes('┌─ ASSISTANT') || !hasBoxClosure(text)) {
    throw new Error('Invalid format: Response must be wrapped in complete ASCII box');
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
            const content = await fs.readFile(fullPath, 'utf8');
            const lines = content.split('\n');
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
  if (maxCount === undefined) maxCount = 50;
  
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
  if (maxLength === undefined) maxLength = 50000; // Default max length for conversation
  
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
  
  if (exchanges.length <= 3) {
    return conversationHistory; // Don't compact if very short
  }
  
  // Keep recent exchanges (last 3) and summarize older ones
  const recentExchanges = exchanges.slice(-3);
  const oldExchanges = exchanges.slice(0, -3);
  
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
    for (let i = 0; i < Math.min(decisions.length, 5); i++) {
      summary += '- ' + decisions[i] + '\n';
    }
    summary += '\n';
  }
  
  if (discoveries.length > 0) {
    summary += 'KEY DISCOVERIES:\n';
    for (let i = 0; i < Math.min(discoveries.length, 3); i++) {
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
    return content.split('\n').length;
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
  if (!maxWidth) maxWidth = 70;
  const words = text.split(' ');
  const lines = [];
  let currentLine = '';
  
  for (let i = 0; i < words.length; i++) {
    const word = words[i];
    if (currentLine.length + word.length + 1 > maxWidth) {
      lines.push(currentLine);
      currentLine = '... ' + word;
    } else {
      currentLine += (currentLine ? ' ' : '') + word;
    }
  }
  
  if (currentLine) lines.push(currentLine);
  return lines;
}

function formatInBox(content, width) {
  if (!width) width = 70;
  const lines = content.split('\n');
  const wrappedLines = [];
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.length <= width - 4) { // Account for box borders
      wrappedLines.push(line);
    } else {
      // Wrap long lines
      const wrapped = wrapText(line, width - 4);
      wrappedLines.push(...wrapped);
    }
  }
  
  // Build box
  let result = '┌─ ASSISTANT ';
  result += '─'.repeat(width - result.length - 1) + '┐\n';
  
  for (let i = 0; i < wrappedLines.length; i++) {
    const line = wrappedLines[i];
    result += '│ ' + line + ' '.repeat(width - line.length - 4) + ' │\n';
  }
  
  result += '└' + '─'.repeat(width - 2) + '┘';
  return result;
}

function wrapSystemMessage(content) {
  const lines = content.split('\n');
  const wrapped = [];
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.length <= 70) {
      wrapped.push(line);
    } else {
      const wrappedLine = wrapText(line, 70);
      wrapped.push(...wrappedLine);
    }
  }
  
  return wrapped.join('\n');
}

function fixBoxPadding(text) {
  const lines = text.split('\n');
  const fixedLines = [];
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    
    if (line.includes('┌─ ASSISTANT')) {
      // Top border - ensure it's exactly 70 chars
      const prefix = '┌─ ASSISTANT ';
      fixedLines.push(prefix + '─'.repeat(70 - prefix.length - 1) + '┐');
    } else if (line.includes('└─')) {
      // Bottom border
      fixedLines.push('└' + '─'.repeat(68) + '┘');
    } else if (line.startsWith('│')) {
      // Content line - ensure proper padding
      const content = line.substring(1).replace(/\s*│\s*$/, '');
      const paddedContent = content + ' '.repeat(Math.max(0, 68 - content.length));
      fixedLines.push('│' + paddedContent + ' │');
    } else {
      fixedLines.push(line);
    }
  }
  
  return fixedLines.join('\n');
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
  fixBoxPadding: fixBoxPadding
};

// ==========================================

// message-to-prompt.js
const fs = require('fs').promises;
const utils = require('./utils');

async function buildPrompt() {
  try {
    await utils.ensureDir('ai-managed');
    
    const mode = utils.getActiveMode(await utils.readFileIfExists('mode.md'));
    const goals = await utils.readFileIfExists('goals.md');
    const context = await utils.readFileIfExists('ai-managed/context.md');
    const conversation = await utils.readFileIfExists('conversation.md');
    const basePrompt = await utils.readFileIfExists('prompts/base.md');
    const modePrompt = await utils.readFileIfExists('prompts/' + mode + '.md');
    
    // Extract just the conversation history
    const lines = conversation.split('\n');
    const historyIndex = lines.findIndex(function(line) { return line.includes('=== CONVERSATION HISTORY ==='); });
    const waitingIndex = lines.findIndex(function(line) { return line.includes('=== WAITING FOR YOUR MESSAGE ==='); });
    
    let conversationHistory = '';
    if (historyIndex !== -1) {
      // Only get content between history marker and waiting marker
      if (waitingIndex > historyIndex) {
        conversationHistory = lines.slice(historyIndex + 1, waitingIndex).join('\n').trim();
      } else {
        conversationHistory = lines.slice(historyIndex + 1).join('\n').trim();
      }
      
      // Remove any "=== AI RESPONSE READY ===" lines that might have been left
      conversationHistory = conversationHistory.split('\n')
        .filter(function(line) { 
          return !line.includes('=== AI RESPONSE READY ===') && 
                 !line.includes('Copy the contents of generated-prompt.md');
        })
        .join('\n');
    }
    
    // Check if we need to compact the conversation
    const estimatedLength = utils.calculatePromptLength(basePrompt, modePrompt, goals, context, conversationHistory);
    
    if (estimatedLength > 500000 && conversationHistory.length > 10000) {
      console.log('📝 Compacting conversation history...');
      conversationHistory = utils.compactConversation(conversationHistory, 30000);
      console.log('✓ Conversation compacted');
    }
    
    // Build prompt with conditional sections
    let prompt = basePrompt + '\n\n' + modePrompt + '\n\nGOALS:\n' + goals;
    
    // Only include context if it has content
    if (context.trim()) {
      prompt += '\n\nCONTEXT:\n' + context;
    }
    
    // Only include conversation if there's history
    if (conversationHistory) {
      prompt += '\n\nCONVERSATION HISTORY:\n' + conversationHistory;
    }
    
    // Add instruction for AI to respond
    prompt += '\n\nGenerate your response as the assistant.';
    
    await fs.writeFile('generated-prompt.md', prompt, 'utf8');
    console.log('✓ Built prompt for ' + mode + ' mode');
    
    if (prompt.length > 500000) {
      console.log('⚠ Warning: Prompt is ' + prompt.length + ' chars, approaching 600k limit');
      if (prompt.length > 550000) {
        console.log('⚠ Consider running "npm run reset" if prompt becomes too large');
      }
    }
    
  } catch (err) {
    console.error('Error building prompt:', err);
  }
}

async function executeTwoLevelList(params) {
  try {
    const dirPath = utils.getCodebasePath(params.path || '.');
    
    async function buildTree(dir, prefix, depth, maxDepth) {
      if (depth > maxDepth) return '';
      
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
        
        // Recursively build subtree
        if (depth < maxDepth) {
          const subTree = await buildTree(subPath, prefix + (isLast ? '    ' : '│   '), depth + 1, maxDepth);
          result += subTree;
        }
      }
      
      // Process files
      for (let i = 0; i < files.length; i++) {
        const fileName = files[i];
        const isLast = (i === files.length - 1);
        const filePath = path.join(dir, fileName);
        const lineCount = await utils.getLineCount(filePath);
        
        result += prefix + (isLast ? '└── ' : '├── ') + fileName + ' (' + lineCount + ' lines)\n';
      }
      
      return result;
    }
    
    const rootName = params.path || '.';
    let result = 'Contents of ' + rootName + ':\n';
    
    const tree = await buildTree(dirPath, '', 0, 2);
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

module.exports = { buildPrompt: buildPrompt, executeTwoLevelList: executeTwoLevelList };

// ==========================================

// process-response.js
const fs = require('fs').promises;
const path = require('path');
const utils = require('./utils');

async function processResponse() {
  try {
    const responseText = await utils.readFileIfExists('ai-response.md');
    if (!responseText.trim()) return;
    
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
        // Missing box entirely
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
  }
}

async function handleResponseTypeError(errorMessage, responseText) {
  // Add the invalid response to conversation, ensuring it's properly formatted
  let cleanResponse;
  if (responseText.includes('┌─ ASSISTANT')) {
    // Already has box format - fix padding if needed
    cleanResponse = utils.fixBoxPadding(responseText);
  } else {
    // No box format - add it
    cleanResponse = utils.formatInBox(responseText, 70);
  }
  await updateConversation(cleanResponse);
  
  const errorResponse = 'SYSTEM: ERROR - ' + errorMessage + '\n\n' +
    'Response Rules:\n' +
    '1. READ Response: Use ONLY [LIST], [READ], [SEARCH_NAME], [SEARCH_CONTENT]\n' +
    '2. WRITE Response: Use [MESSAGE] for text and/or action tools\n' +
    '3. Wrap response in ┌─ ASSISTANT ─┐ box\n\n' +
    'Your last response violated these rules. Please try again.';
  
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
  
  // Process all read tools
  for (let i = 0; i < tools.length; i++) {
    const tool = tools[i];
    const result = await executeTool(tool);
    
    // Add tool result to conversation
    const resultText = typeof result === 'string' ? result : JSON.stringify(result);
    await updateConversation('SYSTEM: Tool result (' + tool.name + ')\n' + resultText);
  }
  
  // Clear response and build next prompt
  await fs.writeFile('ai-response.md', '', 'utf8');
  const buildPrompt = require('./message-to-prompt').buildPrompt;
  await buildPrompt();
  console.log('✓ Read operations complete, next prompt ready');
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
  
  // Parse tools and clean the response
  const tools = utils.parseToolBlocks(responseText);
  const cleanResponse = utils.replaceToolsWithIndicators(responseText, tools);
  
  // Add the malformed response to conversation so AI can see what went wrong
  await updateConversation(cleanResponse);
  
  const errorResponse = 'SYSTEM: ERROR - ' + errorMessage + '\n\nPlease fix your response format. Remember to wrap in ┌─ ASSISTANT ─┐ box.';
  
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
    case 'LIST':
      return await executeListDirectory(tool.params);
    case 'READ':
      return await executeReadFile(tool.params);
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
    
    async function buildTree(dir, prefix) {
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
        
        // Recursively build subtree
        const subTree = await buildTree(subPath, prefix + (isLast ? '    ' : '│   '));
        result += subTree;
      }
      
      // Process files
      for (let i = 0; i < files.length; i++) {
        const fileName = files[i];
        const isLast = (i === files.length - 1);
        const filePath = path.join(dir, fileName);
        const lineCount = await utils.getLineCount(filePath);
        
        result += prefix + (isLast ? '└── ' : '├── ') + fileName + ' (' + lineCount + ' lines)\n';
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

async function executeReadFile(params) {
  try {
    const filePath = utils.getCodebasePath(params.file_name);
    const content = await fs.readFile(filePath, 'utf8');
    
    if (!content || content.trim() === '') {
      return params.file_name + ' is empty';
    }
    
    const lines = content.split('\n');
    const numberedLines = [];
    for (let i = 0; i < lines.length; i++) {
      numberedLines.push((i + 1) + ': ' + lines[i]);
    }
    return 'Content of ' + params.file_name + ':\n' + numberedLines.join('\n');
  } catch (err) {
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
    const lines = content.split('\n');
    
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
      originalContent: content, 
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
    const lines = content.split('\n');
    
    const insertIndex = parseInt(params.line_number) - 1;
    if (insertIndex < 0 || insertIndex > lines.length) {
      return 'Error: Invalid line number ' + params.line_number;
    }
    
    const newContent = params.contents.split('\n');
    const updatedLines = lines.slice(0, insertIndex).concat(newContent).concat(lines.slice(insertIndex));
    const updatedContent = updatedLines.join('\n');
    
    return { 
      originalContent: content, 
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
  
  let changeStart = 0;
  for (let i = 0; i < Math.min(originalLines.length, modifiedLines.length); i++) {
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
    originalPreview.push((previewStart + i + 1) + ': ' + originalSlice[i]);
  }
  
  const modifiedPreview = [];
  const modifiedSlice = modifiedLines.slice(previewStart, previewEnd + 1);
  for (let i = 0; i < modifiedSlice.length; i++) {
    modifiedPreview.push((previewStart + i + 1) + ': ' + modifiedSlice[i]);
  }
  
  const confirmation = 'SYSTEM: PENDING UPDATE for ' + tool.params.file_name + '\nDESCRIPTION: ' + description + '\n\nORIGINAL CODE (lines ' + (previewStart + 1) + '-' + (changeStart + 1) + '):\n' + originalPreview.join('\n') + '\n\nNEW CODE (lines ' + (previewStart + 1) + '-' + (previewEnd + 1) + '):\n' + modifiedPreview.join('\n') + '\n\nReply with [COMMIT] to apply changes.';
  
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
    // Wrap system messages without continuation markers
    const lines = newMessage.split('\n');
    const wrappedLines = [];
    
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (i === 0) {
        // First line with SYSTEM: prefix
        const content = line.slice('SYSTEM:'.length).trim();
        const wrapped = utils.wrapText(content, 62); // Leave room for "SYSTEM: "
        wrappedLines.push('SYSTEM: ' + wrapped[0]);
        for (let j = 1; j < wrapped.length; j++) {
          wrappedLines.push('        ' + wrapped[j].replace(/^\.\.\.+ /, '')); // Remove ... and indent
        }
      } else {
        // Subsequent lines
        const wrapped = utils.wrapText(line, 62);
        for (let j = 0; j < wrapped.length; j++) {
          wrappedLines.push('        ' + wrapped[j].replace(/^\.\.\.+ /, ''));
        }
      }
    }
    wrappedMessage = wrappedLines.join('\n');
  } else if (newMessage.startsWith('> ')) {
    // Wrap user messages without continuation markers
    const content = newMessage.slice(2);
    const wrapped = utils.wrapText(content, 68); // Leave room for "> "
    const cleanWrapped = wrapped.map(function(line) {
      return line.replace(/^\.\.\.+ /, '');
    });
    wrappedMessage = '> ' + cleanWrapped.join('\n  '); // Simple indent for continuation
  } else if (newMessage.includes('┌─ ASSISTANT')) {
    // Fix padding in assistant messages (they keep ... for continuation)
    wrappedMessage = utils.fixBoxPadding(newMessage);
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

// ==========================================

// watcher.js
const fs = require('fs');
const buildPrompt = require('./message-to-prompt').buildPrompt;
const processResponse = require('./process-response').processResponse;
const utils = require('./utils');

const watchedFiles = {
  'conversation.md': handleConversationChange,
  'ai-response.md': processResponse
};

async function handleConversationChange() {
  try {
    const conversation = await utils.readFileIfExists('conversation.md');
    
    const lines = conversation.split('\n');
    const messageIndex = lines.findIndex(function(line) { return line.includes('=== WAITING FOR YOUR MESSAGE ==='); });
    
    if (messageIndex !== -1 && messageIndex + 1 < lines.length) {
      const messageContent = lines[messageIndex + 1];
      if (messageContent.trim() && messageContent !== '[write here when ready]') {
        await moveMessageToHistory(messageContent);
        await buildPrompt();
        console.log('✓ New prompt ready in generated-prompt.md');
        return;
      }
    }
    
  } catch (err) {
    console.error('Error handling conversation change:', err);
  }
}

async function moveMessageToHistory(message) {
  const conversation = await utils.readFileIfExists('conversation.md');
  const lines = conversation.split('\n');
  
  const historyIndex = lines.findIndex(function(line) { return line.includes('=== CONVERSATION HISTORY ==='); });
  const waitingIndex = lines.findIndex(function(line) { return line.includes('=== WAITING FOR YOUR MESSAGE ==='); });
  
  if (historyIndex !== -1 && waitingIndex !== -1) {
    // Extract existing history (between the two markers)
    const historyContent = lines.slice(historyIndex + 1, waitingIndex).join('\n').trim();
    
    // Append user message to history
    const userMessage = '> ' + message;
    const newHistory = historyContent + (historyContent ? '\n\n' : '') + userMessage;
    
    // Rebuild file with input area at bottom
    const updated = '=== CONVERSATION HISTORY ===\n\n' + newHistory + '\n\n=== WAITING FOR YOUR MESSAGE ===\n[write here when ready]';
    
    await require('fs').promises.writeFile('conversation.md', updated, 'utf8');
    console.log('✓ Moved user message to history');
  }
}

async function createInitialFiles() {
  const initialFiles = {
    'conversation.md': '=== CONVERSATION HISTORY ===\n\n=== WAITING FOR YOUR MESSAGE ===\n[write here when ready]',
    'mode.md': 'x exploration\n  planning\n  implementation',
    'goals.md': '# Project Goals\n\nAdd your high-level objectives here',
    'ai-response.md': '',
    'generated-prompt.md': '',
    'prompts/base.md': '# Base prompt template - Update this file with the full prompt from the documentation',
    'prompts/exploration.md': '# EXPLORATION MODE\n\nYour job is to understand the codebase and requirements:\n\n- Use LIST to explore project structure\n- Use READ to examine key files\n- Use SEARCH_NAME and SEARCH_CONTENT to discover patterns\n- Use MESSAGE to ask clarifying questions or provide updates\n- Document findings with DISCOVERED blocks (importance 1-10)\n- When you have sufficient understanding, create exploration findings\n\nRemember: NO plain text allowed outside of tools. Use [MESSAGE] for all communication.\n\nFocus on understanding, not solving yet. Be thorough in your exploration.',
    'prompts/planning.md': '# PLANNING MODE\n\nYour job is to create a detailed implementation plan:\n\n- Review the exploration findings to understand the current state\n- Use [MESSAGE] to ask final clarifying questions\n- Break down work into specific, concrete tasks with file changes\n- Create detailed-plan using [DETAILED_PLAN] tool\n- Each task should specify exactly which files to modify and how\n- Use [MESSAGE] to explain your plan\n- Recommend [SWITCH_TO] implementation when plan is complete\n\nRemember: NO plain text allowed. Use [MESSAGE] for all explanations.\n\nBe thorough - implementation should have no surprises.',
    'prompts/implementation.md': '# IMPLEMENTATION MODE\n\nYour job is to execute the implementation plan:\n\n- Follow the detailed plan exactly as specified\n- Use UPDATE, INSERT, CREATE tools to make changes\n- Include descriptive change_description for all file operations\n- Use [MESSAGE] to explain what you\'re doing\n- Work through plan items systematically\n- If you hit unexpected issues: [SWITCH_TO] exploration\n- Focus on execution, not replanning\n\nRemember: NO plain text allowed. Use [MESSAGE] for all communication.'
  };

  const filenames = Object.keys(initialFiles);
  for (let i = 0; i < filenames.length; i++) {
    const filename = filenames[i];
    const content = initialFiles[filename];
    if (!fs.existsSync(filename)) {
      await utils.ensureDir(require('path').dirname(filename));
      await require('fs').promises.writeFile(filename, content, 'utf8');
      console.log('✓ Created ' + filename);
    }
  }
}

function startWatching() {
  console.log('🔍 Starting AI workflow watcher...');
  console.log('📁 Codebase path: ' + utils.CODEBASE_PATH);
  
  createInitialFiles().then(function() {
    console.log('✓ Initial files ready');
    console.log('💡 Edit conversation.md to get started!');
  }).catch(function(err) {
    console.error('⚠ Error during initialization:', err.message);
  });
  
  const filenames = Object.keys(watchedFiles);
  for (let i = 0; i < filenames.length; i++) {
    const filename = filenames[i];
    fs.watchFile(filename, { interval: 1000 }, async function(curr, prev) {
      if (curr.mtime > prev.mtime) {
        console.log('📝 ' + filename + ' changed');
        try {
          await watchedFiles[filename]();
        } catch (err) {
          console.error('Error handling ' + filename + ':', err.message);
        }
      }
    });
  }
  
  setInterval(function() {
    // Keep process alive
  }, 60000);
  
  console.log('✅ Watcher started. Monitoring files for changes...');
  console.log('📁 Watching: ' + Object.keys(watchedFiles).join(', '));
}

process.on('SIGINT', function() {
  console.log('\n🛑 Stopping watcher...');
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

// ==========================================

// reset.js
const fs = require('fs').promises;
const path = require('path');
const utils = require('./utils');

async function reset() {
  console.log('🔄 Resetting AI workflow...');
  
  try {
    // Files to reset completely
    const filesToClear = [
      'conversation.md',
      'ai-response.md',
      'generated-prompt.md',
      'pending-changes.json',
      'ai-managed/context.md',
      'ai-managed/discoveries.md',
      'ai-managed/exploration-findings.md',
      'ai-managed/detailed-plan.md'
    ];
    
    for (let i = 0; i < filesToClear.length; i++) {
      const file = filesToClear[i];
      try {
        if (file === 'conversation.md') {
          await fs.writeFile(file, '=== CONVERSATION HISTORY ===\n\n=== WAITING FOR YOUR MESSAGE ===\n[write here when ready]', 'utf8');
        } else if (file === 'pending-changes.json') {
          await fs.unlink(file).catch(() => {}); // Delete if exists, ignore if not
        } else {
          await fs.writeFile(file, '', 'utf8');
        }
        console.log('✓ Reset ' + file);
      } catch (err) {
        // File might not exist, that's ok
      }
    }
    
    // Reset mode to exploration
    await fs.writeFile('mode.md', 'x exploration\n  planning\n  implementation', 'utf8');
    console.log('✓ Reset mode to exploration');
    
    // Keep goals.md and prompt files intact
    console.log('✓ Preserved goals.md and prompt templates');
    
    // Optional: clear ai-docs folder
    const aiDocsPath = path.join(__dirname, 'ai-docs');
    try {
      const files = await fs.readdir(aiDocsPath);
      if (files.length > 0) {
        console.log('\n📁 AI documents found in ai-docs/:');
        for (let i = 0; i < files.length; i++) {
          console.log('  - ' + files[i]);
        }
        console.log('\nThese were NOT deleted. Delete manually if needed.');
      }
    } catch (err) {
      // ai-docs doesn't exist, that's fine
    }
    
    console.log('\n✅ Reset complete! Ready for a fresh start.');
    console.log('💡 Edit conversation.md to begin');
    
  } catch (err) {
    console.error('❌ Error during reset:', err);
  }
}

if (require.main === module) {
  reset();
}

module.exports = { reset: reset };
