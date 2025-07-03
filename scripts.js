// message-to-prompt.js
// message-to-prompt.js

const fs = require('fs').promises;
const path = require('path');
const utils = require('./utils');
const { generatePrompt } = require('./prompt-generator');
const { allocatePromptBudget, buildPromptFromAllocations } = require('./prompt-budget-allocator');

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

async function buildPrompt(extractionMode = false) {
  try {
    await utils.ensureDir('ai-managed');
    
    // Check for unresolved temporary blocks
    const conversation = await utils.readFileIfExists('conversation.md');
    const tempBlock = utils.findTemporaryBlock(conversation);
    
    if (tempBlock.found && !extractionMode) {
      // We have a temporary block, build extraction prompt instead
      return buildExtractionPrompt(tempBlock);
    }
    
    const mode = utils.getActiveMode(await utils.readFileIfExists('mode.md'));
    const goals = await utils.readFileIfExists('goals.md');
    const context = await utils.readFileIfExists('ai-managed/context.md');
    const discoveries = await utils.readFileIfExists('ai-managed/discoveries.md');
    const explorationFindings = await utils.readFileIfExists('ai-managed/exploration-findings.md');
    const detailedPlan = await utils.readFileIfExists('ai-managed/detailed-plan.md');
    
    // Generate 2-level directory listing
    const readTool = {
      name: 'READ_CODE',
      params: { path: '.', maxDepth: 2 }
    };
    const projectStructure = await executeTwoLevelList(readTool.params);
    
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
                 !line.includes('Copy the contents of generated-prompt.md') &&
                 !line.includes('[write here when ready]');
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
    let prompt = buildPromptFromAllocations(allocation.allocations, mode);
    
    // Normalize multiple newlines to single newline
    prompt = prompt.replace(/\n{2,}/g, '\n');
    
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

async function buildExtractionPrompt(tempBlock) {
  try {
    console.log('✓ Building extraction prompt for: ' + tempBlock.title);
    
    // Get current context
    const mode = utils.getActiveMode(await utils.readFileIfExists('mode.md'));
    const goals = await utils.readFileIfExists('goals.md');
    const conversation = await utils.readFileIfExists('conversation.md');
    
    // Count total temporary blocks (but only include first in prompt)
    const allTempBlocks = [];
    const lines = conversation.split('\n');
    let currentSearchLine = 0;
    
    while (currentSearchLine < lines.length) {
      const remainingConversation = lines.slice(currentSearchLine).join('\n');
      const block = utils.findTemporaryBlock(remainingConversation);
      if (!block.found) break;
      
      // Adjust line numbers to be relative to full conversation
      block.startLine += currentSearchLine;
      block.endLine += currentSearchLine;
      allTempBlocks.push(block);
      
      // Move search position past this block
      currentSearchLine = block.endLine + 1;
    }
    
    // Find which block number this is
    const blockNumber = allTempBlocks.findIndex(b => b.startLine === tempBlock.startLine) + 1;
    const totalBlocks = allTempBlocks.length;
    
    // Determine the type of content from the title
    const isDirectory = tempBlock.title.includes('Contents of ');
    const isSearchResult = tempBlock.title === 'Search results';
    const isFileContent = tempBlock.title === 'File contents';
    const isSingleFile = !isFileContent && !isDirectory && !isSearchResult && (tempBlock.title.includes('.') || tempBlock.title.includes('Content of '));
    
    // Try to determine search type from content
    let searchType = null;
    if (isSearchResult) {
      // Check file paths in search results
      const codeExtensions = ['.js', '.jsx', '.ts', '.tsx', '.py', '.java', '.c', '.cpp', '.cs', '.rb', '.go', '.php'];
      const reqExtensions = ['.md', '.txt', '.rst', '.adoc'];
      
      let hasCodeFiles = false;
      let hasReqFiles = false;
      
      // Look for file paths before "(lines" markers
      const filePathMatches = tempBlock.content.match(/[^\s]+\.(js|jsx|ts|tsx|py|java|c|cpp|cs|rb|go|php|md|txt|rst|adoc)\s+\(lines/gi) || [];
      
      for (const match of filePathMatches) {
        const lowerMatch = match.toLowerCase();
        if (codeExtensions.some(ext => lowerMatch.includes(ext))) hasCodeFiles = true;
        if (reqExtensions.some(ext => lowerMatch.includes(ext))) hasReqFiles = true;
      }
      
      if (hasCodeFiles && !hasReqFiles) searchType = 'code';
      else if (hasReqFiles && !hasCodeFiles) searchType = 'requirements';
      else searchType = 'mixed';
    }
    
    // Try to determine if it's code or requirements based on file extension
    let isCode = true; // Default to code
    if (isSingleFile) {
      const docExtensions = ['.md', '.txt', '.rst', '.doc', '.docx', '.pdf'];
      const hasDocExtension = docExtensions.some(ext => tempBlock.title.toLowerCase().includes(ext));
      if (hasDocExtension) {
        isCode = false;
      }
    }
    
    // Build the extraction prompt
    let prompt = `# Data Extraction Task (Block ${blockNumber} of ${totalBlocks})

You are reviewing data from ${isDirectory ? 'a directory listing' : isFileContent ? 'multiple files' : isSingleFile ? 'a file' : 'search results'} to extract relevant information.

## Instructions

1) Review the data below and extract information relevant to your current task
2) Think of this as asking yourself a question about the data and writing your response
3) Be thorough but concise - extract the most important information rather than copying large sections verbatim
4) You won't see this data again, so capture everything you might need
5) Just write your extraction as plain text - no formatting or tools needed
6) This is block ${blockNumber} of ${totalBlocks} - there ${totalBlocks > 1 ? 'are more blocks to process' : 'is only this block'}

## Current Context

MODE: ${mode}

`;

    // Add goals if not default
    if (goals && goals.trim() && goals.trim() !== '# Project Goals\n\nAdd your high-level objectives here') {
      prompt += 'GOALS:\n' + goals.trim() + '\n\n';
    }
    
    // Add recent conversation context (last 5 exchanges) - EXCLUDE temporary blocks but KEEP summaries
    const conversationLines = conversation.split('\n');
    const exchanges = [];
    let currentExchange = [];
    let inAssistantBox = false;
    let inTempBlock = false;
    
    for (let i = conversationLines.length - 1; i >= 0; i--) {
      const line = conversationLines[i];
      
      // Skip the waiting message lines
      if (line.includes('=== WAITING FOR YOUR MESSAGE ===') || 
          line === '[write here when ready]') {
        continue;
      }
      
      // Track temporary block state - skip content but not the line itself
      if (line.includes('╚═') && !line.includes('╚═══')) { // Single line closing
        if (inTempBlock) {
          inTempBlock = false;
          continue;
        }
      }
      if (line.includes('╔═ TEMPORARY:')) {
        inTempBlock = true;
        continue;
      }
      if (inTempBlock) {
        continue;
      }
      
      if (line.startsWith('> ') && !inAssistantBox && currentExchange.length > 0) {
        exchanges.push(currentExchange.reverse().join('\n'));
        currentExchange = [];
        if (exchanges.length >= 5) break; // Get more context
      }
      
      currentExchange.push(line);
      
      if (line.includes('└─') && i > 0 && conversationLines[i-1].includes('│')) {
        inAssistantBox = true;
      } else if (line.includes('┌─ ASSISTANT')) {
        inAssistantBox = false;
      }
    }
    
    if (currentExchange.length > 0 && exchanges.length < 3) {
      exchanges.push(currentExchange.reverse().join('\n'));
    }
    
    if (exchanges.length > 0) {
      prompt += 'RECENT CONTEXT:\n' + exchanges.reverse().join('\n\n') + '\n\n';
    }
    
    // Add extraction guidelines based on content type
    if (isDirectory) {
      prompt += `## Directory Extraction Guidelines

From the directory listing, extract ONLY information relevant to your current task:
- File paths you need to examine for your specific objective
- Patterns in file organization that relate to your task
- Notable subdirectories relevant to what you're working on
- Any unexpected or concerning file structures that impact your work

DO NOT extract every file - focus on what's needed for your current ${mode} mode objectives.

Format: List only the file paths you need to examine, one per line.

`;
    } else if (isFileContent) {
      // Multiple files in one block
      prompt += `## File Contents Extraction Guidelines

This block contains multiple files. For each file, extract ONLY information relevant to your current task:
- Key functions/classes that relate to your specific objective
- Implementation details needed for your current work
- Dependencies that affect what you're trying to accomplish
- Issues or patterns that impact your task
- Relevant configuration or setup

DO NOT summarize everything - focus on what matters for your current ${mode} mode objectives.
Remember: You're analyzing files to understand specific aspects, not cataloging all content.

`;
    } else if (isSingleFile) {
      const fileName = tempBlock.title.replace('Content of ', '').replace('TEMPORARY: ', '').trim();
      
      if (isCode) {
        prompt += `## Code Extraction Guidelines

From ${fileName}, extract ONLY information relevant to your current task:
- Functions/classes that relate to your specific objective
- Implementation patterns needed for your work
- Dependencies affecting your task
- Security/performance issues impacting your goals
- Relevant algorithms or business logic

Focus on your current ${mode} mode objectives. DO NOT catalog everything.
Include line numbers only for findings directly relevant to your task.

`;
      } else {
        prompt += `## Requirements/Documentation Extraction Guidelines

From ${fileName}, extract ONLY information relevant to your current task:
- Requirements that affect your specific work
- Constraints impacting your approach
- Business rules relevant to your objectives
- Open questions about your task area

Focus on your current ${mode} mode objectives. DO NOT summarize the entire document.

`;
      }
    } else if (isSearchResult) {
      if (searchType === 'code') {
        prompt += `## Code Search Extraction Guidelines

From these search results, extract ONLY findings relevant to your current task:
- Implementation patterns that relate to your objective
- Code locations you need to examine further
- Architecture insights affecting your approach
- Issues or opportunities for your specific work

Focus on your current ${mode} mode objectives. DO NOT list every match.

`;
      } else if (searchType === 'requirements') {
        prompt += `## Requirements Search Extraction Guidelines

From these search results, extract ONLY findings relevant to your current task:
- Requirements affecting your specific work
- Constraints impacting your approach
- Business rules relevant to your objectives
- Key documents to review further

Focus on your current ${mode} mode objectives. DO NOT catalog all matches.

`;
      } else {
        prompt += `## Search Result Extraction Guidelines

From these search results, extract ONLY findings relevant to your current task:
- Key discoveries that impact your work
- Patterns affecting your approach
- Locations needing further investigation

Focus on your current ${mode} mode objectives, not comprehensive coverage.

`;
      }
    }
    
    // Add the data to review - ONLY the first temporary block
    prompt += '## Data to Review\n\n' + tempBlock.content + '\n\n';
    
    // Add final instructions
    prompt += `## Your Task

Extract the relevant information now. Write your analysis as plain text.`;
    
    // Normalize multiple newlines to single newline
    prompt = prompt.replace(/\n{2,}/g, '\n');
    
    await fs.writeFile('generated-prompt.md', prompt, 'utf8');
    console.log('✓ Extraction prompt ready in generated-prompt.md (block ' + blockNumber + ' of ' + totalBlocks + ')');
    
  } catch (err) {
    console.error('Error building extraction prompt:', err);
  }
}

module.exports = { buildPrompt: buildPrompt };
// ==========================================
// process-response.js
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
    
    // Create permanent summary block
    let summaryTitle = tempBlock.title.replace('TEMPORARY: ', '');
    // For multi-file blocks, improve the summary title
    if (summaryTitle === 'File contents') {
      // Count files in the block
      const fileCount = (tempBlock.content.match(/^[^\n]+:$/gm) || []).length;
      summaryTitle = `${fileCount} file${fileCount > 1 ? 's' : ''}`;
    }
    const summaryBlock = formatSystemToolResult('SYSTEM: Read summary of ' + summaryTitle + '\n' + extractedContent);
    
    // Replace the temporary block with summary in place
    const conversation = await utils.readFileIfExists('conversation.md');
    const lines = conversation.split('\n');
    
    // Replace the temporary block lines with the summary
    const before = lines.slice(0, tempBlock.startLine);
    const after = lines.slice(tempBlock.endLine + 1);
    const summaryLines = summaryBlock.split('\n');
    
    const updatedLines = before.concat(summaryLines).concat(after);
    const updated = updatedLines.join('\n');
    
    await fs.writeFile('conversation.md', updated, 'utf8');
    console.log('✓ Extraction complete, summary replaced temporary block');
    
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
    '1. READ Response: Use ONLY [READ_CODE], [READ_REQUIREMENTS], [SEARCH_NAME], [SEARCH_CODE], [SEARCH_REQUIREMENTS]\n' +
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
  
  const SEARCH_BLOCK_SIZE = 30000; // 30K characters per block
  
  // Collect all results first (both reads and searches)
  const allResults = [];
  
  // Process all tools and collect results
  for (let i = 0; i < tools.length; i++) {
    const tool = tools[i];
    
    if (tool.name === 'READ_CODE' || tool.name === 'READ_REQUIREMENTS') {
      // Execute the tool to get the result
      const rawResult = await executeTool(tool);
      
      if (typeof rawResult === 'string' && rawResult.startsWith('Error:')) {
        // Error occurred, add to conversation normally
        await updateConversation('SYSTEM: Tool result (' + tool.name + ')\n' + rawResult);
      } else if (rawResult.endsWith(' is empty') || rawResult.includes('[Empty directory]')) {
        // Empty file or directory - auto-resolve without creating temporary block
        const fileName = tool.params.file_name || tool.params.path || '.';
        const isDirectory = rawResult.includes('[Empty directory]');
        const summaryBlock = formatSystemToolResult('SYSTEM: Read summary of ' + fileName + '\n[' + (isDirectory ? 'Directory' : 'File') + ' is empty]');
        await updateConversation(summaryBlock);
        console.log('✓ Auto-resolved empty ' + (isDirectory ? 'directory' : 'file') + ': ' + fileName);
      } else {
        // Extract the filename and content
        const lines = rawResult.split('\n');
        let fileName = '';
        let content = rawResult;
        let isDirectory = false;
        
        if (lines[0].startsWith('Content of ') || lines[0].startsWith('Contents of ')) {
          fileName = lines[0].replace('Content of ', '').replace('Contents of ', '').replace(':', '').trim();
          content = lines.slice(1).join('\n');
          isDirectory = lines[0].startsWith('Contents of ');
        } else {
          fileName = tool.params.file_name || tool.params.path || '.';
        }
        
        // Add to results list
        allResults.push({
          type: isDirectory ? 'directory' : 'file',
          fileName: fileName,
          content: content,
          toolName: tool.name
        });
      }
    } else if (tool.name === 'SEARCH_CODE' || tool.name === 'SEARCH_REQUIREMENTS') {
      // Execute the search
      const rawResult = await executeTool(tool);
      
      if (typeof rawResult === 'string' && rawResult.startsWith('Error:')) {
        await updateConversation('SYSTEM: Tool result (' + tool.name + ')\n' + rawResult);
      } else if (rawResult.startsWith('No content found matching') || rawResult.startsWith('No files found matching')) {
        // No search results - add directly without temporary block
        await updateConversation('SYSTEM: Tool result (' + tool.name + ')\n' + rawResult);
      } else {
        // Add search results to allResults
        allResults.push({
          type: 'search',
          fileName: 'Search: "' + tool.params.regex + '"',
          content: rawResult,
          toolName: tool.name
        });
      }
    } else if (tool.name === 'SEARCH_NAME') {
      // Other read tools process normally
      const result = await executeTool(tool);
      await updateConversation('SYSTEM: Tool result (' + tool.name + ')\n' + result);
    }
  }
  
  // Now group all results into blocks
  if (allResults.length > 0) {
    const blocks = [];
    let currentBlock = [];
    let currentSize = 0;
    let currentType = null;
    
    for (let i = 0; i < allResults.length; i++) {
      const result = allResults[i];
      
      // Format based on type
      let formattedResult;
      if (result.type === 'search') {
        formattedResult = result.fileName + ':\n' + result.content;
      } else {
        formattedResult = result.fileName + (result.type === 'directory' ? ' (directory):' : ':') + '\n' + result.content;
      }
      
      const resultSize = formattedResult.length + 2; // +2 for double newline separator
      
      // Determine if we need a new block
      const needNewBlock = currentSize > 0 && (
        currentSize + resultSize > SEARCH_BLOCK_SIZE ||
        (currentType === 'search' && result.type !== 'search') ||
        (currentType !== 'search' && result.type === 'search')
      );
      
      if (needNewBlock) {
        // Save current block and start new one
        blocks.push({
          type: currentType,
          content: currentBlock.join('\n\n')
        });
        currentBlock = [formattedResult];
        currentSize = resultSize;
        currentType = result.type;
      } else {
        // Add to current block
        currentBlock.push(formattedResult);
        currentSize += resultSize;
        if (!currentType) currentType = result.type;
      }
    }
    
    // Add the last block
    if (currentBlock.length > 0) {
      blocks.push({
        type: currentType,
        content: currentBlock.join('\n\n')
      });
    }
    
    // Create temporary blocks
    const temporaryBlocks = [];
    for (let i = 0; i < blocks.length; i++) {
      const block = blocks[i];
      
      // Determine title based on content type
      let title;
      if (block.type === 'search') {
        title = 'Search results';
      } else {
        // Check if block contains only directories by looking for "(directory):" marker
        const dirCount = (block.content.match(/\(directory\):/g) || []).length;
        const totalItems = (block.content.match(/^[^\n]+:$/gm) || []).length;
        
        if (dirCount > 0 && dirCount === totalItems) {
          title = 'Folder contents';
        } else {
          title = 'File contents';
        }
      }
      
      temporaryBlocks.push({
        title: title,
        content: block.content,
        blockNumber: blocks.length > 1 ? i + 1 : null,
        totalBlocks: blocks.length > 1 ? blocks.length : null
      });
    }
    
    // Add all temporary blocks to conversation
    for (let i = 0; i < temporaryBlocks.length; i++) {
      const block = temporaryBlocks[i];
      const blockNumber = block.blockNumber || (i + 1);
      const totalBlocks = block.totalBlocks || temporaryBlocks.length;
      
      const tempBlock = utils.formatTemporaryBlock(block.title, block.content, blockNumber, totalBlocks);
      await updateConversation(tempBlock);
    }
    
    console.log('✓ Added ' + temporaryBlocks.length + ' temporary content blocks');
  }
  
  // Clear response and build next prompt
  await fs.writeFile('ai-response.md', '', 'utf8');
  const buildPrompt = require('./message-to-prompt').buildPrompt;
  await buildPrompt();
  console.log('✓ Extraction prompt ready');
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
    case 'SEARCH_CODE':
      return await executeSearchCode(tool.params);
    case 'SEARCH_REQUIREMENTS':
      return await executeSearchRequirements(tool.params);
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
    
    // Check for binary extensions first
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
    
    const fileName = params.file_name || params.path || '.';
    const ext = path.extname(fileName).toLowerCase();
    if (binaryExtensions.includes(ext)) {
      return 'Error: Cannot read ' + fileName + ' - binary and compressed files are not supported. Only plain text files can be read.';
    }
    
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

async function executeSearchCode(params) {
  try {
    const searchPath = utils.getCodebasePath(params.folder);
    const results = await utils.searchFilesByContent(searchPath, params.regex, 'code');
    if (results.length === 0) {
      return 'No content found matching "' + params.regex + '" in code files in ' + params.folder;
    }
    
    let output = '';
    for (let i = 0; i < results.length; i++) {
      const result = results[i];
      const relativePath = path.relative(utils.CODEBASE_PATH, result.file);
      output += relativePath + ' (lines ' + result.lines + '):\n' + result.content;
      if (i < results.length - 1) {
        output += '\n\n';
      }
    }
    
    return output;
  } catch (err) {
    return 'Error searching code: ' + err.message;
  }
}

async function executeSearchRequirements(params) {
  try {
    const searchPath = utils.getCodebasePath(params.folder);
    const results = await utils.searchFilesByContent(searchPath, params.regex, 'requirements');
    if (results.length === 0) {
      return 'No content found matching "' + params.regex + '" in requirements files in ' + params.folder;
    }
    
    let output = '';
    for (let i = 0; i < results.length; i++) {
      const result = results[i];
      const relativePath = path.relative(utils.CODEBASE_PATH, result.file);
      output += relativePath + ' (lines ' + result.lines + '):\n' + result.content;
      if (i < results.length - 1) {
        output += '\n\n';
      }
    }
    
    return output;
  } catch (err) {
    return 'Error searching requirements: ' + err.message;
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
  } else if (newMessage.includes('╔═ SYSTEM:')) {
    // System blocks are already formatted - don't double-wrap
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
    // Use -- to prevent filename from being interpreted as option
    await execAsync('git add -- ' + JSON.stringify(fileName), { cwd: utils.CODEBASE_PATH });
    console.log('✓ Git added: ' + fileName);
    
    // Escape commit message properly
    const commitMessage = 'AI: ' + description.replace(/"/g, '\\"').replace(/\$/g, '\\$');
    await execAsync('git commit -m ' + JSON.stringify(commitMessage), { cwd: utils.CODEBASE_PATH });
    console.log('✓ Git commit: ' + commitMessage);
    
    await execAsync('git push', { cwd: utils.CODEBASE_PATH });
    console.log('✓ Git push completed');
    
  } catch (error) {
    console.error('⚠ Git operation failed:', error.message);
  }
}

module.exports = { processResponse: processResponse };
// ==========================================
// prompt-budget-allocator.js
// prompt-budget-allocator.js

const utils = require('./utils');

// Constants
const BUDGET_LIMIT = 590000; // 590k characters
const BUDGET_TARGET = 0.95; // Use 95% of budget before summarizing

// Calculate importance weight (same as existing system)
function calculateImportanceWeight(importance) {
  return Math.pow(2.5, importance - 1);
}

// Calculate recency factor with exponential decay
function calculateRecencyFactor(date, currentDate) {
  const ageInDays = (currentDate - date) / (1000 * 60 * 60 * 24);
  // Exponential decay: newer items have factor close to 1, older items decay
  // Half-life of 30 days (after 30 days, recency factor is 0.5)
  return Math.exp(-0.693 * ageInDays / 30);
}

// Parse discovery entry
function parseDiscovery(line) {
  const match = line.match(/^\[([^\]]+)\] importance:(\d+) (.+)$/);
  if (!match) return null;
  
  return {
    date: new Date(match[1]),
    importance: parseInt(match[2]),
    content: match[3],
    originalLine: line
  };
}

// Score discoveries by importance and recency
function scoreDiscoveries(discoveries, currentDate) {
  if (!currentDate) currentDate = new Date();
  
  const scored = [];
  const lines = discoveries.split('\n').filter(line => line.trim());
  
  for (const line of lines) {
    const parsed = parseDiscovery(line);
    if (!parsed) continue;
    
    const importanceWeight = calculateImportanceWeight(parsed.importance);
    const recencyFactor = calculateRecencyFactor(parsed.date, currentDate);
    
    scored.push({
      ...parsed,
      importanceWeight,
      recencyFactor,
      score: importanceWeight * recencyFactor
    });
  }
  
  // Sort by score (highest first), with importance 10 always at top
  return scored.sort((a, b) => {
    // Importance 10 always stays at top
    if (a.importance === 10 && b.importance !== 10) return -1;
    if (b.importance === 10 && a.importance !== 10) return 1;
    if (a.importance === 10 && b.importance === 10) {
      // Both are 10, sort by recency
      return b.date - a.date;
    }
    // Otherwise sort by combined score
    return b.score - a.score;
  });
}

// Category definitions
const CATEGORY_CONFIGS = {
  basePrompt: {
    weight: 0, // Mandatory, always included
    required: true,
    selector: (content) => content,
    summarizer: null // Cannot be summarized
  },
  
  conversation: {
    weight: 40,
    required: false,
    selector: (content) => {
      // Filter out waiting message lines first
      const cleanedContent = content.split('\n')
        .filter(line => !line.includes('=== WAITING FOR YOUR MESSAGE ===') && 
                       line !== '[write here when ready]')
        .join('\n');
      
      // Also filter out ALL temporary blocks - they should not be in normal prompts
      const withoutTempBlocks = cleanedContent.split('\n').filter((line, index, arr) => {
        // Check if we're in a temporary block
        for (let i = index; i >= 0; i--) {
          if (arr[i].includes('╔═ TEMPORARY:')) {
            // We're inside a temp block, check if we've hit the end
            for (let j = i; j <= index; j++) {
              if (arr[j].includes('╚═') && j <= index) {
                // We've passed the end, not in block anymore
                break;
              }
              if (j === index) {
                // Still in block
                return false;
              }
            }
          }
        }
        return true;
      }).join('\n');
      
      // Split conversation into individual exchanges
      const lines = cleanedContent.split('\n');
      const exchanges = [];
      let currentExchange = [];
      let inAssistantBox = false;
      
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        
        // Check if this starts a new user message
        if (line.startsWith('> ') && currentExchange.length > 0 && !inAssistantBox) {
          // Save previous exchange
          exchanges.push(currentExchange.join('\n'));
          currentExchange = [line];
        } else {
          currentExchange.push(line);
          
          // Track assistant box state
          if (line.includes('┌─ ASSISTANT')) {
            inAssistantBox = true;
          } else if (line.includes('└─') && inAssistantBox) {
            inAssistantBox = false;
          }
        }
      }
      
      // Don't forget the last exchange
      if (currentExchange.length > 0) {
        exchanges.push(currentExchange.join('\n'));
      }
      
      // Return in reverse order (most recent first)
      return exchanges.reverse();
    },
    summarizer: (excluded) => {
      if (excluded.length === 0) return '';
      
      // Extract key points from excluded exchanges
      const decisions = [];
      const questions = [];
      
      for (const exchange of excluded) {
        const lines = exchange.split('\n');
        for (const line of lines) {
          if (line.includes('implement') || line.includes('create') || line.includes('build')) {
            decisions.push(line.trim());
          }
          if (line.startsWith('> ') && line.includes('?')) {
            questions.push(line.trim());
          }
        }
      }
      
      let summary = '=== CONVERSATION SUMMARY ===\n';
      summary += `${excluded.length} earlier exchanges summarized:\n`;
      
      if (decisions.length > 0) {
        summary += '\nKey Decisions:\n';
        decisions.slice(0, 5).forEach(d => summary += `- ${d}\n`);
      }
      
      if (questions.length > 0) {
        summary += '\nKey Questions:\n';
        questions.slice(0, 3).forEach(q => summary += `- ${q}\n`);
      }
      
      return summary;
    }
  },
  
  discoveries: {
    weight: 25,
    required: false,
    selector: (content, currentDate) => {
      const scored = scoreDiscoveries(content, currentDate);
      return scored.map(d => d.originalLine);
    },
    summarizer: (excluded) => {
      if (excluded.length === 0) return '';
      
      // Group by importance
      const groups = {
        critical: [], // 9-10
        important: [], // 6-8
        normal: [], // 4-5
        minor: [] // 1-3
      };
      
      for (const line of excluded) {
        const parsed = parseDiscovery(line);
        if (!parsed) continue;
        
        if (parsed.importance >= 9) groups.critical.push(parsed);
        else if (parsed.importance >= 6) groups.important.push(parsed);
        else if (parsed.importance >= 4) groups.normal.push(parsed);
        else groups.minor.push(parsed);
      }
      
      let summary = '=== DISCOVERY SUMMARY ===\n';
      summary += `${excluded.length} discoveries not shown in detail:\n`;
      
      if (groups.critical.length > 0) {
        summary += `\nCritical (9-10): ${groups.critical.length} findings\n`;
        groups.critical.slice(0, 3).forEach(d => 
          summary += `- [${d.date.toISOString().split('T')[0]}] ${d.content.substring(0, 80)}...\n`
        );
      }
      
      if (groups.important.length > 0) {
        summary += `\nImportant (6-8): ${groups.important.length} findings\n`;
        groups.important.slice(0, 2).forEach(d => 
          summary += `- ${d.content.substring(0, 60)}...\n`
        );
      }
      
      if (groups.normal.length > 0) {
        summary += `\nNormal (4-5): ${groups.normal.length} findings\n`;
      }
      
      if (groups.minor.length > 0) {
        summary += `Minor (1-3): ${groups.minor.length} findings\n`;
      }
      
      return summary;
    }
  },
  
  projectStructure: {
    weight: 15,
    required: false,
    selector: (content) => content,
    summarizer: (content) => {
      const lines = content.split('\n');
      const fileCount = lines.filter(l => l.includes(' lines)')).length;
      const dirCount = lines.filter(l => l.includes('/')).length;
      return `=== PROJECT STRUCTURE SUMMARY ===\nLarge project: ${fileCount} files across ${dirCount} directories\n`;
    }
  },
  
  detailedPlan: {
    weight: 20,
    required: false,
    modes: ['planning', 'implementation'],
    selector: (content) => content,
    summarizer: (content) => {
      const lines = content.split('\n');
      const tasks = lines.filter(l => l.match(/^\d+\./));
      return `=== PLAN SUMMARY ===\nImplementation plan with ${tasks.length} tasks\n` +
             tasks.slice(0, 5).join('\n') + 
             (tasks.length > 5 ? `\n... and ${tasks.length - 5} more tasks` : '');
    }
  },
  
  explorationFindings: {
    weight: 20,
    required: false,
    selector: (content) => content,
    summarizer: (content) => {
      const lines = content.split('\n');
      const headers = lines.filter(l => l.startsWith('#'));
      return `=== EXPLORATION SUMMARY ===\n` +
             `Key sections: ${headers.slice(0, 3).join(', ')}\n` +
             `Total findings: ${lines.length} lines\n`;
    }
  },
  
  goals: {
    weight: 5,
    required: false,
    selector: (content) => content,
    summarizer: null // Usually short
  },
  
  additionalContext: {
    weight: 10,
    required: false,
    selector: (content) => content,
    summarizer: (content) => {
      const lines = content.split('\n');
      return `=== CONTEXT SUMMARY ===\n${lines.slice(0, 3).join('\n')}...\n(${lines.length} total lines)\n`;
    }
  }
};

// Main allocation function
function allocatePromptBudget(inputs, mode, currentDate) {
  const budget = BUDGET_LIMIT;
  const targetUsage = budget * BUDGET_TARGET;
  
  // Filter categories by mode and availability
  const activeCategories = [];
  for (const [name, config] of Object.entries(CATEGORY_CONFIGS)) {
    // Skip if mode-specific and not in current mode
    if (config.modes && !config.modes.includes(mode)) continue;
    
    // Skip if no content provided
    if (!inputs[name] || inputs[name].trim() === '') continue;
    
    // Skip goals if it's the default
    if (name === 'goals' && inputs[name].trim() === '# Project Goals\n\nAdd your high-level objectives here') continue;
    
    activeCategories.push({
      name,
      config,
      content: inputs[name],
      weight: config.weight
    });
  }
  
  // Start with required content
  let usedBudget = 0;
  const allocations = {};
  
  // Add mandatory content first
  for (const category of activeCategories) {
    if (category.config.required) {
      allocations[category.name] = {
        content: category.content,
        excluded: [],
        summary: ''
      };
      usedBudget += category.content.length;
    }
  }
  
  // Calculate total weight for proportional allocation
  const totalWeight = activeCategories
    .filter(c => !c.config.required && c.weight > 0)
    .reduce((sum, c) => sum + c.weight, 0);
  
  // Sort by weight (highest first)
  const prioritizedCategories = activeCategories
    .filter(c => !c.config.required)
    .sort((a, b) => b.weight - a.weight);
  
  // Allocate content to each category
  for (const category of prioritizedCategories) {
    const { name, config, content } = category;
    
    // Calculate this category's budget
    const categoryBudget = config.weight > 0 
      ? Math.floor((targetUsage - usedBudget) * (config.weight / totalWeight))
      : content.length; // Categories with 0 weight get their full content if space allows
    
    // Get selectable units (exchanges, discoveries, etc)
    let units = config.selector ? config.selector(content, currentDate) : [content];
    
    // Ensure units is an array (not a string being treated as char array)
    if (typeof units === 'string') {
      units = [units];
    } else if (!Array.isArray(units)) {
      units = [units];
    }
    
    let includedContent = '';
    let excludedContent = [];
    let currentSize = 0;
    
    // Add units until we exceed budget
    for (let i = 0; i < units.length; i++) {
      const unit = units[i];
      const unitSize = unit.length + (i > 0 ? 1 : 0); // +1 for newline
      
      if (currentSize + unitSize <= categoryBudget || currentSize === 0) {
        if (i > 0) includedContent += '\n';
        includedContent += unit;
        currentSize += unitSize;
      } else {
        excludedContent.push(unit);
      }
    }
    
    allocations[name] = {
      content: includedContent,
      excluded: excludedContent,
      summary: ''
    };
    
    usedBudget += includedContent.length;
  }
  
  // Generate summaries for excluded content with remaining budget
  const remainingBudget = budget - usedBudget;
  let summaryBudget = remainingBudget;
  
  for (const category of prioritizedCategories) {
    const { name, config } = category;
    const allocation = allocations[name];
    
    if (allocation && allocation.excluded.length > 0 && config.summarizer && summaryBudget > 0) {
      const summary = config.summarizer(allocation.excluded);
      if (summary && summary.length <= summaryBudget) {
        allocation.summary = summary;
        summaryBudget -= summary.length;
      }
    }
  }
  
  return {
    allocations,
    totalUsed: Object.values(allocations).reduce((sum, a) => 
      sum + a.content.length + a.summary.length, 0
    ),
    budget: budget
  };
}

// Helper to build the final prompt from allocations
function buildPromptFromAllocations(allocations, mode) {
  const sections = [];
  
  // Base prompt is always first
  if (allocations.basePrompt) {
    sections.push(allocations.basePrompt.content);
  }
  
  // Add goals if present
  if (allocations.goals) {
    sections.push('GOALS:\n' + allocations.goals.content.trim());
  }
  
  // Add project structure
  if (allocations.projectStructure) {
    if (allocations.projectStructure.summary) {
      sections.push(allocations.projectStructure.summary.trim());
    } else {
      sections.push('PROJECT STRUCTURE (2 levels):\n' + allocations.projectStructure.content);
    }
  }
  
  // Add additional context
  if (allocations.additionalContext) {
    if (allocations.additionalContext.summary) {
      sections.push(allocations.additionalContext.summary.trim());
    } else {
      sections.push('ADDITIONAL CONTEXT:\n' + allocations.additionalContext.content);
    }
  }
  
  // Add exploration findings
  if (allocations.explorationFindings) {
    if (allocations.explorationFindings.summary) {
      sections.push(allocations.explorationFindings.summary.trim());
    } else {
      sections.push('EXPLORATION FINDINGS:\n' + allocations.explorationFindings.content);
    }
  }
  
  // Add detailed plan
  if (allocations.detailedPlan) {
    if (allocations.detailedPlan.summary) {
      sections.push(allocations.detailedPlan.summary.trim());
    } else {
      sections.push('DETAILED PLAN:\n' + allocations.detailedPlan.content);
    }
  }
  
  // Add discoveries
  if (allocations.discoveries) {
    if (allocations.discoveries.summary) {
      sections.push(allocations.discoveries.summary.trim());
    }
    if (allocations.discoveries.content) {
      sections.push('DISCOVERIES:\n' + allocations.discoveries.content);
    }
  }
  
  // Add conversation history
  if (allocations.conversation) {
    let conversationSection = 'CONVERSATION HISTORY:\n\n';
    
    // Add example if needed
    conversationSection += '> Are you ready to help?\n\nASSISTANT: yes\n\n' +
      '> Your response is not in the correct format. You MUST wrap your response in an ascii box (your first output line must be "┌─ ASSISTANT ─────────────────────────────────────────────────────────") and you can ONLY use tool uses, not free form text.\n\n' +
      '┌─ ASSISTANT ─────────────────────────────────────────────────────────\n' +
      '│ [MESSAGE]\n' +
      '│ Here\'s another message in your specified format. Is this correct?\n' +
      '└─────────────────────────────────────────────────────────────────────\n\n' +
      '> yes\n\n' +
      '┌─ ASSISTANT ─────────────────────────────────────────────────────────\n' +
      '│ [MESSAGE]\n' +
      '│ How can I help you?\n' +
      '└─────────────────────────────────────────────────────────────────────\n\n';
    
    if (allocations.conversation.summary) {
      conversationSection += allocations.conversation.summary + '\n\n';
    }
    
    conversationSection += allocations.conversation.content;
    sections.push(conversationSection);
  }
  
  // Add final instructions
  sections.push('Generate your response as the assistant.');
  sections.push('FINAL REMINDER: The first line of your response must be "┌─ ASSISTANT ─────────────────────────────────────────────────────────" and your responses can only contain tool uses, no plain text messages.');
  
  return sections.join('\n\n');
}

module.exports = {
  allocatePromptBudget,
  buildPromptFromAllocations,
  scoreDiscoveries,
  calculateImportanceWeight,
  calculateRecencyFactor,
  parseDiscovery,
  BUDGET_LIMIT,
  BUDGET_TARGET,
  CATEGORY_CONFIGS
};
// ==========================================
// prompt-generator.js
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
2) Write "┌─ ASSISTANT ─────────────────────────────────────────────────────────" to your output
3) Write your response
  - Start each line with "│ "
4) Write "└─────────────────────────────────────────────────────────────────────" to end your output

## CRITICAL: MESSAGE FORMAT

**You MUST wrap your entire response in an ASCII box like this:**

\`\`\`
┌─ ASSISTANT ─────────────────────────────────────────────────────────
│ [MESSAGE]
│ Your message content here
│ 
│ [READ_CODE] .
│ Getting project overview
│ 
│ [SEARCH_NAME] .*pattern.*$ src/folder
│ Searching for files with regex patterns
└─────────────────────────────────────────────────────────────────────
\`\`\`

**IMPORTANT: Start each line with "│ ".**

## RESPONSE TYPE RULES

Complete these tasks:

#1 Decide if you need to READ or WRITE to complete the next assistant message, then choose the corresponding response type.

Tools allowed in the READ response type:
- [READ_CODE]
- [READ_REQUIREMENTS]
- [SEARCH_NAME]
- [SEARCH_CODE]
- [SEARCH_REQUIREMENTS]

Tools allowed in the WRITE response type: `;

// Mode-specific configurations
const MODE_CONFIGS = {
  exploration: {
    writeTools: ['MESSAGE', 'DISCOVERED', 'EXPLORATION_FINDINGS', 'SWITCH_TO_PLANNING'],
    modeInstructions: `# EXPLORATION MODE

Your job is to understand the codebase and requirements:

- Use READ_CODE to explore source files and examine implementation
- Use READ_REQUIREMENTS to review documentation and specifications  
- Use SEARCH_NAME to find files by name patterns
- Use SEARCH_CODE for code-specific searches, SEARCH_REQUIREMENTS for docs
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
  READ_CODE: `**[READ_CODE] path**
Read source code files or list directory contents. Path defaults to current directory (.).
For files: shows content with line numbers. For directories: shows file tree.
Use for: source files (.js, .py, .java, etc), config files, scripts, any code-related files.
NOTE: You can only read text files. Binary files (jar, zip, exe, images, etc.) are not allowed.
\`\`\`
[READ_CODE] .
List current directory contents

[READ_CODE] src/
List src directory contents

[READ_CODE] package.json
Read package.json file

[READ_CODE] src/index.js
Read the main entry point

[READ_CODE] src/auth/login.js
Examining authentication logic
\`\`\``,

  READ_REQUIREMENTS: `**[READ_REQUIREMENTS] path**
Read requirements, documentation, specs, or any non-code text files.
Shows content with line numbers for detailed reference.
Use for: .md files, .txt files, documentation, specifications, requirements, user stories.
\`\`\`
[READ_REQUIREMENTS] README.md
Understanding project overview

[READ_REQUIREMENTS] docs/api-spec.md
Reviewing API specifications

[READ_REQUIREMENTS] requirements/auth-flow.txt
Reading authentication requirements

[READ_REQUIREMENTS] CHANGELOG.md
Checking recent changes
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

  SEARCH_CODE: `**[SEARCH_CODE] pattern folder**
Search content within CODE files only (.js, .py, .java, etc). Use quotes for patterns with spaces. Escape quotes with backslash.
\`\`\`
[SEARCH_CODE] "class\\s+User" src/
Finding User class definitions

[SEARCH_CODE] "import.*auth" .
Finding auth imports

[SEARCH_CODE] "def\\s+process_payment" .
Finding payment processing functions
\`\`\``,

  SEARCH_REQUIREMENTS: `**[SEARCH_REQUIREMENTS] pattern folder**
Search content within DOCUMENTATION files only (.md, .txt, .rst, etc). Use quotes for patterns with spaces. Escape quotes with backslash.
\`\`\`
[SEARCH_REQUIREMENTS] "authentication.*required" docs/
Finding auth requirements

[SEARCH_REQUIREMENTS] "user story" .
Finding all user stories

[SEARCH_REQUIREMENTS] "acceptance criteria" requirements/
Finding acceptance criteria
\`\`\``,

  // WRITE tools (mode-specific)
  MESSAGE: `**[MESSAGE]**
Communicate with the user. Content continues until next tool or box end.
If your message contains tool keywords in brackets like [READ] or [SEARCH_NAME], end with [END_MESSAGE].
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
1. [MESSAGE] contains tool keywords like [READ], [SEARCH_NAME], etc.
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

- **Box format**: Content lines start with "│ "
- **Complete the box**: Always close your response with the bottom border
- **Strict type separation**: Use only READ tools or only WRITE tools per response
- **Always include [MESSAGE]**: In WRITE responses, start with [MESSAGE] for any text
- **Use positional parameters**: Tools now use positions, not named parameters
- **Smart termination**: Tools end at next tool line or box closure
- **Progressive discovery**: Start with [READ_CODE] . at root, explore as needed
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
  toolDocs += [TOOL_DOCS.READ_CODE, TOOL_DOCS.READ_REQUIREMENTS, TOOL_DOCS.SEARCH_NAME, TOOL_DOCS.SEARCH_CODE, TOOL_DOCS.SEARCH_REQUIREMENTS].join('\n\n');
  
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
    prompt += '\n\nCONVERSATION HISTORY:\n\n> Are you ready to help?\n\nASSISTANT: yes\n\n> Your response is not in the correct format. You MUST wrap your response in an ascii box (your first output line must be "┌─ ASSISTANT ─────────────────────────────────────────────────────────") and you can ONLY use tool uses, not free form text.\n\n┌─ ASSISTANT ─────────────────────────────────────────────────────────\n│ [MESSAGE]\n│ Here\'s another message in your specified format. Is this correct?\n└─────────────────────────────────────────────────────────────────────\n\n> yes\n\n┌─ ASSISTANT ─────────────────────────────────────────────────────────\n│ [MESSAGE]\n│ How can I help you?\n└─────────────────────────────────────────────────────────────────────\n\n' + conversationHistory;
  }
  
  // Add final instructions
  prompt += '\n\nGenerate your response as the assistant.';
  prompt += '\n\nFINAL REMINDER: The first line of your response must be "┌─ ASSISTANT ─────────────────────────────────────────────────────────" and your responses can only contain tool uses, no plain text messages.';
  
  return prompt;
}

module.exports = { generatePrompt };
// ==========================================
// reset.js
// reset.js

const fs = require("fs").promises;
const path = require("path");
const utils = require("./utils");

async function reset() {
  console.log("🔄 Resetting AI workflow...");

  try {
    // Files to reset completely
    const filesToClear = [
      "conversation.md",
      "ai-response.md",
      "generated-prompt.md",
      "pending-changes.json",
      "ai-managed/context.md",
      "ai-managed/discoveries.md",
      "ai-managed/exploration-findings.md",
      "ai-managed/detailed-plan.md",
    ];

    for (let i = 0; i < filesToClear.length; i++) {
      const file = filesToClear[i];
      try {
        if (file === "conversation.md") {
          await fs.writeFile(
            file,
            "=== CONVERSATION HISTORY ===\n\n=== WAITING FOR YOUR MESSAGE ===\n[write here when ready]",
            "utf8"
          );
        } else if (file === "pending-changes.json") {
          await fs.unlink(file).catch(() => {}); // Delete if exists, ignore if not
        } else {
          await fs.writeFile(file, "", "utf8");
        }
        console.log("✓ Reset " + file);
      } catch (err) {
        // File might not exist, that's ok
      }
    }

    // Reset mode to exploration
    await fs.writeFile(
      "mode.md",
      "x exploration\n  planning\n  implementation",
      "utf8"
    );
    console.log("✓ Reset mode to exploration");

    // Keep goals.md and prompt files intact
    console.log("✓ Preserved goals.md and prompt templates");

    // Optional: clear ai-docs folder
    const aiDocsPath = path.join(__dirname, "ai-docs");
    try {
      const files = await fs.readdir(aiDocsPath);
      if (files.length > 0) {
        console.log("\n📁 AI documents found in ai-docs/:");
        for (let i = 0; i < files.length; i++) {
          console.log("  - " + files[i]);
        }
        console.log("\nThese were NOT deleted. Delete manually if needed.");
      }
    } catch (err) {
      // ai-docs doesn't exist, that's fine
    }

    console.log("\n✅ Reset complete! Ready for a fresh start.");
    console.log("💡 Edit conversation.md to begin");
  } catch (err) {
    console.error("❌ Error during reset:", err);
  }
}

if (require.main === module) {
  reset();
}

module.exports = { reset: reset };

// ==========================================
// utils.js
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
      
    case 'SEARCH_CODE':
    case 'SEARCH_REQUIREMENTS':
      const searchArgs = parseArgs(args);
      params.regex = searchArgs[0];
      params.folder = searchArgs[1] || '.';
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
  const informationTools = ['READ_CODE', 'READ_REQUIREMENTS', 'SEARCH_NAME', 'SEARCH_CODE', 'SEARCH_REQUIREMENTS'];
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

async function searchFilesByContent(folder, regex, fileType) {
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
  
  // Define code and requirements file extensions
  const codeExtensions = [
    '.js', '.jsx', '.ts', '.tsx', '.py', '.java', '.c', '.cpp', '.cs', '.rb', '.go',
    '.php', '.swift', '.kt', '.rs', '.scala', '.clj', '.lua', '.sh', '.bash',
    '.html', '.css', '.scss', '.sass', '.less', '.sql', '.json', '.xml', '.yaml', '.yml',
    '.h', '.hpp', '.m', '.mm', '.r', '.pl', '.pm', '.t', '.ex', '.exs', '.elm',
    '.vue', '.svelte', '.astro'
  ];
  
  const requirementsExtensions = [
    '.md', '.txt', '.rst', '.adoc', '.org', '.tex', '.rtf'
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
          
          // Filter by file type if specified
          if (fileType === 'code' && !codeExtensions.includes(ext)) {
            continue;
          }
          if (fileType === 'requirements' && !requirementsExtensions.includes(ext)) {
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
              // Reset regex lastIndex for each line
              pattern.lastIndex = 0;
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
// watcher.js
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
  const waitingIndex = lines.findIndex(function (line) {
    return line.includes("=== WAITING FOR YOUR MESSAGE ===");
  });

  if (historyIndex !== -1 && waitingIndex !== -1) {
    // Extract existing history (between the two markers)
    const historyContent = lines
      .slice(historyIndex + 1, waitingIndex)
      .join("\n")
      .trim();

    // Append user message to history
    const userMessage = "> " + message;
    const newHistory =
      historyContent + (historyContent ? "\n\n" : "") + userMessage;

    // Rebuild file with input area at bottom
    const updated =
      "=== CONVERSATION HISTORY ===\n\n" +
      newHistory +
      "\n\n=== WAITING FOR YOUR MESSAGE ===\n[write here when ready]";

    await require("fs").promises.writeFile("conversation.md", updated, "utf8");
    console.log("✓ Moved user message to history");
  }
}

async function createInitialFiles() {
  const initialFiles = {
    "conversation.md":
      "=== CONVERSATION HISTORY ===\n\n=== WAITING FOR YOUR MESSAGE ===\n[write here when ready]",
    "mode.md": "x exploration\n  planning\n  implementation",
    "goals.md": "# Project Goals\n\nAdd your high-level objectives here",
    "ai-response.md": "",
    "generated-prompt.md": "",
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
