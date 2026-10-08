/**
 * Red Dog OneDrive Sync Manager
 * 
 * Bidirectional sync between OneDrive folder and SQL database
 * Supports: Excel, Word, PDF, JSON, and other farm project files
 * Scheduled sync with configurable intervals
 */

const fs = require('fs');
const path = require('path');
const { Client } = require('@microsoft/microsoft-graph-client');
const xlsx = require('xlsx');
const pdf = require('pdf-parse');
const mammoth = require('mammoth');

class OneDriveSyncManager {
    constructor({ db, blobStorage, aiEngine, oauthManager }) {
        this.db = db;
        this.blobStorage = blobStorage;
        this.aiEngine = aiEngine;
        this.oauthManager = oauthManager;
        
        this.graphClient = null;
        this.oneDrivePath = process.env.ONEDRIVE_PATH || 'Smart Farm/Project/UF02 Grassgum Farm';
        this.syncInterval = parseInt(process.env.SYNC_INTERVAL_MINUTES) || 60; // Default 60 minutes
        this.syncTimer = null;
        
        // File type parsers
        this.parsers = {
            '.json': this.parseJSON.bind(this),
            '.xlsx': this.parseExcel.bind(this),
            '.xls': this.parseExcel.bind(this),
            '.csv': this.parseCSV.bind(this),
            '.pdf': this.parsePDF.bind(this),
            '.docx': this.parseWord.bind(this),
            '.doc': this.parseWord.bind(this),
            '.txt': this.parseText.bind(this)
        };
        
        // Sync state tracking
        this.syncState = {
            lastSync: null,
            lastSyncStatus: 'idle',
            filesProcessed: 0,
            errors: []
        };
    }

    /**
     * Initialize Microsoft Graph client
     */
    async initialize() {
        // Check if OAuth manager is available and authenticated
        if (this.oauthManager) {
            const accessToken = await this.oauthManager.getAccessToken();
            
            if (!accessToken) {
                console.log('[OneDriveSync] Disabled (OAuth not authenticated - visit /api/onedrive/login to authenticate)');
                return false;
            }
            
            // Create Graph client with OAuth token provider
            this.graphClient = Client.init({
                authProvider: {
                    getAccessToken: async () => {
                        return await this.oauthManager.getAccessToken();
                    }
                }
            });
            
            console.log('[OneDriveSync] Initialized with OAuth');
            console.log(`[OneDriveSync] Path: ${this.oneDrivePath}`);
            console.log(`[OneDriveSync] Sync Interval: ${this.syncInterval} minutes`);
            
            return true;
        }
        
        // Fallback to manual access token (deprecated)
        const accessToken = process.env.MICROSOFT_GRAPH_ACCESS_TOKEN;
        
        if (!accessToken) {
            console.log('[OneDriveSync] Disabled (MICROSOFT_GRAPH_ACCESS_TOKEN not set)');
            return false;
        }
        
        // Create Graph client
        this.graphClient = Client.init({
            authProvider: {
                getAccessToken: async () => accessToken
            }
        });
        
        console.log('[OneDriveSync] Initialized with manual token (deprecated - use OAuth)');
        console.log(`[OneDriveSync] Path: ${this.oneDrivePath}`);
        console.log(`[OneDriveSync] Sync Interval: ${this.syncInterval} minutes`);
        
        return true;
    }

    /**
     * Start scheduled sync
     */
    startScheduledSync() {
        if (this.syncTimer) {
            clearInterval(this.syncTimer);
        }
        
        // Initial sync
        this.performSync();
        
        // Schedule recurring sync
        this.syncTimer = setInterval(() => {
            this.performSync();
        }, this.syncInterval * 60 * 1000);
        
        console.log(`[OneDriveSync] Scheduled sync started (every ${this.syncInterval} minutes)`);
    }

    /**
     * Stop scheduled sync
     */
    stopScheduledSync() {
        if (this.syncTimer) {
            clearInterval(this.syncTimer);
            this.syncTimer = null;
            console.log('[OneDriveSync] Scheduled sync stopped');
        }
    }

    /**
     * Perform sync operation
     */
    async performSync() {
        console.log('[OneDriveSync] Starting sync...');
        this.syncState.lastSyncStatus = 'running';
        this.syncState.filesProcessed = 0;
        this.syncState.errors = [];
        
        try {
            // 1. Sync OneDrive → SQL
            await this.syncOneDriveToSQL();
            
            // 2. Sync SQL → OneDrive
            await this.syncSQLToOneDrive();
            
            this.syncState.lastSync = new Date();
            this.syncState.lastSyncStatus = 'completed';
            
            console.log(`[OneDriveSync] Sync completed. Files processed: ${this.syncState.filesProcessed}`);
            
            if (this.syncState.errors.length > 0) {
                console.warn(`[OneDriveSync] Errors: ${this.syncState.errors.length}`);
                this.syncState.errors.forEach(err => console.warn(`  - ${err}`));
            }
        } catch (err) {
            console.error('[OneDriveSync] Sync failed:', err);
            this.syncState.lastSyncStatus = 'failed';
            this.syncState.errors.push(err.message);
        }
    }

    /**
     * Sync OneDrive files to SQL database
     */
    async syncOneDriveToSQL() {
        try {
            // Get files from OneDrive
            const files = await this.getOneDriveFiles();
            
            for (const file of files) {
                try {
                    await this.processOneDriveFile(file);
                    this.syncState.filesProcessed++;
                } catch (err) {
                    console.error(`[OneDriveSync] Failed to process file ${file.name}:`, err);
                    this.syncState.errors.push(`${file.name}: ${err.message}`);
                }
            }
        } catch (err) {
            throw new Error(`OneDrive → SQL sync failed: ${err.message}`);
        }
    }

    /**
     * Get files from OneDrive folder
     */
    async getOneDriveFiles() {
        try {
            // Encode path for Graph API
            const encodedPath = encodeURIComponent(this.oneDrivePath);
            
            // Get folder contents
            const response = await this.graphClient
                .api(`/me/drive/root:/${encodedPath}:/children`)
                .select('id,name,size,lastModifiedDateTime,file,webUrl')
                .get();
            
            if (!response.value) {
                return [];
            }
            
            return response.value.map(file => ({
                id: file.id,
                name: file.name,
                size: file.size,
                lastModified: new Date(file.lastModifiedDateTime),
                webUrl: file.webUrl,
                extension: path.extname(file.name).toLowerCase()
            }));
        } catch (err) {
            throw new Error(`Failed to get OneDrive files: ${err.message}`);
        }
    }

    /**
     * Process a single OneDrive file
     */
    async processOneDriveFile(file) {
        // Check if file already exists in database and is up to date
        const existingFile = await this.getFileFromDB(file.id);
        
        if (existingFile && new Date(existingFile.lastModified) >= file.lastModified) {
            console.log(`[OneDriveSync] Skipping ${file.name} (up to date)`);
            return;
        }
        
        // Download file content
        const content = await this.downloadFileContent(file.id);
        
        // Parse file based on type
        const parser = this.parsers[file.extension];
        let parsedData = null;
        
        if (parser) {
            try {
                parsedData = await parser(content, file);
            } catch (err) {
                console.warn(`[OneDriveSync] Failed to parse ${file.name}: ${err.message}`);
                parsedData = { raw: content.toString('base64'), parseError: err.message };
            }
        } else {
            // Store binary files as base64
            parsedData = { raw: content.toString('base64') };
        }
        
        // Store in database
        await this.storeFileInDB(file, parsedData, content);
        
        // Store raw file in blob storage
        await this.blobStorage.writeBlob('onedrive-files', file.id, content);
        
        console.log(`[OneDriveSync] Processed ${file.name}`);
    }

    /**
     * Download file content from OneDrive
     */
    async downloadFileContent(fileId) {
        try {
            const response = await this.graphClient
                .api(`/me/drive/items/${fileId}/content`)
                .responseType('arraybuffer')
                .get();
            
            return Buffer.from(response);
        } catch (err) {
            throw new Error(`Failed to download file ${fileId}: ${err.message}`);
        }
    }

    /**
     * Parse JSON file
     */
    parseJSON(content, file) {
        const text = content.toString('utf-8');
        return JSON.parse(text);
    }

    /**
     * Parse Excel file
     */
    parseExcel(content, file) {
        const workbook = xlsx.read(content, { type: 'buffer' });
        const result = {};
        
        workbook.SheetNames.forEach(sheetName => {
            const worksheet = workbook.Sheets[sheetName];
            const data = xlsx.utils.sheet_to_json(worksheet, { defval: null });
            result[sheetName] = data;
        });
        
        return { sheets: result, sheetNames: workbook.SheetNames };
    }

    /**
     * Parse CSV file
     */
    parseCSV(content, file) {
        const workbook = xlsx.read(content, { type: 'buffer' });
        const worksheet = workbook.Sheets[workbook.SheetNames[0]];
        const data = xlsx.utils.sheet_to_json(worksheet, { defval: null });
        return data;
    }

    /**
     * Parse PDF file
     */
    async parsePDF(content, file) {
        const data = await pdf(content);
        return {
            text: data.text,
            pages: data.numpages,
            info: data.info
        };
    }

    /**
     * Parse Word file
     */
    async parseWord(content, file) {
        const result = await mammoth.extractRawText({ buffer: content });
        return {
            text: result.value,
            messages: result.messages
        };
    }

    /**
     * Parse text file
     */
    parseText(content, file) {
        return content.toString('utf-8');
    }

    /**
     * Store file metadata and data in SQL database
     */
    async storeFileInDB(file, parsedData, content) {
        const pool = this.db.pools['zerosumag'] || this.db.pools[Object.keys(this.db.pools)[0]];
        
        if (!pool) {
            throw new Error('No database pool available');
        }
        
        try {
            // Check if table exists, create if not
            await this.ensureOneDriveTable(pool);
            
            // Upsert file record
            const query = `
                MERGE reddog.OneDriveFiles AS target
                USING (VALUES (@fileId, @name, @size, @lastModified, @extension, @webUrl, @parsedData, @contentType))
                AS source (fileId, name, size, lastModified, extension, webUrl, parsedData, contentType)
                ON target.fileId = source.fileId
                WHEN MATCHED THEN
                    UPDATE SET 
                        name = source.name,
                        size = source.size,
                        lastModified = source.lastModified,
                        extension = source.extension,
                        webUrl = source.webUrl,
                        parsedData = source.parsedData,
                        contentType = source.contentType,
                        syncedAt = GETDATE()
                WHEN NOT MATCHED THEN
                    INSERT (fileId, name, size, lastModified, extension, webUrl, parsedData, contentType, syncedAt)
                    VALUES (source.fileId, source.name, source.size, source.lastModified, source.extension, source.webUrl, source.parsedData, source.contentType, GETDATE());
            `;
            
            await pool.request()
                .input('fileId', file.id)
                .input('name', file.name)
                .input('size', file.size)
                .input('lastModified', file.lastModified)
                .input('extension', file.extension)
                .input('webUrl', file.webUrl)
                .input('parsedData', JSON.stringify(parsedData))
                .input('contentType', this.getMimeType(file.extension))
                .query(query);
                
        } catch (err) {
            throw new Error(`Failed to store file in DB: ${err.message}`);
        }
    }

    /**
     * Get file from database
     */
    async getFileFromDB(fileId) {
        const pool = this.db.pools['zerosumag'] || this.db.pools[Object.keys(this.db.pools)[0]];
        
        if (!pool) {
            return null;
        }
        
        try {
            const result = await pool.request()
                .input('fileId', fileId)
                .query('SELECT * FROM reddog.OneDriveFiles WHERE fileId = @fileId');
            
            return result.recordset[0] || null;
        } catch (err) {
            // Table might not exist yet
            return null;
        }
    }

    /**
     * Ensure OneDrive table exists
     */
    async ensureOneDriveTable(pool) {
        const createTableQuery = `
            IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = 'OneDriveFiles')
            BEGIN
                CREATE TABLE reddog.OneDriveFiles (
                    fileId NVARCHAR(255) PRIMARY KEY,
                    name NVARCHAR(500),
                    size BIGINT,
                    lastModified DATETIME,
                    extension NVARCHAR(50),
                    webUrl NVARCHAR(MAX),
                    parsedData NVARCHAR(MAX),
                    contentType NVARCHAR(100),
                    syncedAt DATETIME,
                    createdAt DATETIME DEFAULT GETDATE()
                );
                CREATE INDEX IX_OneDriveFiles_LastModified ON reddog.OneDriveFiles(lastModified);
                CREATE INDEX IX_OneDriveFiles_Extension ON reddog.OneDriveFiles(extension);
            END
        `;
        
        await pool.request().query(createTableQuery);
    }

    /**
     * Sync SQL data changes back to OneDrive
     */
    async syncSQLToOneDrive() {
        if (!this.graphClient) {
            console.log('[OneDriveSync] SQL → OneDrive sync: Graph client not initialized');
            return;
        }

        try {
            console.log('[OneDriveSync] Starting SQL → OneDrive sync for reports...');
            
            // Check for pending report uploads in the database
            const pool = this.db.pools['zerosumag'] || this.db.pools[Object.keys(this.db.pools)[0]];
            
            if (!pool) {
                console.log('[OneDriveSync] No database pool available');
                return;
            }

            // Create a table for tracking pending uploads if it doesn't exist
            await this.ensureReportUploadsTable(pool);

            // Get pending uploads
            const pendingUploads = await pool.request()
                .query(`
                    SELECT * FROM reddog.ReportUploads 
                    WHERE status = 'pending' 
                    ORDER BY createdAt ASC
                `);

            if (pendingUploads.recordset.length === 0) {
                console.log('[OneDriveSync] No pending reports to upload');
                return;
            }

            console.log(`[OneDriveSync] Found ${pendingUploads.recordset.length} pending reports to upload`);

            // Upload each pending report
            for (const upload of pendingUploads.recordset) {
                try {
                    await this.uploadReportToOneDrive(upload, pool);
                    console.log(`[OneDriveSync] Uploaded report: ${upload.filename}`);
                } catch (error) {
                    console.error(`[OneDriveSync] Failed to upload report ${upload.filename}:`, error.message);
                    // Mark as failed
                    await pool.request()
                        .input('uploadId', upload.uploadId)
                        .query(`
                            UPDATE reddog.ReportUploads 
                            SET status = 'failed', 
                                errorMessage = @errorMessage,
                                updatedAt = GETDATE()
                            WHERE uploadId = @uploadId
                        `)
                        .input('errorMessage', error.message);
                }
            }

            console.log('[OneDriveSync] SQL → OneDrive sync completed');
        } catch (error) {
            console.error('[OneDriveSync] SQL → OneDrive sync error:', error.message);
        }
    }

    /**
     * Ensure ReportUploads table exists
     */
    async ensureReportUploadsTable(pool) {
        const createTableQuery = `
            IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = 'ReportUploads')
            BEGIN
                CREATE TABLE reddog.ReportUploads (
                    uploadId NVARCHAR(255) PRIMARY KEY,
                    filename NVARCHAR(500),
                    contentType NVARCHAR(100),
                    content NVARCHAR(MAX),
                    folderPath NVARCHAR(500),
                    status NVARCHAR(50),
                    errorMessage NVARCHAR(MAX),
                    oneDriveFileId NVARCHAR(255),
                    oneDriveWebUrl NVARCHAR(MAX),
                    createdAt DATETIME DEFAULT GETDATE(),
                    updatedAt DATETIME
                );
                CREATE INDEX IX_ReportUploads_Status ON reddog.ReportUploads(status);
                CREATE INDEX IX_ReportUploads_CreatedAt ON reddog.ReportUploads(createdAt);
            END
        `;
        
        await pool.request().query(createTableQuery);
    }

    /**
     * Upload a report to OneDrive
     */
    async uploadReportToOneDrive(upload, pool) {
        // Get the content from blob storage if it's stored there
        let content = upload.content;
        
        if (!content && upload.uploadId) {
            // Try to get from blob storage
            try {
                const blobContent = await this.blobStorage.downloadBlob(`reports/${upload.filename}`);
                content = blobContent.toString('base64');
            } catch (error) {
                console.log(`[OneDriveSync] Could not retrieve from blob storage, using database content`);
            }
        }

        if (!content) {
            throw new Error('No content available for upload');
        }

        // Convert base64 to buffer
        const buffer = Buffer.from(content, 'base64');

        // Ensure folder exists
        const folderPath = upload.folderPath || this.oneDrivePath + '/Reports';
        await this.ensureFolderExists(folderPath);

        // Upload to OneDrive
        const uploadUrl = `/me/drive/root:/${folderPath}/${upload.filename}:/content`;
        
        const response = await this.graphClient.api(uploadUrl)
            .put(buffer);

        // Update database with success
        await pool.request()
            .input('uploadId', upload.uploadId)
            .input('oneDriveFileId', response.id)
            .input('oneDriveWebUrl', response.webUrl)
            .query(`
                UPDATE reddog.ReportUploads 
                SET status = 'completed',
                    oneDriveFileId = @oneDriveFileId,
                    oneDriveWebUrl = @oneDriveWebUrl,
                    updatedAt = GETDATE()
                WHERE uploadId = @uploadId
            `);

        return response;
    }

    /**
     * Ensure a folder exists in OneDrive
     */
    async ensureFolderExists(folderPath) {
        const pathParts = folderPath.split('/');
        let currentPath = '/me/drive/root';
        
        for (const part of pathParts) {
            if (!part) continue;
            
            try {
                // Check if folder exists
                const children = await this.graphClient.api(`${currentPath}/children`)
                    .filter("name eq '" + part + "' and folder ne null")
                    .get();
                
                if (children.value.length === 0) {
                    // Create folder
                    const newFolder = await this.graphClient.api(`${currentPath}/children`)
                        .post({
                            name: part,
                            folder: {}
                        });
                    currentPath = newFolder.parentReference.path + '/' + newFolder.name;
                } else {
                    currentPath = children.value[0].parentReference.path + '/' + children.value[0].name;
                }
            } catch (error) {
                console.log(`[OneDriveSync] Error checking/creating folder ${part}:`, error.message);
            }
        }
    }

    /**
     * Queue a report for upload to OneDrive
     */
    async queueReportForUpload(filename, content, contentType, folderPath = null) {
        const pool = this.db.pools['zerosumag'] || this.db.pools[Object.keys(this.db.pools)[0]];
        
        if (!pool) {
            console.log('[OneDriveSync] No database pool available for queueing report');
            return null;
        }

        try {
            await this.ensureReportUploadsTable(pool);
            
            const uploadId = `report-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
            
            await pool.request()
                .input('uploadId', uploadId)
                .input('filename', filename)
                .input('contentType', contentType)
                .input('content', content)
                .input('folderPath', folderPath || this.oneDrivePath + '/Reports')
                .query(`
                    INSERT INTO reddog.ReportUploads (uploadId, filename, contentType, content, folderPath, status, createdAt)
                    VALUES (@uploadId, @filename, @contentType, @content, @folderPath, 'pending', GETDATE())
                `);
            
            console.log(`[OneDriveSync] Queued report for upload: ${filename}`);
            return uploadId;
        } catch (error) {
            console.error('[OneDriveSync] Failed to queue report:', error.message);
            return null;
        }
    }

    /**
     * Get MIME type for file extension
     */
    getMimeType(extension) {
        const mimeTypes = {
            '.json': 'application/json',
            '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            '.xls': 'application/vnd.ms-excel',
            '.csv': 'text/csv',
            '.pdf': 'application/pdf',
            '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
            '.doc': 'application/msword',
            '.txt': 'text/plain',
            '.jpg': 'image/jpeg',
            '.jpeg': 'image/jpeg',
            '.png': 'image/png',
            '.dwg': 'application/acad',
            '.dxf': 'application/dxf'
        };
        
        return mimeTypes[extension] || 'application/octet-stream';
    }

    /**
     * Get sync status
     */
    getSyncStatus() {
        return {
            ...this.syncState,
            oneDrivePath: this.oneDrivePath,
            syncInterval: this.syncInterval,
            isScheduled: !!this.syncTimer
        };
    }

    /**
     * Search synced files
     */
    async searchFiles(query) {
        const pool = this.db.pools['zerosumag'] || this.db.pools[Object.keys(this.db.pools)[0]];
        
        if (!pool) {
            return [];
        }
        
        try {
            const searchQuery = `
                SELECT fileId, name, extension, lastModified, webUrl
                FROM reddog.OneDriveFiles
                WHERE name LIKE @query OR extension LIKE @query
                ORDER BY lastModified DESC
            `;
            
            const result = await pool.request()
                .input('query', `%${query}%`)
                .query(searchQuery);
            
            return result.recordset;
        } catch (err) {
            console.error('[OneDriveSync] Search failed:', err);
            return [];
        }
    }

    /**
     * Get file data from database
     */
    async getFileData(fileId) {
        const pool = this.db.pools['zerosumag'] || this.db.pools[Object.keys(this.db.pools)[0]];
        
        if (!pool) {
            return null;
        }
        
        try {
            const result = await pool.request()
                .input('fileId', fileId)
                .query('SELECT * FROM reddog.OneDriveFiles WHERE fileId = @fileId');
            
            const file = result.recordset[0];
            if (file && file.parsedData) {
                file.parsedData = JSON.parse(file.parsedData);
            }
            return file;
        } catch (err) {
            console.error('[OneDriveSync] Get file data failed:', err);
            return null;
        }
    }

    /**
     * Disconnect
     */
    disconnect() {
        this.stopScheduledSync();
        console.log('[OneDriveSync] Disconnected');
    }
}

module.exports = OneDriveSyncManager;
