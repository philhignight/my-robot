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
  const toolRegex = /@(\w+)\s*\{([^}]*)\}/gs;
  let match;
  
  while ((match = toolRegex.exec(text)) !== null) {
    const toolName = match[1];
    const blockContent = match[2];
    const params = {};
    
    // Parse key-value pairs
    const paramRegex = /(\w+):\s*\[\[\[value\]\]\]\s*(.*?)\s*\[\[\[\/\]\]\]/gs;
    let paramMatch;
    
    while ((paramMatch = paramRegex.exec(blockContent)) !== null) {
      params[paramMatch[1]] = paramMatch[2].trim();
    }
    
    tools.push({ 
      name: toolName, 
      params: params,
      startIndex: match.index,
      endIndex: match.index + match[0].length
    });
  }
  
  return tools;
}

function classifyTools(tools) {
  const informationTools = ['READ_FILE', 'SEARCH_FILES_BY_NAME', 'SEARCH_FILES_BY_CONTENT', 'LIST_DIRECTORY'];
  const responseTools = ['DISCOVERED', 'EXPLORATION_FINDINGS', 'DETAILED_PLAN', 
                        'CREATE_NEW_FILE', 'UPDATE_FILE', 'INSERT_LINES', 'DELETE_FILE',
                        'SWITCH_TO', 'COMMIT'];
  
  const hasInfoTools = tools.some(t => informationTools.includes(t.name));
  const hasResponseTools = tools.some(t => responseTools.includes(t.name));
  
  if (hasInfoTools && hasResponseTools) {
    return { 
      type: 'mixed', 
      error: 'Cannot mix information gathering tools with response/action tools'
    };
  }
  
  if (hasInfoTools) return { type: 'information' };
  if (hasResponseTools) return { type: 'response' };
  return { type: 'empty' };
}

function validateResponseType(text, tools) {
  const classification = classifyTools(tools);
  
  // Remove tool blocks and message end marker
  const responseContent = text
    .replace(/@\w+\s*\{[^}]*\}/gs, '')
    .replace(/\[\[\[MESSAGE_END\]\]\]/g, '')
    .trim();
  
  // Check for substantial content (more than just whitespace)
  const hasContent = responseContent.length > 10;
  
  switch (classification.type) {
    case 'mixed':
      return { 
        valid: false, 
        error: classification.error 
      };
      
    case 'information':
      if (hasContent) {
        return { 
          valid: false, 
          error: 'Information gathering responses cannot contain text. Use tools only.' 
        };
      }
      return { valid: true, type: 'information' };
      
    case 'response':
      // Response type can have content or not
      return { valid: true, type: 'response' };
      
    case 'empty':
      // No tools - must be a pure text response
      if (!hasContent) {
        return { 
          valid: false, 
          error: 'Response must contain either tools or text content' 
        };
      }
      return { valid: true, type: 'text' };
  }
}

function replaceToolsWithIndicators(text, tools) {
  let result = text;
  
  // Sort tools by start index in reverse order so we can replace from end to beginning
  const sortedTools = tools.slice().sort(function(a, b) { return b.startIndex - a.startIndex; });
  
  for (let i = 0; i < sortedTools.length; i++) {
    const tool = sortedTools[i];
    let indicator = '';
    
    switch (tool.name) {
      case 'LIST_DIRECTORY':
        indicator = '--> List directory: ' + (tool.params.path || '.') +
          (tool.params.explanation ? ' (' + tool.params.explanation + ')' : '');
        break;
      case 'READ_FILE':
        indicator = '--> Read file: ' + tool.params.file_name + 
          (tool.params.explanation ? ' (' + tool.params.explanation + ')' : '');
        break;
      case 'SEARCH_FILES_BY_NAME':
        indicator = '--> Search files by name: ' + tool.params.regex + ' in ' + tool.params.folder +
          (tool.params.explanation ? ' (' + tool.params.explanation + ')' : '');
        break;
      case 'SEARCH_FILES_BY_CONTENT':
        indicator = '--> Search files by content: ' + tool.params.regex + ' in ' + tool.params.folder +
          (tool.params.explanation ? ' (' + tool.params.explanation + ')' : '');
        break;
      case 'CREATE_NEW_FILE':
        indicator = '--> Create file: ' + tool.params.path;
        break;
      case 'UPDATE_FILE':
        indicator = '--> Update file: ' + tool.params.file_name + ' (lines ' + tool.params.start_line + '-' + tool.params.end_line + ')';
        break;
      case 'INSERT_LINES':
        indicator = '--> Insert lines: ' + tool.params.file_name + ' at line ' + tool.params.line_number;
        break;
      case 'DELETE_FILE':
        indicator = '--> Delete file: ' + tool.params.file_name;
        break;
      case 'DISCOVERED':
        indicator = '--> Discovery (importance ' + tool.params.importance + '): ' + tool.params.content;
        break;
      case 'SWITCH_TO':
        indicator = '--> Switch to ' + tool.params.mode + ' mode';
        break;
      case 'EXPLORATION_FINDINGS':
        indicator = '--> Save exploration findings: ' + (tool.params.name || 'findings');
        break;
      case 'DETAILED_PLAN':
        indicator = '--> Save implementation plan: ' + (tool.params.name || 'plan');
        break;
      case 'COMMIT':
        indicator = '--> Commit changes';
        break;
      default:
        indicator = '--> ' + tool.name + ' tool used';
    }
    
    result = result.slice(0, tool.startIndex) + indicator + result.slice(tool.endIndex);
  }
  
  return result;
}

function hasMessageEnd(text) {
  return text.includes('[[[MESSAGE_END]]]');
}

function validateMessageFormat(text) {
  if (!hasMessageEnd(text)) {
    throw new Error('Invalid format: Missing [[[MESSAGE_END]]]');
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
  
  // Find conversation exchanges (USER: and ASSISTANT: pairs)
  const exchanges = [];
  let currentExchange = { user: '', assistant: '', other: [] };
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    
    if (line.startsWith('USER: ')) {
      // Start new exchange
      if (currentExchange.user || currentExchange.assistant.length > 0) {
        exchanges.push(currentExchange);
      }
      currentExchange = { user: line, assistant: '', other: [] };
    } else if (line.startsWith('ASSISTANT: ')) {
      currentExchange.assistant = line;
    } else if (line.startsWith('TOOL RESULT') || line.startsWith('SYSTEM:') || line.startsWith('-->')) {
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
      decisions.push('User requested: ' + userText.replace('USER: ', ''));
    }
    
    if (assistantText.includes('--> Switch to') || assistantText.includes('mode')) {
      decisions.push('Mode change: ' + assistantText.replace('ASSISTANT: ', '').split('\n')[0]);
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
  hasMessageEnd: hasMessageEnd,
  searchFilesByName: searchFilesByName,
  searchFilesByContent: searchFilesByContent,
  calculateImportanceWeight: calculateImportanceWeight,
  compactDiscoveries: compactDiscoveries,
  compactConversation: compactConversation,
  calculatePromptLength: calculatePromptLength,
  getLineCount: getLineCount,
  countFilesInDir: countFilesInDir,
  getCodebasePath: getCodebasePath
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
    let conversationHistory = '';
    if (historyIndex !== -1 && historyIndex + 1 < lines.length) {
      conversationHistory = lines.slice(historyIndex + 1).join('\n').trim();
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
    prompt += '\n\nGenerate your response as the assistant. Remember to end with [[[MESSAGE_END]]].';
    
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

module.exports = { buildPrompt: buildPrompt };

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
    if (typeValidation.type === 'information') {
      await handleInformationResponse(responseText, tools);
    } else {
      await handleResponseWithActions(responseText, tools);
    }
    
  } catch (err) {
    console.error('Error processing response:', err);
  }
}

async function handleResponseTypeError(errorMessage, responseText) {
  // Don't add the invalid response to conversation
  
  const errorResponse = 'SYSTEM ERROR: ' + errorMessage + '\n\n' +
    'Response Type Rules:\n' +
    '1. Information Gathering: Use ONLY read/search/list tools, NO text\n' +
    '2. Response/Action: Use text and/or action tools, NO read/search/list tools\n\n' +
    'Your last response violated these rules. Please try again with the correct response type.';
  
  await updateConversation(errorResponse);
  await fs.writeFile('ai-response.md', '', 'utf8');
  
  const buildPrompt = require('./message-to-prompt').buildPrompt;
  await buildPrompt();
  console.log('✓ Error prompt ready in generated-prompt.md');
}

async function handleInformationResponse(responseText, tools) {
  // For information gathering, just add the indicators to conversation
  const cleanResponse = utils.replaceToolsWithIndicators(responseText, tools);
  await updateConversation('ASSISTANT: ' + cleanResponse);
  
  // Process all information gathering tools
  for (let i = 0; i < tools.length; i++) {
    const tool = tools[i];
    const result = await executeTool(tool);
    
    // Add tool result to conversation
    const resultText = typeof result === 'string' ? result : JSON.stringify(result);
    await updateConversation('TOOL RESULT (' + tool.name + '): ' + resultText);
  }
  
  // Clear response and build next prompt
  await fs.writeFile('ai-response.md', '', 'utf8');
  const buildPrompt = require('./message-to-prompt').buildPrompt;
  await buildPrompt();
  console.log('✓ Information gathering complete, next prompt ready');
}

async function handleResponseWithActions(responseText, tools) {
  // Replace tool calls with readable indicators in conversation
  const cleanResponse = utils.replaceToolsWithIndicators(responseText, tools);
  await updateConversation('ASSISTANT: ' + cleanResponse);
  
  // Separate tool types
  const specialTools = tools.filter(function(t) {
    return t.name === 'DISCOVERED' || t.name === 'SWITCH_TO' || 
           t.name === 'EXPLORATION_FINDINGS' || t.name === 'DETAILED_PLAN';
  });
  
  const fileTools = tools.filter(function(t) {
    return t.name === 'CREATE_NEW_FILE' || t.name === 'UPDATE_FILE' || 
           t.name === 'INSERT_LINES' || t.name === 'DELETE_FILE';
  });
  
  // Handle special tools first
  for (let i = 0; i < specialTools.length; i++) {
    const tool = specialTools[i];
    await handleSpecialTool(tool);
  }
  
  // Handle file operation tools
  for (let i = 0; i < fileTools.length; i++) {
    const tool = fileTools[i];
    const result = await executeTool(tool);
    
    if (tool.name === 'UPDATE_FILE' || tool.name === 'INSERT_LINES') {
      await requestFileConfirmation(tool, result);
      return; // Wait for confirmation
    }
    
    // Add tool result to conversation
    const resultText = typeof result === 'string' ? result : JSON.stringify(result);
    await updateConversation('TOOL RESULT (' + tool.name + '): ' + resultText);
  }
  
  await fs.writeFile('ai-response.md', '', 'utf8');
  const buildPrompt = require('./message-to-prompt').buildPrompt;
  await buildPrompt();
  console.log('✓ Response processed, next prompt ready');
}

async function handleFormatError(errorMessage) {
  const responseText = await utils.readFileIfExists('ai-response.md');
  
  // Add the malformed response to conversation so AI can see what went wrong
  await updateConversation('ASSISTANT: ' + responseText);
  
  const errorResponse = 'SYSTEM ERROR: ' + errorMessage + '\n\nPlease fix your response format. Remember to end with [[[MESSAGE_END]]].';
  
  await updateConversation(errorResponse);
  await fs.writeFile('ai-response.md', '', 'utf8');
  
  const buildPrompt = require('./message-to-prompt').buildPrompt;
  await buildPrompt();
  console.log('✓ Error prompt ready in generated-prompt.md');
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
    case 'LIST_DIRECTORY':
      return await executeListDirectory(tool.params);
    case 'READ_FILE':
      return await executeReadFile(tool.params);
    case 'SEARCH_FILES_BY_NAME':
      return await executeSearchFilesByName(tool.params);
    case 'SEARCH_FILES_BY_CONTENT':
      return await executeSearchFilesByContent(tool.params);
    case 'CREATE_NEW_FILE':
      return await executeCreateFile(tool.params);
    case 'UPDATE_FILE':
      return await executeUpdateFile(tool.params);
    case 'INSERT_LINES':
      return await executeInsertLines(tool.params);
    case 'DELETE_FILE':
      return await executeDeleteFile(tool.params);
    default:
      return 'Unknown tool: ' + tool.name;
  }
}

async function executeListDirectory(params) {
  try {
    const dirPath = utils.getCodebasePath(params.path || '.');
    const entries = await fs.readdir(dirPath, { withFileTypes: true });
    
    const dirs = [];
    const files = [];
    
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      if (entry.name.startsWith('.')) continue;
      
      if (entry.isDirectory()) {
        const subPath = path.join(dirPath, entry.name);
        const fileCount = await utils.countFilesInDir(subPath);
        dirs.push(entry.name + '/ (' + fileCount + ' files)');
      } else {
        const filePath = path.join(dirPath, entry.name);
        const lineCount = await utils.getLineCount(filePath);
        files.push(entry.name + ' (' + lineCount + ' lines)');
      }
    }
    
    let result = 'Contents of ' + (params.path || '.') + ':\n';
    if (dirs.length > 0) {
      result += 'Directories:\n';
      for (let i = 0; i < dirs.length; i++) {
        result += '  ' + dirs[i] + '\n';
      }
    }
    if (files.length > 0) {
      result += 'Files:\n';
      for (let i = 0; i < files.length; i++) {
        result += '  ' + files[i] + '\n';
      }
    }
    
    if (dirs.length === 0 && files.length === 0) {
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
    await fs.writeFile(filePath, params.contents, 'utf8');
    
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
    await updateConversation('TOOL RESULT (' + tool.name + '): ' + result);
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
  
  const confirmation = 'PENDING UPDATE for ' + tool.params.file_name + '\nDESCRIPTION: ' + description + '\n\nORIGINAL CODE (lines ' + (previewStart + 1) + '-' + (changeStart + 1) + '):\n' + originalPreview.join('\n') + '\n\nNEW CODE (lines ' + (previewStart + 1) + '-' + (previewEnd + 1) + '):\n' + modifiedPreview.join('\n') + '\n\nReply with @COMMIT to apply, or send new @UPDATE_FILE/@INSERT_LINES for this file.';
  
  const pendingData = {
    file: tool.params.file_name,
    filePath: filePath,
    originalContent: originalContent,
    modifiedContent: modifiedContent,
    description: description,
    changes: [tool]
  };
  
  await fs.writeFile('pending-changes.json', JSON.stringify(pendingData, null, 2), 'utf8');
  
  await updateConversation('SYSTEM: ' + confirmation);
  await fs.writeFile('ai-response.md', '', 'utf8');
  
  const buildPrompt = require('./message-to-prompt').buildPrompt;
  await buildPrompt();
  console.log('✓ Confirmation prompt ready in generated-prompt.md');
  
  console.log('⚠ File operation pending confirmation: ' + tool.params.file_name);
}

async function handlePendingUpdate(responseText) {
  const pendingData = JSON.parse(await fs.readFile('pending-changes.json', 'utf8'));
  
  // Check for @COMMIT tool in the new format
  const tools = utils.parseToolBlocks(responseText);
  const commitTool = tools.find(function(t) { return t.name === 'COMMIT'; });
  
  if (commitTool || responseText.includes('COMMIT')) {
    // Add the commit response to conversation first
    await updateConversation('ASSISTANT: ' + responseText);
    
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
    await updateConversation('ASSISTANT: ' + responseText);
    
    const fileOps = tools.filter(function(t) {
      return t.name === 'UPDATE_FILE' || t.name === 'INSERT_LINES';
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
      await updateConversation('SYSTEM: Invalid response to pending update. Please use @COMMIT or provide corrected @UPDATE_FILE/@INSERT_LINES for ' + pendingData.file);
      
      const buildPrompt = require('./message-to-prompt').buildPrompt;
      await buildPrompt();
      console.log('✓ Error prompt ready in generated-prompt.md');
    }
  }
}

async function updateConversation(newMessage) {
  const conversation = await utils.readFileIfExists('conversation.md');
  
  const lines = conversation.split('\n');
  const historyIndex = lines.findIndex(function(line) { return line.includes('=== CONVERSATION HISTORY ==='); });
  
  if (historyIndex === -1) {
    const updated = '=== WAITING FOR YOUR MESSAGE ===\n[write here when ready]\n\n=== CONVERSATION HISTORY ===\n' + newMessage;
    await fs.writeFile('conversation.md', updated, 'utf8');
  } else {
    const before = lines.slice(0, historyIndex + 1);
    const after = lines.slice(historyIndex + 1);
    
    const updated = ['=== WAITING FOR YOUR MESSAGE ===', '[write here when ready]', ''].concat(before.slice(historyIndex)).concat([newMessage]).concat(after);
    
    await fs.writeFile('conversation.md', updated.join('\n'), 'utf8');
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
  
  if (historyIndex !== -1) {
    const before = lines.slice(0, historyIndex + 1);
    const after = lines.slice(historyIndex + 1);
    
    const updated = ['=== WAITING FOR YOUR MESSAGE ===', '[write here when ready]', ''].concat(before.slice(historyIndex)).concat(['USER: ' + message]).concat(after);
    
    await require('fs').promises.writeFile('conversation.md', updated.join('\n'), 'utf8');
    console.log('✓ Moved user message to history');
  }
}

async function createInitialFiles() {
  const initialFiles = {
    'conversation.md': '=== WAITING FOR YOUR MESSAGE ===\n[write here when ready]\n\n=== CONVERSATION HISTORY ===',
    'mode.md': 'x exploration\n  planning\n  implementation',
    'goals.md': '# Project Goals\n\nAdd your high-level objectives here',
    'ai-response.md': '',
    'generated-prompt.md': '',
    'prompts/base.md': '# Base prompt template - create this file with tool format documentation',
    'prompts/exploration.md': '# EXPLORATION MODE\n\nYour job is to understand the codebase and requirements:\n\n- Use LIST_DIRECTORY to explore project structure\n- Use READ_FILE to examine key files\n- Use SEARCH_FILES_BY_NAME and SEARCH_FILES_BY_CONTENT to discover patterns\n- Ask clarifying questions about requirements  \n- Document findings with DISCOVERED blocks (importance 1-10)\n- When you have sufficient understanding, create/update exploration findings using:\n\nEXPLORATION_FINDINGS: [[[START]]]\n# Key Findings\n\n## Architecture\n- Current system uses X framework\n- Database is Y with Z schema\n\n## Key Issues\n- Problem 1: description\n- Problem 2: description\n\n## Recommendations\n- Next steps for implementation\n[[[END]]]\n\n- Recommend "SWITCH_TO: planning" when ready\n\nFocus on understanding, not solving yet. Be thorough in your exploration.',
    'prompts/planning.md': '# PLANNING MODE\n\nYour job is to create a detailed implementation plan:\n\n- Review the exploration findings to understand the current state\n- Ask final clarifying questions before implementation  \n- Break down work into specific, concrete tasks with file changes\n- Create detailed-plan.md with step-by-step implementation tasks\n- Each task should specify exactly which files to modify and how\n- Recommend "SWITCH_TO: implementation" when plan is complete\n\nBe thorough - implementation should have no surprises.',
    'prompts/implementation.md': '# IMPLEMENTATION MODE\n\nYour job is to execute the implementation plan:\n\n- Follow the detailed-plan.md exactly as specified\n- Use UPDATE_FILE, INSERT_LINES, CREATE_NEW_FILE tools to make changes\n- Include descriptive change_description for all file operations  \n- Work through plan items systematically\n- If you hit unexpected issues: "SWITCH_TO: exploration"\n- Focus on execution, not replanning'
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
          await fs.writeFile(file, '=== WAITING FOR YOUR MESSAGE ===\n[write here when ready]\n\n=== CONVERSATION HISTORY ===', 'utf8');
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
