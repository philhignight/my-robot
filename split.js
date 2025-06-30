// file-extractor.js
const fs = require('fs').promises;
const path = require('path');

async function extractFilesFromScript() {
  try {
    // Read the source file
    const scriptContent = await fs.readFile('./scripts.js', 'utf8');
    
    // Split the content by file separator pattern
    // Look for "// " followed by at least 6 "="
    const fileSeparator = /\/\/ ={6,}/;
    const fileBlocks = scriptContent.split(fileSeparator);
    
    // Process each file block
    for (let i = 0; i < fileBlocks.length; i++) {
      const block = fileBlocks[i].trim();
      if (!block) continue;
      
      // Extract filename from first line comment (if exists)
      const filenameMatch = block.match(/^\/\/\s*([^\n]+)/);
      
      if (filenameMatch) {
        const filename = filenameMatch[1].trim();
        console.log(`Processing file: ${filename}`);
        
        // Create the file with its content (including the filename comment)
        await fs.writeFile(filename, block, 'utf8');
        console.log(`Created/updated file: ${filename}`);
      } else {
        // If no filename found, write to a fallback file
        console.log(`No filename found for block ${i+1}, writing to unknown-${i+1}.js`);
        await fs.writeFile(`unknown-${i+1}.js`, block, 'utf8');
      }
    }
    
    console.log('File extraction completed successfully!');
  } catch (error) {
    console.error('Error extracting files:', error);
  }
}

// Run the extraction function
extractFilesFromScript();
