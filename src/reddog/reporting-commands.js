/**
 * Red Dog Reporting Commands
 * 
 * Handles reporting-related commands from user messages
 * Integrates with RedDogReportingService for report operations
 */

class ReportingCommands {
    constructor({ reportingService, aiEngine }) {
        this.reportingService = reportingService;
        this.aiEngine = aiEngine;
    }
    
    /**
     * Parse reporting commands from user message
     * Returns command info or null if not a reporting command
     */
    parseCommand(message) {
        const msg = message.toLowerCase().trim();
        
        // Generate SQL report: "generate report from sql <query description>"
        const sqlReportMatch = msg.match(/^generate\s+report\s+from\s+sql\s+(.+)$/i);
        if (sqlReportMatch) {
            return {
                action: 'generate_sql_report',
                description: sqlReportMatch[1]
            };
        }
        
        // Generate blob report: "generate report from blob <blobname>"
        const blobReportMatch = msg.match(/^generate\s+report\s+from\s+blob\s+(\S+)$/i);
        if (blobReportMatch) {
            return {
                action: 'generate_blob_report',
                blobName: blobReportMatch[1]
            };
        }
        
        // Schedule report: "schedule report <schedule description>"
        const scheduleMatch = msg.match(/^schedule\s+report\s+(.+)$/i);
        if (scheduleMatch) {
            return {
                action: 'schedule_report',
                description: scheduleMatch[1]
            };
        }
        
        // List scheduled reports: "list scheduled reports"
        if (msg.match(/^list\s+scheduled\s+reports?$/)) {
            return { action: 'list_scheduled_reports' };
        }
        
        // Stop scheduled report: "stop report <scheduleId>"
        const stopMatch = msg.match(/^stop\s+report\s+(\S+)$/i);
        if (stopMatch) {
            return {
                action: 'stop_report',
                scheduleId: stopMatch[1]
            };
        }
        
        // List report templates: "list report templates"
        if (msg.match(/^list\s+report\s+templates?$/)) {
            return { action: 'list_templates' };
        }
        
        // Create report template: "create template <template description>"
        const templateMatch = msg.match(/^create\s+template\s+(.+)$/i);
        if (templateMatch) {
            return {
                action: 'create_template',
                description: templateMatch[1]
            };
        }
        
        // Report health check: "report health"
        if (msg.match(/^report\s+health$/)) {
            return { action: 'report_health' };
        }
        
        return null;
    }
    
    /**
     * Execute reporting command
     */
    async executeCommand(command, context = {}) {
        try {
            switch (command.action) {
                case 'generate_sql_report':
                    return await this.handleGenerateSQLReport(command, context);
                case 'generate_blob_report':
                    return await this.handleGenerateBlobReport(command, context);
                case 'schedule_report':
                    return await this.handleScheduleReport(command, context);
                case 'list_scheduled_reports':
                    return await this.handleListScheduledReports();
                case 'stop_report':
                    return await this.handleStopReport(command);
                case 'list_templates':
                    return await this.handleListTemplates();
                case 'create_template':
                    return await this.handleCreateTemplate(command, context);
                case 'report_health':
                    return await this.handleReportHealth();
                default:
                    return { success: false, message: `Unknown reporting command: ${command.action}` };
            }
        } catch (error) {
            console.error(`Reporting command execution failed:`, error);
            return {
                success: false,
                action: command.action,
                error: error.message
            };
        }
    }
    
    /**
     * Handle SQL report generation
     */
    async handleGenerateSQLReport(command, context) {
        // Use AI to parse the description into SQL query and parameters
        const aiResponse = await this.aiEngine.generateResponse({
            prompt: `Generate a SQL report from this description: "${command.description}"`,
            context: {
                database: this.reportingService.dbConfig.database,
                availableTables: this.getAvailableTables()
            }
        });
        
        const reportConfig = this.parseAIReportConfig(aiResponse, 'sql');
        
        // Get recipients from context or AI
        const recipients = context.recipients || ['manager@zerosumag.com'];
        
        reportConfig.recipients = recipients;
        reportConfig.subject = `🐕 Red Dog Report: ${reportConfig.title}`;
        
        const result = await this.reportingService.generateAndSendSQLReport(reportConfig);
        
        return {
            success: true,
            message: `SQL report generated and sent to ${recipients.length} recipients`,
            reportConfig,
            result
        };
    }
    
    /**
     * Handle blob report generation
     */
    async handleGenerateBlobReport(command, context) {
        const reportConfig = {
            recipients: context.recipients || ['manager@zerosumag.com'],
            subject: `🐕 Red Dog Report: ${command.blobName}`,
            blobName: command.blobName,
            fileType: this.getFileType(command.blobName),
            title: `Report from ${command.blobName}`,
            description: `Automated report generated from blob storage file`
        };
        
        const result = await this.reportingService.generateAndSendBlobReport(reportConfig);
        
        return {
            success: true,
            message: `Blob report generated and sent to ${reportConfig.recipients.length} recipients`,
            reportConfig,
            result
        };
    }
    
    /**
     * Handle report scheduling
     */
    async handleScheduleReport(command, context) {
        // Use AI to parse schedule description
        const aiResponse = await this.aiEngine.generateResponse({
            prompt: `Parse this scheduling request into cron expression and report config: "${command.description}"`,
            context: {
                availableCronPatterns: [
                    '0 8 * * * - Daily at 8:00 AM',
                    '0 9 * * 1 - Every Monday at 9:00 AM',
                    '0 0 1 * * - First day of month at midnight',
                    '0 */6 * * * - Every 6 hours'
                ]
            }
        });
        
        const scheduleConfig = this.parseAIScheduleConfig(aiResponse);
        
        this.reportingService.scheduleReport(scheduleConfig);
        
        return {
            success: true,
            message: `Report scheduled: ${scheduleConfig.scheduleId}`,
            scheduleConfig
        };
    }
    
    /**
     * Handle listing scheduled reports
     */
    async handleListScheduledReports() {
        const reports = this.reportingService.getScheduledReports();
        
        return {
            success: true,
            message: `Found ${reports.length} scheduled reports`,
            reports
        };
    }
    
    /**
     * Handle stopping scheduled report
     */
    async handleStopReport(command) {
        this.reportingService.stopScheduledReport(command.scheduleId);
        
        return {
            success: true,
            message: `Stopped scheduled report: ${command.scheduleId}`
        };
    }
    
    /**
     * Handle listing templates
     */
    async handleListTemplates() {
        const templates = this.reportingService.listReportTemplates();
        
        return {
            success: true,
            message: `Found ${templates.length} report templates`,
            templates
        };
    }
    
    /**
     * Handle creating template
     */
    async handleCreateTemplate(command, context) {
        // Use AI to parse template description
        const aiResponse = await this.aiEngine.generateResponse({
            prompt: `Create a report template from this description: "${command.description}"`,
            context: {
                database: this.reportingService.dbConfig.database
            }
        });
        
        const templateConfig = this.parseAITemplateConfig(aiResponse);
        
        const template = this.reportingService.createReportTemplate(templateConfig);
        
        return {
            success: true,
            message: `Report template created: ${template.templateName}`,
            template
        };
    }
    
    /**
     * Handle report health check
     */
    async handleReportHealth() {
        const health = await this.reportingService.healthCheck();
        
        return {
            success: true,
            message: `Reporting service status: ${health.status}`,
            health
        };
    }
    
    /**
     * Parse AI response for report configuration
     */
    parseAIReportConfig(aiResponse, reportType) {
        // This would parse the AI response to extract SQL query, parameters, title, etc.
        // For now, return a basic config
        return {
            reportType,
            query: aiResponse.query || 'SELECT TOP 10 * FROM Data',
            params: aiResponse.params || {},
            title: aiResponse.title || 'Automated Report',
            description: aiResponse.description || 'Generated by Red Dog'
        };
    }
    
    /**
     * Parse AI response for schedule configuration
     */
    parseAIScheduleConfig(aiResponse) {
        return {
            scheduleId: aiResponse.scheduleId || `report-${Date.now()}`,
            cronExpression: aiResponse.cronExpression || '0 8 * * *',
            timezone: 'Australia/Sydney',
            enabled: true,
            reportConfig: aiResponse.reportConfig || {
                recipients: ['manager@zerosumag.com'],
                subject: 'Automated Report',
                reportType: 'sql',
                reportParams: {
                    query: 'SELECT * FROM Data',
                    title: 'Scheduled Report',
                    description: 'Auto-generated report'
                }
            }
        };
    }
    
    /**
     * Parse AI response for template configuration
     */
    parseAITemplateConfig(aiResponse) {
        return {
            templateName: aiResponse.templateName || `template-${Date.now()}`,
            description: aiResponse.description || 'Auto-generated template',
            query: aiResponse.query || 'SELECT * FROM Data',
            parameters: aiResponse.parameters || []
        };
    }
    
    /**
     * Get file type from blob name
     */
    getFileType(blobName) {
        const extension = blobName.split('.').pop().toLowerCase();
        const typeMap = {
            'xlsx': 'excel',
            'xls': 'excel',
            'csv': 'csv',
            'json': 'json'
        };
        return typeMap[extension] || 'json';
    }
    
    /**
     * Get available tables (placeholder)
     */
    getAvailableTables() {
        // This would query the database to get available tables
        return ['Sales', 'Inventory', 'Livestock', 'Sensors', 'WeatherData'];
    }
}

module.exports = ReportingCommands;