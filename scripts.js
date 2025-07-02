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
    case 'READ':
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

// message-to-prompt.js

const fs = require('fs').promises;
const utils = require('./utils');
const { generatePrompt } = require('./prompt-generator');
const { allocatePromptBudget, buildPromptFromAllocations } = require('./prompt-budget-allocator');

async function executeTwoLevelRead(params) {
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
    const discoveries = await utils.readFileIfExists('ai-managed/discoveries.md');
    const conversation = await utils.readFileIfExists('conversation.md');
    const explorationFindings = await utils.readFileIfExists('ai-managed/exploration-findings.md');
    const detailedPlan = await utils.readFileIfExists('ai-managed/detailed-plan.md');
    
    // Generate 2-level directory listing
    const readTool = {
      name: 'READ',
      params: { path: '.', maxDepth: 2 }
    };
    const projectStructure = await executeTwoLevelRead(readTool.params);
    
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
    
    // Generate base prompt
    const basePrompt = generatePrompt({
      mode: mode,
      goals: '',  // We'll handle these through the allocator
      projectStructure: '',  // We'll handle these through the allocator
      additionalContext: '',  // We'll handle these through the allocator
      conversationHistory: ''  // We'll handle these through the allocator
    });
    
    // Prepare inputs for budget allocator
    const inputs = {
      basePrompt: basePrompt,
      conversation: conversationHistory,
      discoveries: discoveries,
      projectStructure: projectStructure,
      goals: goals,
      additionalContext: context,
      explorationFindings: explorationFindings,
      detailedPlan: detailedPlan
    };
    
    // Allocate budget optimally
    const allocation = allocatePromptBudget(inputs, mode, new Date());
    
    // Build final prompt from allocations
    const prompt = buildPromptFromAllocations(allocation.allocations, mode);
    
    await fs.writeFile('generated-prompt.md', prompt, 'utf8');
    
    console.log('✓ Built prompt for ' + mode + ' mode');
    console.log('📊 Budget usage: ' + allocation.totalUsed.toLocaleString() + ' / ' + allocation.budget.toLocaleString() + ' characters (' + Math.round(allocation.totalUsed / allocation.budget * 100) + '%)');
    
    // Log what was included/excluded
    for (const [category, alloc] of Object.entries(allocation.allocations)) {
      if (alloc.excluded && alloc.excluded.length > 0) {
        console.log('  ⚠ ' + category + ': included ' + alloc.content.length + ' chars, excluded ' + alloc.excluded.length + ' items');
      }
    }
    
    if (prompt.length > 600000) {
      console.log('⚠ Warning: Prompt exceeds 600k character limit!');
    }
    
  } catch (err) {
    console.error('Error building prompt:', err);
  }
}

module.exports = { buildPrompt: buildPrompt };

// ==========================================

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
    case 'READ':
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
  const informationTools = ['READ', 'SEARCH_NAME', 'SEARCH_CONTENT'];
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
      // Content line - ensure proper padding (66 chars for content + 4 for borders = 70)
      const content = line.substring(1).replace(/\s*│\s*$/, '');
      const paddedContent = content + ' '.repeat(Math.max(0, 66 - content.length));
      fixedLines.push('│ ' + paddedContent + ' │');
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

// prompt-generator.js

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
│ [READ] .                                                            │
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

- Use READ to explore project structure and examine files
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
  READ: `**[READ] path**
Read file contents or list directory contents. Path defaults to current directory (.).
For files: shows content with line numbers. For directories: shows file tree.
You can use multiple READ commands in one response to examine multiple items efficiently.
NOTE: You can only read text files. Binary files (jar, zip, exe, images, etc.) are not allowed.
\`\`\`
[READ] .
List current directory contents

[READ] src/
List src directory contents

[READ] package.json
Read package.json file

[READ] src/index.js
Read the main entry point

[READ] src/config.js
Reviewing configuration
\`\`\``,

  SEARCH_NAME: `**[SEARCH_NAME] pattern folder**
Find files matching pattern. Use quotes for patterns with spaces. Escape quotes with backslash.
\`\`\`
[SEARCH_NAME] .*\\.js$ src/
Finding all JavaScript files

[SEARCH_NAME] "test.*\\.spec\\.js$" tests/
Finding test spec files with spaces in pattern

[SEARCH_NAME] "\\"quoted\\" file.*" .
Finding files with quotes in the name
\`\`\``,

  SEARCH_CONTENT: `**[SEARCH_CONTENT] pattern folder**
Search content within files. Use quotes for patterns with spaces or special characters. Escape quotes with backslash.
\`\`\`
[SEARCH_CONTENT] TODO|FIXME .
Finding all TODO comments

[SEARCH_CONTENT] "package com\\.example" src/
Searching for package declarations with dots

[SEARCH_CONTENT] "const\\s+myVar\\s*=" src/
Finding const declarations with spaces

[SEARCH_CONTENT] "console\\.log\\(\\"Hello\\"\\)" .
Finding console.log with quoted strings
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
To read files or directories, use [READ] with a path.
To search by name, use [SEARCH_NAME] with a pattern.
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
- **Progressive discovery**: Start with [READ] . at root, explore as needed
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
  
  // Tool documentation rebuild to include READ-specific docs
  let toolDocs = '\n\n#2 Generate your response inside the ASCII box using ONLY tools from your chosen type.\n\n## TOOL FORMATS (POSITIONAL PARAMETERS)\n\n### READ Tools (Information Gathering)\n\n';
  
  // Add READ tool docs (always available)
  toolDocs += [TOOL_DOCS.READ, TOOL_DOCS.SEARCH_NAME, TOOL_DOCS.SEARCH_CONTENT].join('\n\n');
  
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
