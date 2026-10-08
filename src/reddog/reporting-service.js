/**
 * Red Dog Automated Reporting Service
 * 
 * Integrates automated reporting capabilities into Red Dog agent
 * - SQL database reports
 * - Azure Blob Storage reports
 * - Excel/CSV file reports
 * - Scheduled automated reports
 * - Report templates
 * 
 * Integrates with existing EmailManager for delivery
 */

const sql = require('mssql');
const { BlobServiceClient } = require('@azure/storage-blob');
const xlsx = require('xlsx');
const cron = require('node-cron');
const fs = require('fs');
const path = require('path');

class RedDogReportingService {
    constructor({ emailManager, blobStorage, aiEngine, databaseContext }) {
        this.emailManager = emailManager;
        this.blobStorage = blobStorage;
        this.aiEngine = aiEngine;
        this.databaseContext = databaseContext;
        
        // Database configuration
        this.dbConfig = {
            server: process.env.DB_SERVER || databaseContext?.server || 'localhost',
            database: process.env.DB_NAME || databaseContext?.database || 'RedDogDB',
            user: process.env.DB_USER || databaseContext?.user || 'sa',
            password: process.env.DB_PASSWORD || databaseContext?.password,
            options: {
                encrypt: true,
                trustServerCertificate: true
            }
        };
        
        // Azure Blob Storage configuration
        this.blobConnectionString = process.env.AZURE_STORAGE_CONNECTION_STRING;
        this.blobContainerName = process.env.BLOB_CONTAINER_NAME || 'reports';
        
        // Storage directories
        this.dataDirectory = path.join(__dirname, '../../data/reports');
        this.templatesDirectory = path.join(__dirname, '../../data/templates');
        
        // Ensure directories exist
        this.ensureDirectories();
        
        // Scheduled reports
        this.scheduledReports = new Map();
        
        // SQL connection pool
        this.sqlPool = null;
        
        // Initialize
        this.initialize();
    }
    
    async initialize() {
        try {
            // Initialize SQL connection
            await this.initializeSQLConnection();
            
            // Initialize Blob Storage
            await this.initializeBlobStorage();
            
            console.log('Red Dog Reporting Service initialized successfully');
        } catch (error) {
            console.error('Failed to initialize Red Dog Reporting Service:', error);
            throw error;
        }
    }
    
    ensureDirectories() {
        if (!fs.existsSync(this.dataDirectory)) {
            fs.mkdirSync(this.dataDirectory, { recursive: true });
        }
        if (!fs.existsSync(this.templatesDirectory)) {
            fs.mkdirSync(this.templatesDirectory, { recursive: true });
        }
    }
    
    async initializeSQLConnection() {
        try {
            this.sqlPool = await sql.connect(this.dbConfig);
            console.log('SQL Database connected for reporting');
        } catch (error) {
            console.error('SQL connection failed:', error);
            throw error;
        }
    }
    
    async initializeBlobStorage() {
        try {
            if (this.blobConnectionString) {
                this.blobServiceClient = BlobServiceClient.fromConnectionString(this.blobConnectionString);
                this.containerClient = this.blobServiceClient.getContainerClient(this.blobContainerName);
                
                // Create container if it doesn't exist
                await this.containerClient.createIfNotExists();
                console.log('Azure Blob Storage initialized for reporting');
            } else {
                console.log('Azure Blob Storage not configured for reporting');
            }
        } catch (error) {
            console.error('Blob Storage initialization failed:', error);
            throw error;
        }
    }
    
    /**
     * Generate SQL report and send via email
     */
    async generateAndSendSQLReport(reportConfig) {
        try {
            const { recipients, subject, query, params, title, description } = reportConfig;
            
            // Execute SQL query
            const data = await this.executeSQLQuery(query, params);
            
            // Generate HTML report
            const htmlReport = this.generateHTMLReport(data, title, description);
            
            // Send email via EmailManager
            const emailResult = await this.emailManager.sendEmail({
                to: recipients,
                subject: subject,
                html: htmlReport,
                text: this.htmlToText(htmlReport)
            });
            
            return {
                success: true,
                recordCount: data.length,
                emailResult,
                generatedAt: new Date().toISOString()
            };
        } catch (error) {
            console.error('SQL report generation failed:', error);
            throw error;
        }
    }
    
    /**
     * Execute SQL query
     */
    async executeSQLQuery(query, params = {}) {
        try {
            const request = this.sqlPool.request();
            
            // Add parameters
            Object.entries(params).forEach(([key, value]) => {
                request.input(key, value);
            });
            
            const result = await request.query(query);
            return result.recordset;
        } catch (error) {
            console.error('SQL query failed:', error);
            throw error;
        }
    }
    
    /**
     * Generate report from Blob Storage file
     */
    async generateAndSendBlobReport(reportConfig) {
        try {
            const { recipients, subject, blobName, fileType, title, description } = reportConfig;
            
            // Download blob
            const localPath = path.join(this.dataDirectory, path.basename(blobName));
            await this.downloadBlob(blobName, localPath);
            
            let data;
            if (fileType === 'excel') {
                data = await this.readExcelFile(localPath);
            } else if (fileType === 'csv') {
                data = await this.readCSVFile(localPath);
            } else if (fileType === 'json') {
                data = JSON.parse(fs.readFileSync(localPath, 'utf8'));
            }
            
            // Generate HTML report
            const htmlReport = this.generateHTMLReport(
                Array.isArray(data) ? data : [data],
                title,
                description
            );
            
            // Send email via EmailManager
            const emailResult = await this.emailManager.sendEmail({
                to: recipients,
                subject: subject,
                html: htmlReport,
                text: this.htmlToText(htmlReport)
            });
            
            return {
                success: true,
                recordCount: Array.isArray(data) ? data.length : 1,
                emailResult,
                generatedAt: new Date().toISOString()
            };
        } catch (error) {
            console.error('Blob report generation failed:', error);
            throw error;
        }
    }
    
    /**
     * Download blob from Azure Storage
     */
    async downloadBlob(blobName, localPath) {
        try {
            const blockBlobClient = this.containerClient.getBlockBlobClient(blobName);
            const downloadResponse = await blockBlobClient.download();
            
            const fileStream = fs.createWriteStream(localPath);
            await downloadResponse.readableStreamBody.pipeTo(fileStream);
            
            return localPath;
        } catch (error) {
            console.error('Blob download failed:', error);
            throw error;
        }
    }
    
    /**
     * Read Excel file
     */
    async readExcelFile(filePath) {
        try {
            const workbook = xlsx.readFile(filePath);
            const data = {};
            
            workbook.SheetNames.forEach(sheetName => {
                const worksheet = workbook.Sheets[sheetName];
                data[sheetName] = xlsx.utils.sheet_to_json(worksheet);
            });
            
            return data;
        } catch (error) {
            console.error('Excel read failed:', error);
            throw error;
        }
    }
    
    /**
     * Read CSV file
     */
    async readCSVFile(filePath) {
        try {
            const workbook = xlsx.readFile(filePath);
            const worksheet = workbook.Sheets[workbook.SheetNames[0]];
            return xlsx.utils.sheet_to_json(worksheet);
        } catch (error) {
            console.error('CSV read failed:', error);
            throw error;
        }
    }
    
    /**
     * Generate HTML report
     */
    generateHTMLReport(data, title, description = '') {
        if (!data || data.length === 0) {
            return this.generateEmptyReport(title, description);
        }
        
        const columns = Object.keys(data[0]);
        const timestamp = new Date().toLocaleString();
        
        let tableHTML = `
            <table style="width: 100%; border-collapse: collapse; margin-top: 20px;">
                <thead>
                    <tr style="background-color: #e74c3c; color: white;">
                        ${columns.map(col => `<th style="padding: 12px; text-align: left; border: 1px solid #ddd;">${col}</th>`).join('')}
                    </tr>
                </thead>
                <tbody>
                    ${data.map((row, index) => `
                        <tr style="${index % 2 === 0 ? 'background-color: #f8f9fa;' : ''}">
                            ${columns.map(col => `<td style="padding: 10px; border: 1px solid #ddd;">${row[col] !== null ? row[col] : 'N/A'}</td>`).join('')}
                        </tr>
                    `).join('')}
                </tbody>
            </table>
        `;
        
        return `
            <!DOCTYPE html>
            <html>
            <head>
                <meta charset="utf-8">
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
                <title>Red Dog Report - ${title}</title>
                <style>
                    body { font-family: Arial, sans-serif; margin: 0; padding: 20px; background-color: #f8f9fa; }
                    .container { max-width: 1200px; margin: 0 auto; background-color: white; border-radius: 8px; box-shadow: 0 2px 4px rgba(0,0,0,0.1); padding: 30px; }
                    .header { border-bottom: 3px solid #e74c3c; padding-bottom: 20px; margin-bottom: 20px; }
                    .title { color: #333; font-size: 24px; margin: 0; }
                    .description { color: #666; font-size: 14px; margin-top: 10px; }
                    .metadata { color: #888; font-size: 12px; margin-top: 15px; }
                    .summary { background-color: #fff3cd; padding: 15px; border-radius: 5px; margin-bottom: 20px; border-left: 4px solid #ffc107; }
                    .footer { margin-top: 30px; padding-top: 20px; border-top: 1px solid #ddd; color: #888; font-size: 12px; }
                </style>
            </head>
            <body>
                <div class="container">
                    <div class="header">
                        <h1 class="title">🐕 Red Dog Report: ${title}</h1>
                        <p class="description">${description}</p>
                        <div class="metadata">Generated: ${timestamp} | Total Records: ${data.length}</div>
                    </div>
                    
                    <div class="summary">
                        <strong>Report Summary:</strong> ${data.length} records found in dataset
                    </div>
                    
                    ${tableHTML}
                    
                    <div class="footer">
                        Generated by Red Dog Automated Reporting Service | ZerosumAg Platform
                    </div>
                </div>
            </body>
            </html>
        `;
    }
    
    generateEmptyReport(title, description = '') {
        const timestamp = new Date().toLocaleString();
        
        return `
            <!DOCTYPE html>
            <html>
            <head>
                <meta charset="utf-8">
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
                <title>Red Dog Report - ${title}</title>
                <style>
                    body { font-family: Arial, sans-serif; margin: 0; padding: 20px; background-color: #f8f9fa; }
                    .container { max-width: 600px; margin: 0 auto; background-color: white; border-radius: 8px; box-shadow: 0 2px 4px rgba(0,0,0,0.1); padding: 30px; text-align: center; }
                    .icon { font-size: 48px; margin-bottom: 20px; }
                    .title { color: #333; font-size: 24px; margin: 0; }
                    .message { color: #666; font-size: 16px; margin-top: 15px; }
                    .metadata { color: #888; font-size: 12px; margin-top: 20px; }
                </style>
            </head>
            <body>
                <div class="container">
                    <div class="icon">📊</div>
                    <h1 class="title">🐕 Red Dog Report: ${title}</h1>
                    <p class="description">${description}</p>
                    <p class="message">No data available for this report.</p>
                    <div class="metadata">Generated: ${timestamp}</div>
                </div>
            </body>
            </html>
        `;
    }
    
    htmlToText(html) {
        return html.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
    }
    
    /**
     * Schedule automated report
     */
    scheduleReport(scheduleConfig) {
        const { scheduleId, cronExpression, reportConfig, enabled = true } = scheduleConfig;
        
        if (!enabled) {
            console.log(`Schedule ${scheduleId} is disabled`);
            return;
        }
        
        const task = cron.schedule(cronExpression, async () => {
            try {
                console.log(`🐕 Red Dog executing scheduled report: ${scheduleId}`);
                
                if (reportConfig.reportType === 'sql') {
                    await this.generateAndSendSQLReport(reportConfig);
                } else if (reportConfig.reportType === 'blob') {
                    await this.generateAndSendBlobReport(reportConfig);
                }
                
                console.log(`🐕 Red Dog scheduled report ${scheduleId} completed`);
            } catch (error) {
                console.error(`🐕 Red Dog scheduled report ${scheduleId} failed:`, error);
            }
        }, {
            scheduled: true,
            timezone: scheduleConfig.timezone || 'Australia/Sydney'
        });
        
        this.scheduledReports.set(scheduleId, {
            task,
            config: scheduleConfig,
            createdAt: new Date().toISOString()
        });
        
        console.log(`🐕 Red Dog report scheduled: ${scheduleId} with cron: ${cronExpression}`);
    }
    
    /**
     * Stop scheduled report
     */
    stopScheduledReport(scheduleId) {
        const scheduled = this.scheduledReports.get(scheduleId);
        if (scheduled) {
            scheduled.task.stop();
            this.scheduledReports.delete(scheduleId);
            console.log(`🐕 Red Dog stopped scheduled report: ${scheduleId}`);
        }
    }
    
    /**
     * Get all scheduled reports
     */
    getScheduledReports() {
        return Array.from(this.scheduledReports.entries()).map(([id, data]) => ({
            id,
            ...data.config,
            createdAt: data.createdAt
        }));
    }
    
    /**
     * Create report template
     */
    createReportTemplate(templateConfig) {
        const { templateName, query, description, parameters = [] } = templateConfig;
        
        const template = {
            templateName,
            description,
            query,
            parameters,
            createdAt: new Date().toISOString()
        };
        
        const templatePath = path.join(this.templatesDirectory, `${templateName}.json`);
        fs.writeFileSync(templatePath, JSON.stringify(template, null, 2));
        
        console.log(`🐕 Red Dog report template created: ${templateName}`);
        return template;
    }
    
    /**
     * Load report template
     */
    loadReportTemplate(templateName) {
        const templatePath = path.join(this.templatesDirectory, `${templateName}.json`);
        
        if (!fs.existsSync(templatePath)) {
            throw new Error(`Template not found: ${templateName}`);
        }
        
        const template = JSON.parse(fs.readFileSync(templatePath, 'utf8'));
        return template;
    }
    
    /**
     * List all report templates
     */
    listReportTemplates() {
        const templates = [];
        
        if (fs.existsSync(this.templatesDirectory)) {
            const files = fs.readdirSync(this.templatesDirectory);
            
            files.forEach(file => {
                if (file.endsWith('.json')) {
                    const templatePath = path.join(this.templatesDirectory, file);
                    const template = JSON.parse(fs.readFileSync(templatePath, 'utf8'));
                    templates.push(template);
                }
            });
        }
        
        return templates;
    }
    
    /**
     * Health check
     */
    async healthCheck() {
        const health = {
            status: 'healthy',
            timestamp: new Date().toISOString(),
            service: 'Red Dog Reporting Service',
            components: {}
        };
        
        try {
            // Check SQL connection
            if (this.sqlPool && this.sqlPool.connected) {
                health.components.sql = { status: 'connected' };
            } else {
                health.components.sql = { status: 'disconnected' };
                health.status = 'degraded';
            }
        } catch (error) {
            health.components.sql = { status: 'error', error: error.message };
            health.status = 'unhealthy';
        }
        
        try {
            // Check Blob Storage
            if (this.containerClient) {
                health.components.blobStorage = { status: 'connected' };
            } else {
                health.components.blobStorage = { status: 'not configured' };
            }
        } catch (error) {
            health.components.blobStorage = { status: 'error', error: error.message };
            health.status = 'degraded';
        }
        
        try {
            // Check Email Manager
            health.components.emailManager = { status: 'available' };
        } catch (error) {
            health.components.emailManager = { status: 'error', error: error.message };
            health.status = 'unhealthy';
        }
        
        return health;
    }
}

module.exports = RedDogReportingService;