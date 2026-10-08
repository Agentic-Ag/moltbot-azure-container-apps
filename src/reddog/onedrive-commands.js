/**
 * Red Dog OneDrive Sync Commands
 * 
 * Handles OneDrive sync commands from user messages
 */

class OneDriveCommands {
    constructor({ oneDriveSync }) {
        this.oneDriveSync = oneDriveSync;
    }

    /**
     * Parse OneDrive sync commands from user message
     */
    parseCommand(message) {
        const msg = message.toLowerCase().trim();
        
        // Sync now: "sync onedrive", "sync files", "run sync"
        if (msg.match(/^(sync|run)\s+(onedrive|files|project)$/)) {
            return { action: 'sync' };
        }
        
        // Sync status: "sync status", "sync info"
        if (msg.match(/^(sync|onedrive)\s+(status|info)$/)) {
            return { action: 'status' };
        }
        
        // Search files: "search files <query>", "find files <query>"
        const searchMatch = msg.match(/^(search|find)\s+files\s+(.+)$/);
        if (searchMatch) {
            return {
                action: 'search',
                query: searchMatch[2]
            };
        }
        
        // Get file: "get file <fileId>", "show file <fileId>"
        const getFileMatch = msg.match(/^(get|show)\s+file\s+(.+)$/);
        if (getFileMatch) {
            return {
                action: 'get_file',
                fileId: getFileMatch[2]
            };
        }
        
        // List files: "list files", "show files"
        if (msg.match(/^(list|show)\s+files$/)) {
            return { action: 'list' };
        }
        
        // Start scheduled sync: "start sync", "enable sync"
        if (msg.match(/^(start|enable)\s+sync$/)) {
            return { action: 'start_sync' };
        }
        
        // Stop scheduled sync: "stop sync", "disable sync"
        if (msg.match(/^(stop|disable)\s+sync$/)) {
            return { action: 'stop_sync' };
        }
        
        return null;
    }

    /**
     * Execute OneDrive command
     */
    async execute(command, userId = 'system') {
        switch (command.action) {
            case 'sync':
                return await this.handleSync();
            
            case 'status':
                return await this.handleStatus();
            
            case 'search':
                return await this.handleSearch(command.query);
            
            case 'get_file':
                return await this.handleGetFile(command.fileId);
            
            case 'list':
                return await this.handleList();
            
            case 'start_sync':
                return await this.handleStartSync();
            
            case 'stop_sync':
                return await this.handleStopSync();
            
            default:
                return { error: 'Unknown OneDrive command' };
        }
    }

    /**
     * Handle sync command
     */
    async handleSync() {
        try {
            await this.oneDriveSync.performSync();
            
            const status = this.oneDriveSync.getSyncStatus();
            
            return {
                success: true,
                message: `✅ OneDrive sync completed\n\n` +
                        `**Files Processed:** ${status.filesProcessed}\n` +
                        `**Last Sync:** ${status.lastSync?.toLocaleString() || 'Never'}\n` +
                        `**Errors:** ${status.errors.length}\n` +
                        (status.errors.length > 0 ? `**Error Details:** ${status.errors.join(', ')}` : '')
            };
        } catch (err) {
            return {
                success: false,
                error: err.message,
                message: `❌ Sync failed: ${err.message}`
            };
        }
    }

    /**
     * Handle status command
     */
    async handleStatus() {
        const status = this.oneDriveSync.getSyncStatus();
        
        let message = `📊 **OneDrive Sync Status**\n\n`;
        message += `**Path:** ${status.oneDrivePath}\n`;
        message += `**Sync Interval:** ${status.syncInterval} minutes\n`;
        message += `**Scheduled Sync:** ${status.isScheduled ? 'Running' : 'Stopped'}\n`;
        message += `**Last Sync:** ${status.lastSync?.toLocaleString() || 'Never'}\n`;
        message += `**Status:** ${status.lastSyncStatus}\n`;
        message += `**Files Processed (last sync):** ${status.filesProcessed}\n`;
        
        if (status.errors.length > 0) {
            message += `\n**Recent Errors:**\n`;
            status.errors.slice(-5).forEach(err => {
                message += `- ${err}\n`;
            });
        }
        
        return {
            success: true,
            message,
            status
        };
    }

    /**
     * Handle search command
     */
    async handleSearch(query) {
        try {
            const files = await this.oneDriveSync.searchFiles(query);
            
            if (files.length === 0) {
                return {
                    success: true,
                    message: `🔍 No files found matching "${query}"`,
                    files: []
                };
            }
            
            let message = `🔍 **Search Results (${files.length})**\n\n`;
            
            for (const file of files) {
                message += `**${file.name}**\n`;
                message += `  Type: ${file.extension}\n`;
                message += `  Modified: ${new Date(file.lastModified).toLocaleString()}\n`;
                message += `  ID: ${file.fileId}\n\n`;
            }
            
            return {
                success: true,
                message,
                files
            };
        } catch (err) {
            return {
                success: false,
                error: err.message,
                message: `❌ Search failed: ${err.message}`
            };
        }
    }

    /**
     * Handle get file command
     */
    async handleGetFile(fileId) {
        try {
            const file = await this.oneDriveSync.getFileData(fileId);
            
            if (!file) {
                return {
                    success: false,
                    message: `File not found: ${fileId}`
                };
            }
            
            let message = `📄 **File Details**\n\n`;
            message += `**Name:** ${file.name}\n`;
            message += `**Type:** ${file.extension}\n`;
            message += `**Size:** ${this.formatBytes(file.size)}\n`;
            message += `**Modified:** ${new Date(file.lastModified).toLocaleString()}\n`;
            message += `**Synced:** ${new Date(file.syncedAt).toLocaleString()}\n`;
            message += `**Web URL:** ${file.webUrl}\n\n`;
            
            if (file.parsedData) {
                message += `**Parsed Data:**\n`;
                if (typeof file.parsedData === 'object') {
                    message += `\`\`\`json\n${JSON.stringify(file.parsedData, null, 2).substring(0, 1000)}\n\`\`\``;
                } else {
                    message += `${String(file.parsedData).substring(0, 1000)}`;
                }
            }
            
            return {
                success: true,
                message,
                file
            };
        } catch (err) {
            return {
                success: false,
                error: err.message,
                message: `❌ Failed to get file: ${err.message}`
            };
        }
    }

    /**
     * Handle list command
     */
    async handleList() {
        try {
            const files = await this.oneDriveSync.searchFiles('');
            
            if (files.length === 0) {
                return {
                    success: true,
                    message: '📁 No synced files found',
                    files: []
                };
            }
            
            let message = `📁 **Synced Files (${files.length})**\n\n`;
            
            for (const file of files) {
                message += `**${file.name}** (${file.extension})\n`;
                message += `  Modified: ${new Date(file.lastModified).toLocaleString()}\n\n`;
            }
            
            return {
                success: true,
                message,
                files
            };
        } catch (err) {
            return {
                success: false,
                error: err.message,
                message: `❌ Failed to list files: ${err.message}`
            };
        }
    }

    /**
     * Handle start sync command
     */
    async handleStartSync() {
        try {
            this.oneDriveSync.startScheduledSync();
            
            return {
                success: true,
                message: `✅ Scheduled sync started\n\n` +
                        `**Interval:** ${this.oneDriveSync.syncInterval} minutes\n` +
                        `**Path:** ${this.oneDriveSync.oneDrivePath}`
            };
        } catch (err) {
            return {
                success: false,
                error: err.message,
                message: `❌ Failed to start sync: ${err.message}`
            };
        }
    }

    /**
     * Handle stop sync command
     */
    async handleStopSync() {
        try {
            this.oneDriveSync.stopScheduledSync();
            
            return {
                success: true,
                message: '✅ Scheduled sync stopped'
            };
        } catch (err) {
            return {
                success: false,
                error: err.message,
                message: `❌ Failed to stop sync: ${err.message}`
            };
        }
    }

    /**
     * Format bytes to human-readable size
     */
    formatBytes(bytes) {
        if (bytes < 1024) return `${bytes} B`;
        if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
        if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
        return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
    }
}

module.exports = OneDriveCommands;
