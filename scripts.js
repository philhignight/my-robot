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
    'generated-prompt.md': ''
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
    
    const lines = content.split('\n');
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
  
  const confirmation = 'SYSTEM: PENDING UPDATE for ' + tool.params.file_name + '\nDESCRIPTION: ' + description + '\n\nORIGINAL CODE (lines ' + (previewStart + 1) + '-' + (originalEnd + 1) + '):\n' + originalPreview.join('\n') + '\n\nNEW CODE (lines ' + (previewStart + 1) + '-' + (previewEnd + 1) + '):\n' + modifiedPreview.join('\n') + '\n\nReply with [COMMIT] to apply changes.';
  
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

const fs = require('fs').promises;
const utils = require('./utils');
const { generatePrompt } = require('./prompt-generator');

async function executeTwoLevelList(params) {
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
        const subPath = require('path').join(dir, dirName);
        
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
        const filePath = require('path').join(dir, fileName);
        const ext = require('path').extname(fileName).toLowerCase();
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

async function buildPrompt() {
  try {
    await utils.ensureDir('ai-managed');
    
    const mode = utils.getActiveMode(await utils.readFileIfExists('mode.md'));
    const goals = await utils.readFileIfExists('goals.md');
    const context = await utils.readFileIfExists('ai-managed/context.md');
    const conversation = await utils.readFileIfExists('conversation.md');
    
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
    if (conversationHistory.length > 30000) {
      console.log('📝 Compacting conversation history...');
      conversationHistory = utils.compactConversation(conversationHistory, 30000);
      console.log('✓ Conversation compacted');
    }
    
    // Generate the prompt using the new prompt generator
    const prompt = generatePrompt({
      mode: mode,
      goals: goals,
      projectStructure: projectStructure,
      additionalContext: context,
      conversationHistory: conversationHistory
    });
    
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

const utils = require('./utils');

// Base prompt that's always included
const BASE_PROMPT = `# AI Development Assistant Base Prompt

You are an AI development assistant helping with requirements analysis and code analysis, planning, and implementation. You work in three distinct modes and have access to powerful tools for file operations.

## Instructions
 
1) Think about the below requirements, so you have a response in mind (don't write it yet)
  - Your response must either be READ or WRITE response type
  - ALL your output must be tool uses based on the below format
  - No text is allowed before/after/between tool uses
2) Write "┌─ ASSISTANT ─────────────────────────────────────────────────────────┐" to your output
3) Write your response
  - Start each line with "│ "
  - Put your response into 68 character lines (content only)
  - For wrapping, show by starting the continuation line with "... "
  - Pad with spaces to 68 characters if needed
  - End each line with "│"
  - Total line width will be exactly 70 characters including borders
4) Write "└─────────────────────────────────────────────────────────────────────┘" to end your output

## CRITICAL: MESSAGE FORMAT

**You MUST wrap your entire response in an ASCII box like this:**

\`\`\`
┌─ ASSISTANT ─────────────────────────────────────────────────────────┐
│ [MESSAGE]                                                           │
│ Your message content here, wrapped at 70 characters for             │
│ ... readability. Long lines will automatically wrap with "..."      │
│                                                                     │
│ [LIST] .                                                            │
│ Getting project overview                                            │
│                                                                     │
│ [SEARCH_NAME] .*very-long-pattern-that-exceeds-width.*$ src/folder  │
│ ... /with/very/long/path                                            │
│ Searching for files with extremely long regex patterns              │
└─────────────────────────────────────────────────────────────────────┘
\`\`\`

**IMPORTANT: The box must be exactly 70 characters wide. Use "..." at the start of wrapped lines.**

## RESPONSE TYPE RULES

Complete these tasks:

#1 Decide if you need to READ or WRITE to complete the next assistant message, then choose the corresponding response type.

Tools allowed in the READ response type:
- [LIST]
- [READ]
- [SEARCH_NAME]
- [SEARCH_CONTENT]

Tools allowed in the WRITE response type: `;

// Mode-specific configurations
const MODE_CONFIGS = {
  exploration: {
    writeTools: ['MESSAGE', 'DISCOVERED', 'EXPLORATION_FINDINGS', 'SWITCH_TO_PLANNING'],
    modeInstructions: `# EXPLORATION MODE

Your job is to understand the codebase and requirements:

- Use LIST to explore project structure
- Use READ to examine key files
- Use SEARCH_NAME and SEARCH_CONTENT to discover patterns
- Use MESSAGE to ask clarifying questions or provide updates
- Document findings with DISCOVERED blocks (importance 1-10)
- When you have sufficient understanding, create exploration findings
- Use SWITCH_TO_PLANNING when ready to create an implementation plan

Remember: NO plain text allowed outside of tools. Use [MESSAGE] for all communication.

Focus on understanding, not solving yet. Be thorough in your exploration.`
  },
  planning: {
    writeTools: ['MESSAGE', 'DISCOVERED', 'DETAILED_PLAN', 'SWITCH_TO_EXPLORATION', 'SWITCH_TO_IMPLEMENTATION'],
    modeInstructions: `# PLANNING MODE

Your job is to create a detailed implementation plan:

- Review the exploration findings to understand the current state
- Use [MESSAGE] to ask final clarifying questions
- Break down work into specific, concrete tasks with file changes
- Create detailed-plan using [DETAILED_PLAN] tool
- Each task should specify exactly which files to modify and how
- Use [MESSAGE] to explain your plan
- Use SWITCH_TO_IMPLEMENTATION when plan is complete and ready to execute
- Use SWITCH_TO_EXPLORATION if you need more information about the codebase

Remember: NO plain text allowed. Use [MESSAGE] for all explanations.

Be thorough - implementation should have no surprises.`
  },
  implementation: {
    writeTools: ['MESSAGE', 'DISCOVERED', 'CREATE', 'UPDATE', 'INSERT', 'DELETE', 'COMMIT', 'SWITCH_TO_EXPLORATION', 'SWITCH_TO_PLANNING'],
    modeInstructions: `# IMPLEMENTATION MODE

Your job is to execute the implementation plan:

- Follow the detailed plan exactly as specified
- Use UPDATE, INSERT, CREATE tools to make changes
- Include descriptive change_description for all file operations
- Use [MESSAGE] to explain what you're doing
- Work through plan items systematically
- Use SWITCH_TO_EXPLORATION if you hit unexpected issues and need more analysis
- Use SWITCH_TO_PLANNING if the plan needs significant revision
- Focus on execution, not replanning

Remember: NO plain text allowed. Use [MESSAGE] for all communication.`
  }
};

// Tool documentation
const TOOL_DOCS = {
  // READ tools (always available)
  LIST: `**[LIST] path**
List directory contents. Path is optional (defaults to .)
\`\`\`
[LIST] src/
Exploring source directory
\`\`\``,

  READ: `**[READ] filename**
Read file contents with line numbers. You can use multiple READ commands in one response to examine multiple files efficiently.
NOTE: You can only read text files. Binary files (jar, zip, exe, images, etc.) are not allowed.
\`\`\`
[READ] package.json
Checking project dependencies

[READ] src/index.js
Examining entry point

[READ] src/config.js
Reviewing configuration
\`\`\``,

  SEARCH_NAME: `**[SEARCH_NAME] pattern folder**
Find files matching pattern
\`\`\`
[SEARCH_NAME] .*\\.js$ src/
Finding all JavaScript files
\`\`\``,

  SEARCH_CONTENT: `**[SEARCH_CONTENT] pattern folder**
Search content within files
\`\`\`
[SEARCH_CONTENT] TODO|FIXME .
Finding all TODO comments
\`\`\``,

  // WRITE tools (mode-specific)
  MESSAGE: `**[MESSAGE]**
Communicate with the user. Content continues until next tool or box end.
If your message contains tool keywords in brackets like [LIST] or [READ], end with [END_MESSAGE].
\`\`\`
[MESSAGE]
I found several issues in your code.
Let me explain what needs fixing.
\`\`\``,

  DISCOVERED: `**[DISCOVERED] importance**
Document finding (importance 1-10)
\`\`\`
[DISCOVERED] 9
Critical security issue: passwords stored in plain text
\`\`\``,

  EXPLORATION_FINDINGS: `**[EXPLORATION_FINDINGS] name**
Save exploration findings
\`\`\`
[EXPLORATION_FINDINGS] auth-analysis
# Authentication System Analysis
- Uses Express sessions
- No password hashing
- Missing rate limiting
\`\`\``,

  DETAILED_PLAN: `**[DETAILED_PLAN] name**
Save implementation plan
\`\`\`
[DETAILED_PLAN] security-fixes
# Security Implementation Plan
1. Add bcrypt for passwords
2. Implement rate limiting
3. Add input validation
\`\`\``,

  CREATE: `**[CREATE] filepath**
Create new file. Optional description with #, then content.
\`\`\`
[CREATE] src/utils/auth.js
# Authentication utility functions
const bcrypt = require('bcrypt');

function hashPassword(pwd) {
  return bcrypt.hash(pwd, 10);
}
\`\`\``,

  UPDATE: `**[UPDATE] filename start_line end_line**
Replace lines in file. Description with #, then new content.
\`\`\`
[UPDATE] src/auth.js 10 15
# Add password hashing before saving user
  const hashed = await hashPassword(password);
  user.password = hashed;
\`\`\``,

  INSERT: `**[INSERT] filename line_number**
Insert at line. Description with #, then content.
\`\`\`
[INSERT] src/app.js 5
# Import rate limiting middleware
const rateLimit = require('./middleware/rateLimit');
\`\`\``,

  DELETE: `**[DELETE] filename**
Delete file
\`\`\`
[DELETE] src/old-auth.js
Removing deprecated auth system
\`\`\``,

  SWITCH_TO_EXPLORATION: `**[SWITCH_TO_EXPLORATION]**
Switch back to exploration mode to gather more information
\`\`\`
[SWITCH_TO_EXPLORATION]
Need to understand the database schema before continuing
\`\`\``,

  SWITCH_TO_PLANNING: `**[SWITCH_TO_PLANNING]**
Switch to planning mode to create/revise implementation plan
\`\`\`
[SWITCH_TO_PLANNING]
Ready to create a detailed implementation plan
\`\`\``,

  SWITCH_TO_IMPLEMENTATION: `**[SWITCH_TO_IMPLEMENTATION]**
Switch to implementation mode to execute the plan
\`\`\`
[SWITCH_TO_IMPLEMENTATION]
Plan is complete, ready to start implementing
\`\`\``,

  COMMIT: `**[COMMIT]**
Confirm file changes
\`\`\`
[COMMIT]
\`\`\``
};

const PROMPT_FOOTER = `

## TERMINATION RULES

Tools auto-terminate when:
- The next tool line starts (line beginning with [TOOLNAME])
- The box closes (└─ line)

Only use [END_X] tags when:
1. [MESSAGE] contains tool keywords like [LIST], [READ], etc.
2. Multi-line content might be ambiguous

Example needing END tag:
\`\`\`
[MESSAGE]
To list files, use [LIST] with a path.
To read files, use [READ] with a filename.
[END_MESSAGE]
\`\`\`

Example NOT needing END tag:
\`\`\`
[MESSAGE]
I'll analyze your authentication system now.

[DISCOVERED] 8
Found Express.js authentication setup with session management
\`\`\`

## VALID RESPONSE EXAMPLES

### ✅ READ Response with Multiple Files
\`\`\`
┌─ ASSISTANT ─────────────────────────────────────────────────────────┐
│ [READ] package.json                                                 │
│ Checking project configuration                                      │
│                                                                     │
│ [READ] src/index.js                                                 │
│ Examining main entry point                                          │
│                                                                     │
│ [READ] src/auth.js                                                  │
│ Looking for authentication logic                                    │
└─────────────────────────────────────────────────────────────────────┘
\`\`\`

### ✅ WRITE Response (CORRECT)
\`\`\`
┌─ ASSISTANT ─────────────────────────────────────────────────────────┐
│ [MESSAGE]                                                           │
│ I found critical security issues:                                   │
│                                                                     │
│ 1. Passwords stored in plain text                                   │
│ 2. No input validation                                              │
│ 3. Missing rate limiting                                            │
│                                                                     │
│ [DISCOVERED] 9                                                      │
│ Critical: Plain text passwords in auth.js line 45. User.create()    │
│ saves req.body.password directly.                                   │
└─────────────────────────────────────────────────────────────────────┘
\`\`\`

## IMPORTANT RULES

- **Box dimensions**: Content is 68 chars wide, total box width is 70 chars
- **Complete the box**: Always close your response with the bottom border
- **Wrap long lines**: Use "..." at the start of continuation lines
- **Strict type separation**: Use only READ tools or only WRITE tools per response
- **Always include [MESSAGE]**: In WRITE responses, start with [MESSAGE] for any text
- **Use positional parameters**: Tools now use positions, not named parameters
- **Smart termination**: Tools end at next tool line or box closure
- **Progressive discovery**: Start with [LIST] at root, explore as needed
- **One file operation at a time**: For [UPDATE] and [INSERT] operations
- **Document importance**: Rate [DISCOVERED] items 1-10
- **# Description pattern**: Use # for descriptions in [CREATE], [UPDATE], [INSERT]

## WORKFLOW PATTERN

1. **User Request** → 
2. **READ Response** (gather information) → 
3. **Tool Results** → 
4. **WRITE Response** (analyze/act) → 
5. **Repeat as needed**

## DISCOVERY IMPORTANCE SCALE

- **1-3**: Minor details, code style issues
- **4-6**: Important patterns, architecture decisions
- **7-9**: Critical bugs, security issues
- **10**: Catastrophic issues (never removed from memory)`;

function generatePrompt(options) {
  const {
    mode = 'exploration',
    goals = '',
    projectStructure = '',
    additionalContext = '',
    conversationHistory = ''
  } = options;

  // Validate mode
  if (!MODE_CONFIGS[mode]) {
    throw new Error('Invalid mode: ' + mode + '. Must be exploration, planning, or implementation');
  }

  const config = MODE_CONFIGS[mode];
  
  // Build the write tools list for this mode
  let writeToolsList = '- ' + config.writeTools.join('\n- ');
  
  // Build tool documentation for this mode
  let toolDocs = '\n\n#2 Generate your response inside the ASCII box using ONLY tools from your chosen type.\n\n## TOOL FORMATS (POSITIONAL PARAMETERS)\n\n### READ Tools (Information Gathering)\n\n';
  
  // Add READ tool docs (always available)
  toolDocs += [TOOL_DOCS.LIST, TOOL_DOCS.READ, TOOL_DOCS.SEARCH_NAME, TOOL_DOCS.SEARCH_CONTENT].join('\n\n');
  
  // Add WRITE tool docs (mode-specific)
  toolDocs += '\n\n### WRITE Tools (Response and Actions)\n\n';
  const writeToolDocs = [];
  for (const tool of config.writeTools) {
    if (TOOL_DOCS[tool]) {
      writeToolDocs.push(TOOL_DOCS[tool]);
    }
  }
  toolDocs += writeToolDocs.join('\n\n');

  // Build the complete prompt
  let prompt = BASE_PROMPT + writeToolsList + toolDocs + PROMPT_FOOTER;
  
  // Add mode instructions
  prompt += '\n\n' + config.modeInstructions;
  
  // Add goals if provided
  if (goals && goals.trim() && goals.trim() !== '# Project Goals\n\nAdd your high-level objectives here') {
    prompt += '\n\nGOALS:\n' + goals.trim();
  }
  
  // Add context section
  if (projectStructure || additionalContext) {
    let contextSection = '';
    if (projectStructure) {
      contextSection = 'PROJECT STRUCTURE (2 levels):\n' + projectStructure;
    }
    if (additionalContext) {
      if (contextSection) {
        contextSection += '\n\nADDITIONAL CONTEXT:\n' + additionalContext.trim();
      } else {
        contextSection = 'CONTEXT:\n' + additionalContext.trim();
      }
    }
    prompt += '\n\n' + contextSection;
  }
  
  // Add conversation history with example
  if (conversationHistory) {
    prompt += '\n\nCONVERSATION HISTORY:\n\n> Are you ready to help?\n\nASSISTANT: yes\n\n> Your response is not in the correct format. You MUST wrap your response in an ascii box (your first output line must be "┌─ ASSISTANT ─────────────────────────────────────────────────────────┐") and you can ONLY use tool uses, not free form text.\n\n┌─ ASSISTANT ─────────────────────────────────────────────────────────┐\n│ [MESSAGE]                                                           │\n│ Here\'s another message in your specified format. Is this correct?   │\n└─────────────────────────────────────────────────────────────────────┘\n\n> yes\n\n┌─ ASSISTANT ─────────────────────────────────────────────────────────┐\n│ [MESSAGE]                                                           │\n│ How can I help you?                                                 │\n└─────────────────────────────────────────────────────────────────────┘\n\n' + conversationHistory;
  }
  
  // Add final instructions
  prompt += '\n\nGenerate your response as the assistant.';
  prompt += '\n\nFINAL REMINDER: The first line of your response must be "┌─ ASSISTANT ─────────────────────────────────────────────────────────┐" and your responses can only contain tool uses, no plain text messages';
  
  return prompt;
}

module.exports = { generatePrompt };
