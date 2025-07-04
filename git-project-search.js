const fs = require('fs').promises;
const path = require('path');
const { execSync, exec } = require('child_process');
const readline = require('readline');

// Configuration
const CONFIG = {
    repoListFile: 'repositories.txt', // File containing repository URLs (one per line)
    searchTerm: 'YOUR_SEARCH_TERM', // Replace with what you're searching for
    tempDir: path.join(process.env.TEMP || '/tmp', 'gitlab-search'),
    stateFile: 'search-state.json',
    resultsFile: 'search-results.txt',
    contextLines: 3
};

class GitSearcher {
    constructor(config) {
        this.config = config;
    }

    async loadRepositories() {
        try {
            const content = await fs.readFile(this.config.repoListFile, 'utf8');
            const repos = content.split('\n')
                .map(line => line.trim())
                .filter(line => line && !line.startsWith('#')); // Skip empty lines and comments
            
            console.log(`Loaded ${repos.length} repositories from ${this.config.repoListFile}`);
            return repos;
        } catch (error) {
            console.error(`Error reading repository list: ${error.message}`);
            console.error(`Please create a file named '${this.config.repoListFile}' with repository URLs (one per line)`);
            process.exit(1);
        }
    }

    async buildInitialState() {
        const repos = await this.loadRepositories();
        const state = {
            searchTerm: this.config.searchTerm,
            repositories: [],
            totalProcessed: 0,
            totalMatches: 0
        };

        for (let i = 0; i < repos.length; i++) {
            const repoUrl = repos[i];
            const repoName = this.extractRepoName(repoUrl);
            
            state.repositories.push({
                url: repoUrl,
                name: repoName,
                processed: false,
                foundMatch: false,
                matchingBranch: null,
                branchesChecked: 0,
                error: null
            });
        }

        return state;
    }

    extractRepoName(url) {
        // Extract repository name from URL
        const parts = url.split('/');
        const lastPart = parts[parts.length - 1];
        return lastPart.replace('.git', '');
    }

    async saveState(state) {
        await fs.writeFile(this.config.stateFile, JSON.stringify(state, null, 2));
    }

    async loadState() {
        try {
            const data = await fs.readFile(this.config.stateFile, 'utf8');
            return JSON.parse(data);
        } catch (error) {
            return null;
        }
    }

    execCommand(command, options = {}) {
        try {
            return execSync(command, { 
                encoding: 'utf8', 
                stdio: 'pipe',
                ...options 
            }).trim();
        } catch (error) {
            throw new Error(`Command failed: ${command}\n${error.message}`);
        }
    }

    async getBranches(repoDir) {
        try {
            // Get all branches (local and remote)
            const remoteBranches = this.execCommand('git branch -r', { cwd: repoDir })
                .split('\n')
                .map(branch => branch.trim())
                .filter(branch => branch && !branch.includes('->'))
                .map(branch => branch.replace('origin/', ''));

            // Get last commit date for each branch
            const branchesWithDates = [];
            
            for (const branch of remoteBranches) {
                try {
                    const dateStr = this.execCommand(
                        `git log -1 --format=%cI origin/${branch}`,
                        { cwd: repoDir }
                    );
                    
                    branchesWithDates.push({
                        name: branch,
                        lastCommitDate: dateStr
                    });
                } catch (error) {
                    console.warn(`Could not get date for branch ${branch}`);
                }
            }

            // Sort by date (newest first)
            branchesWithDates.sort((a, b) => 
                new Date(b.lastCommitDate) - new Date(a.lastCommitDate)
            );

            return branchesWithDates;
        } catch (error) {
            console.error(`Error getting branches: ${error.message}`);
            return [];
        }
    }

    async searchInBranch(repoDir, branch, searchTerm) {
        const results = [];
        
        try {
            // Checkout the branch
            console.log(`  Checking out branch: ${branch}`);
            this.execCommand(`git checkout -f origin/${branch}`, { cwd: repoDir });

            // Search using git grep with context
            let output;
            try {
                output = this.execCommand(
                    `git grep -n -B ${this.config.contextLines} -A ${this.config.contextLines} "${searchTerm}"`,
                    { cwd: repoDir, maxBuffer: 10 * 1024 * 1024 }
                );
            } catch (error) {
                // No matches found
                return results;
            }

            // Parse git grep output
            const lines = output.split('\n');
            let currentResult = null;
            let contextBuffer = [];

            for (const line of lines) {
                if (line === '--') {
                    // Separator between matches
                    if (currentResult && currentResult.matchLine) {
                        currentResult.context = [...contextBuffer];
                        results.push(currentResult);
                    }
                    currentResult = null;
                    contextBuffer = [];
                    continue;
                }

                const match = line.match(/^([^:]+):(\d+)[-:](.*)$/);
                if (match) {
                    const [, file, lineNum, content] = match;
                    const lineNumber = parseInt(lineNum);
                    
                    if (line.includes(':') && content.includes(searchTerm)) {
                        // This is the matching line
                        if (currentResult && currentResult.matchLine) {
                            currentResult.context = [...contextBuffer];
                            results.push(currentResult);
                        }
                        
                        currentResult = {
                            file,
                            line: lineNumber,
                            matchLine: content,
                            context: []
                        };
                        contextBuffer = [];
                    } else {
                        // This is context
                        contextBuffer.push(`${lineNum}: ${content}`);
                    }
                }
            }

            // Don't forget the last match
            if (currentResult && currentResult.matchLine) {
                currentResult.context = [...contextBuffer];
                results.push(currentResult);
            }

        } catch (error) {
            console.error(`  Error searching branch ${branch}: ${error.message}`);
        }

        return results;
    }

    async processRepository(repo, state) {
        const repoDir = path.join(this.config.tempDir, `repo_${repo.name}`);
        
        console.log(`\nProcessing repository: ${repo.name}`);
        console.log(`URL: ${repo.url}`);

        try {
            // Clone repository
            console.log('Cloning repository...');
            await fs.mkdir(this.config.tempDir, { recursive: true });
            
            this.execCommand(
                `git clone --no-checkout "${repo.url}" "${repoDir}"`,
                { stdio: 'pipe' }
            );

            // Fetch all branches
            console.log('Fetching branches...');
            this.execCommand('git fetch --all', { cwd: repoDir });

            // Get all branches sorted by date (newest first)
            const branches = await this.getBranches(repoDir);
            console.log(`Found ${branches.length} branches`);

            // Search branches from newest to oldest until we find a match
            for (const branch of branches) {
                console.log(`\n  Branch: ${branch.name} (${new Date(branch.lastCommitDate).toLocaleDateString()})`);
                
                repo.branchesChecked++;
                const matches = await this.searchInBranch(repoDir, branch.name, this.config.searchTerm);
                
                if (matches.length > 0) {
                    // Found matches! Save results and stop searching this repo
                    await this.appendResults(repo, branch, matches);
                    console.log(`  ✓ Found ${matches.length} matches - stopping search for this repository`);
                    
                    repo.foundMatch = true;
                    repo.matchingBranch = branch.name;
                    repo.processed = true;
                    state.totalMatches += matches.length;
                    
                    await this.saveState(state);
                    break; // Stop searching this repository
                } else {
                    console.log(`  No matches found`);
                }
                
                // Save progress after each branch
                await this.saveState(state);
            }

            // If we checked all branches and found no matches, mark as processed
            if (!repo.foundMatch) {
                console.log(`\nNo matches found in any branch of ${repo.name}`);
                repo.processed = true;
                await this.saveState(state);
            }

            state.totalProcessed++;

        } catch (error) {
            console.error(`Error processing repository: ${error.message}`);
            repo.error = error.message;
            repo.processed = true;
            state.totalProcessed++;
            await this.saveState(state);
        } finally {
            // Clean up repository directory
            try {
                if (await this.pathExists(repoDir)) {
                    await this.removeDirectory(repoDir);
                }
            } catch (cleanupError) {
                console.warn(`Could not clean up ${repoDir}: ${cleanupError.message}`);
            }
        }
    }

    async pathExists(path) {
        try {
            await fs.access(path);
            return true;
        } catch {
            return false;
        }
    }

    async removeDirectory(dir) {
        if (process.platform === 'win32') {
            try {
                execSync(`rmdir /s /q "${dir}"`, { stdio: 'pipe' });
            } catch (error) {
                // Try PowerShell as fallback
                execSync(`powershell -Command "Remove-Item -Path '${dir}' -Recurse -Force"`, { stdio: 'pipe' });
            }
        } else {
            await fs.rmdir(dir, { recursive: true });
        }
    }

    async appendResults(repo, branch, matches) {
        const output = [
            '\n' + '='.repeat(80),
            `REPOSITORY: ${repo.name}`,
            `BRANCH: ${branch.name} (newest branch with matches)`,
            `LAST COMMIT: ${new Date(branch.lastCommitDate).toLocaleString()}`,
            `BRANCHES CHECKED: ${repo.branchesChecked}`,
            '='.repeat(80),
            ''
        ];

        for (const match of matches) {
            output.push(`File: ${match.file}`);
            output.push(`Line ${match.line}: ${match.matchLine}`);
            
            if (match.context && match.context.length > 0) {
                output.push('\nContext:');
                match.context.forEach(line => output.push(`  ${line}`));
            }
            
            output.push('\n' + '-'.repeat(40));
        }

        await fs.appendFile(this.config.resultsFile, output.join('\n') + '\n');
    }

    async run() {
        console.log('Git Repository Search Tool');
        console.log('==========================\n');
        console.log(`Search term: "${this.config.searchTerm}"`);
        console.log('Strategy: Find newest branch with matches per repository\n');

        // Load or create state
        let state = await this.loadState();

        if (!state || state.searchTerm !== this.config.searchTerm) {
            if (state && state.searchTerm !== this.config.searchTerm) {
                console.log('Search term changed, starting fresh...\n');
            }
            console.log('Initializing...');
            state = await this.buildInitialState();
            await this.saveState(state);
            
            // Clear results file
            await fs.writeFile(
                this.config.resultsFile, 
                `Git Repository Search Results
Search Term: "${this.config.searchTerm}"
Strategy: Find newest branch with matches per repository
Generated: ${new Date().toISOString()}
${'='.repeat(80)}\n`
            );
        }

        // Process statistics
        const totalRepos = state.repositories.length;
        const processedRepos = state.repositories.filter(r => r.processed).length;
        const reposWithMatches = state.repositories.filter(r => r.foundMatch).length;

        console.log(`Progress: ${processedRepos}/${totalRepos} repositories processed`);
        console.log(`Matches found in: ${reposWithMatches} repositories`);
        console.log(`Total matches: ${state.totalMatches}\n`);

        // Process remaining repositories
        while (true) {
            const repoToProcess = state.repositories.find(r => !r.processed);

            if (!repoToProcess) {
                console.log('\n✓ All repositories have been processed!');
                break;
            }

            await this.processRepository(repoToProcess, state);
        }

        // Final summary
        console.log('\n' + '='.repeat(50));
        console.log('SEARCH COMPLETE');
        console.log('='.repeat(50));
        console.log(`Total repositories: ${totalRepos}`);
        console.log(`Repositories with matches: ${state.repositories.filter(r => r.foundMatch).length}`);
        console.log(`Repositories without matches: ${state.repositories.filter(r => r.processed && !r.foundMatch).length}`);
        console.log(`Total matches found: ${state.totalMatches}`);
        console.log(`\nResults saved to: ${this.config.resultsFile}`);

        // List repositories with matches
        const matchedRepos = state.repositories.filter(r => r.foundMatch);
        if (matchedRepos.length > 0) {
            console.log('\nRepositories with matches:');
            matchedRepos.forEach(r => {
                console.log(`  - ${r.name} (branch: ${r.matchingBranch})`);
            });
        }
    }
}

// Main execution
async function main() {
    // Check if git is available
    try {
        execSync('git --version', { stdio: 'pipe' });
    } catch (error) {
        console.error('Git is not installed or not in PATH');
        process.exit(1);
    }

    const searcher = new GitSearcher(CONFIG);

    try {
        await searcher.run();
    } catch (error) {
        console.error('Fatal error:', error);
        process.exit(1);
    }
}

// Handle Ctrl+C gracefully
process.on('SIGINT', () => {
    console.log('\n\nInterrupted! Progress has been saved.');
    console.log('Run the script again to continue where you left off.');
    process.exit(0);
});

// Run the script
main();
