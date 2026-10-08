/**
 * Red Dog Document Generator
 * 
 * Generates Word, PowerPoint, and Excel documents from farm data
 * and saves them to OneDrive Farms project folders
 */

const fs = require('fs');
const path = require('path');

class DocumentGenerator {
    constructor(blobStorage, onedriveSync, folderManager = null) {
        this.blobStorage = blobStorage;
        this.onedriveSync = onedriveSync;
        this.folderManager = folderManager;
        this.templates = new Map();
        this.loadTemplates();
    }

    /**
     * Load document templates
     */
    loadTemplates() {
        // Default templates for different document types
        this.templates.set('word-report', {
            title: 'Farm Report',
            sections: ['Executive Summary', 'Data Analysis', 'Recommendations', 'Appendix']
        });

        this.templates.set('powerpoint-presentation', {
            title: 'Farm Presentation',
            slides: ['Title', 'Overview', 'Data', 'Analysis', 'Recommendations', 'Conclusion']
        });

        this.templates.set('excel-spreadsheet', {
            title: 'Farm Data',
            sheets: ['Summary', 'Details', 'Analysis']
        });

        console.log('[DocumentGenerator] Templates loaded');
    }

    /**
     * Generate a Word document from data
     */
    async generateWordDocument(data, options = {}) {
        const {
            title = 'Farm Report',
            topics = [],
            date = new Date().toISOString().split('T')[0],
            farmName = 'Grassgum Farm'
        } = options;

        // Build document content (simplified - in production use docx library)
        const content = {
            metadata: {
                title,
                date,
                farmName,
                topics: topics.join(', '),
                generatedBy: 'Red Dog',
                generatedAt: new Date().toISOString()
            },
            sections: []
        };

        // Add sections for each topic
        for (const topic of topics) {
            const topicData = data[topic] || {};
            content.sections.push({
                heading: topic.charAt(0).toUpperCase() + topic.slice(1) + ' Analysis',
                content: this.formatTopicData(topicData, topic)
            });
        }

        // Add executive summary
        content.sections.unshift({
            heading: 'Executive Summary',
            content: this.generateExecutiveSummary(data, topics)
        });

        // Add recommendations
        content.sections.push({
            heading: 'Recommendations',
            content: this.generateRecommendations(data, topics)
        });

        return content;
    }

    /**
     * Generate a PowerPoint presentation from data
     */
    async generatePowerPointPresentation(data, options = {}) {
        const {
            title = 'Farm Presentation',
            topics = [],
            date = new Date().toISOString().split('T')[0],
            farmName = 'Grassgum Farm'
        } = options;

        const slides = [];

        // Title slide
        slides.push({
            type: 'title',
            title,
            subtitle: `${farmName} - ${date}`,
            generatedBy: 'Red Dog'
        });

        // Overview slide
        slides.push({
            type: 'overview',
            title: 'Overview',
            content: this.generateOverview(data, topics)
        });

        // Data slides for each topic
        for (const topic of topics) {
            const topicData = data[topic] || {};
            slides.push({
                type: 'data',
                title: topic.charAt(0).toUpperCase() + topic.slice(1),
                content: this.formatTopicDataForSlides(topicData, topic)
            });
        }

        // Analysis slide
        slides.push({
            type: 'analysis',
            title: 'Analysis',
            content: this.generateAnalysis(data, topics)
        });

        // Recommendations slide
        slides.push({
            type: 'recommendations',
            title: 'Recommendations',
            content: this.generateRecommendations(data, topics)
        });

        // Conclusion slide
        slides.push({
            type: 'conclusion',
            title: 'Conclusion',
            content: this.generateConclusion(data, topics)
        });

        return slides;
    }

    /**
     * Generate an Excel spreadsheet from data
     */
    async generateExcelSpreadsheet(data, options = {}) {
        const {
            title = 'Farm Data',
            topics = [],
            date = new Date().toISOString().split('T')[0],
            farmName = 'Grassgum Farm'
        } = options;

        const workbook = {
            metadata: {
                title,
                date,
                farmName,
                topics: topics.join(', '),
                generatedBy: 'Red Dog',
                generatedAt: new Date().toISOString()
            },
            sheets: {}
        };

        // Summary sheet
        workbook.sheets['Summary'] = this.generateSummarySheet(data, topics);

        // Detail sheets for each topic
        for (const topic of topics) {
            const topicData = data[topic] || {};
            workbook.sheets[topic.charAt(0).toUpperCase() + topic.slice(1)] = 
                this.generateTopicSheet(topicData, topic);
        }

        // Analysis sheet
        workbook.sheets['Analysis'] = this.generateAnalysisSheet(data, topics);

        return workbook;
    }

    /**
     * Format topic data for Word document
     */
    formatTopicData(topicData, topic) {
        if (!topicData || Object.keys(topicData).length === 0) {
            return `No data available for ${topic}.`;
        }

        let content = '';
        
        if (topicData.summary) {
            content += topicData.summary + '\n\n';
        }

        if (topicData.metrics) {
            content += '**Key Metrics:**\n';
            for (const [key, value] of Object.entries(topicData.metrics)) {
                content += `- ${key}: ${value}\n`;
            }
            content += '\n';
        }

        if (topicData.details) {
            content += '**Details:**\n';
            content += topicData.details + '\n\n';
        }

        if (topicData.data && Array.isArray(topicData.data)) {
            content += '**Data Points:**\n';
            topicData.data.forEach((item, index) => {
                content += `${index + 1}. ${JSON.stringify(item)}\n`;
            });
        }

        return content;
    }

    /**
     * Format topic data for PowerPoint slides
     */
    formatTopicDataForSlides(topicData, topic) {
        if (!topicData || Object.keys(topicData).length === 0) {
            return { points: ['No data available'] };
        }

        const points = [];

        if (topicData.summary) {
            points.push(topicData.summary);
        }

        if (topicData.metrics) {
            for (const [key, value] of Object.entries(topicData.metrics)) {
                points.push(`${key}: ${value}`);
            }
        }

        if (topicData.keyFindings) {
            topicData.keyFindings.forEach(finding => {
                points.push(finding);
            });
        }

        return { points };
    }

    /**
     * Generate executive summary
     */
    generateExecutiveSummary(data, topics) {
        let summary = `This report analyzes farm data across ${topics.length} key areas: ${topics.join(', ')}.\n\n`;
        
        summary += '**Key Findings:**\n';
        for (const topic of topics) {
            const topicData = data[topic];
            if (topicData && topicData.summary) {
                summary += `- ${topic.charAt(0).toUpperCase() + topic.slice(1)}: ${topicData.summary}\n`;
            }
        }

        return summary;
    }

    /**
     * Generate recommendations
     */
    generateRecommendations(data, topics) {
        const recommendations = [];

        for (const topic of topics) {
            const topicData = data[topic];
            if (topicData && topicData.recommendations) {
                recommendations.push(...topicData.recommendations);
            } else {
                // Generate default recommendations based on topic
                recommendations.push(this.getDefaultRecommendation(topic, topicData));
            }
        }

        return recommendations.join('\n');
    }

    /**
     * Get default recommendation for a topic
     */
    getDefaultRecommendation(topic, data) {
        const recommendations = {
            energy: 'Monitor energy consumption patterns and consider solar expansion to reduce costs.',
            carbon: 'Continue carbon sequestration practices and track emissions for credit opportunities.',
            technology: 'Evaluate automation opportunities to improve efficiency and reduce labor costs.',
            climate: 'Use weather forecasts to optimize planting and irrigation schedules.',
            water: 'Implement water conservation measures and monitor soil moisture levels.',
            soil: 'Conduct regular soil testing and adjust nutrient applications based on results.',
            plants: 'Monitor crop health indicators and implement integrated pest management.',
            livestock: 'Track animal health metrics and optimize feeding schedules.'
        };

        return recommendations[topic] || 'Continue monitoring and data collection for informed decision-making.';
    }

    /**
     * Generate overview for presentation
     */
    generateOverview(data, topics) {
        return {
            points: [
                `Farm: Grassgum Farm`,
                `Report Date: ${new Date().toLocaleDateString()}`,
                `Topics Analyzed: ${topics.length}`,
                `Data Sources: Farmyard, Silo Database`,
                `Generated by: Red Dog AI Assistant`
            ]
        };
    }

    /**
     * Generate analysis
     */
    generateAnalysis(data, topics) {
        const analysis = {
            points: []
        };

        for (const topic of topics) {
            const topicData = data[topic];
            if (topicData && topicData.analysis) {
                analysis.points.push(`${topic.charAt(0).toUpperCase() + topic.slice(1)}: ${topicData.analysis}`);
            }
        }

        return analysis;
    }

    /**
     * Generate conclusion
     */
    generateConclusion(data, topics) {
        return {
            points: [
                'Data analysis complete across all requested topics',
                'Recommendations provided for optimization opportunities',
                'Continue regular monitoring for trend analysis',
                'Contact Red Dog for additional analysis or reports'
            ]
        };
    }

    /**
     * Generate summary sheet for Excel
     */
    generateSummarySheet(data, topics) {
        const rows = [
            ['Topic', 'Status', 'Key Metric', 'Value', 'Trend']
        ];

        for (const topic of topics) {
            const topicData = data[topic];
            if (topicData) {
                const keyMetric = topicData.keyMetric || 'N/A';
                const value = topicData.value || 'N/A';
                const trend = topicData.trend || 'Stable';
                rows.push([
                    topic.charAt(0).toUpperCase() + topic.slice(1),
                    'Data Available',
                    keyMetric,
                    value,
                    trend
                ]);
            } else {
                rows.push([
                    topic.charAt(0).toUpperCase() + topic.slice(1),
                    'No Data',
                    'N/A',
                    'N/A',
                    'N/A'
                ]);
            }
        }

        return { headers: rows[0], data: rows.slice(1) };
    }

    /**
     * Generate topic sheet for Excel
     */
    generateTopicSheet(topicData, topic) {
        if (!topicData || Object.keys(topicData).length === 0) {
            return { headers: ['Status'], data: [['No Data Available']] };
        }

        const headers = ['Metric', 'Value', 'Date'];
        const data = [];

        if (topicData.metrics) {
            for (const [key, value] of Object.entries(topicData.metrics)) {
                data.push([key, value, new Date().toLocaleDateString()]);
            }
        }

        if (topicData.data && Array.isArray(topicData.data)) {
            topicData.data.forEach(item => {
                const keys = Object.keys(item);
                if (keys.length > 0) {
                    data.push([keys[0], item[keys[0]], new Date().toLocaleDateString()]);
                }
            });
        }

        return { headers, data };
    }

    /**
     * Generate analysis sheet for Excel
     */
    generateAnalysisSheet(data, topics) {
        const headers = ['Topic', 'Analysis', 'Recommendation', 'Priority'];
        const data = [];

        for (const topic of topics) {
            const topicData = data[topic];
            if (topicData) {
                data.push([
                    topic.charAt(0).toUpperCase() + topic.slice(1),
                    topicData.analysis || 'Analysis pending',
                    topicData.recommendation || this.getDefaultRecommendation(topic, topicData),
                    topicData.priority || 'Medium'
                ]);
            }
        }

        return { headers, data };
    }

    /**
     * Save document to OneDrive
     */
    async saveToOnedrive(content, options = {}) {
        const {
            type = 'word',
            filename = null,
            folder = null,
            strategy = 'byDate',
            topic = null
        } = options;

        if (!this.onedriveSync) {
            throw new Error('OneDrive sync not configured');
        }

        // Generate filename if not provided
        if (!filename) {
            const timestamp = new Date().toISOString().replace(/[:.]/g, '-').split('T')[0];
            const typeExtensions = {
                word: 'docx',
                powerpoint: 'pptx',
                excel: 'xlsx'
            };
            filename = `Farm-Report-${timestamp}.${typeExtensions[type]}`;
        }

        // Convert content to appropriate format
        const fileContent = this.convertToFormat(content, type);
        
        // Get content type
        const contentTypes = {
            word: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
            powerpoint: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
            excel: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
        };

        // Determine folder path
        let folderPath = folder;
        if (!folderPath && this.folderManager) {
            folderPath = this.folderManager.getFolderPath({ strategy, topic, date: new Date() });
        }
        if (!folderPath) {
            folderPath = 'Smart Farm/Project/UF02 Grassgum Farm/Reports';
        }

        // Save to blob storage first
        const blobName = `reports/${filename}`;
        await this.blobStorage.uploadBlob(blobName, Buffer.from(fileContent));

        // Queue for OneDrive upload via SQL → OneDrive sync
        const uploadId = await this.onedriveSync.queueReportForUpload(
            filename,
            Buffer.from(fileContent).toString('base64'),
            contentTypes[type],
            folderPath
        );

        console.log(`[DocumentGenerator] Document saved to blob: ${blobName}`);
        console.log(`[DocumentGenerator] Queued for OneDrive sync to: ${folderPath}/${filename}`);
        console.log(`[DocumentGenerator] Upload ID: ${uploadId}`);

        return {
            filename,
            blobName,
            folder: folderPath,
            type,
            uploadId,
            savedAt: new Date().toISOString(),
            status: 'queued_for_upload'
        };
    }

    /**
     * Convert content to appropriate format
     */
    convertToFormat(content, type) {
        // In production, use actual document libraries:
        // - Word: docx library
        // - PowerPoint: pptxgenjs
        // - Excel: exceljs
        
        // For now, return JSON as placeholder
        return JSON.stringify(content, null, 2);
    }

    /**
     * Generate complete report package
     */
    async generateReportPackage(data, options = {}) {
        const {
            topics = ['energy', 'carbon', 'water', 'soil'],
            formats = ['word', 'excel'],
            farmName = 'Grassgum Farm'
        } = options;

        const results = [];

        for (const format of formats) {
            let content;
            
            switch (format) {
                case 'word':
                    content = await this.generateWordDocument(data, { topics, farmName });
                    break;
                case 'powerpoint':
                    content = await this.generatePowerPointPresentation(data, { topics, farmName });
                    break;
                case 'excel':
                    content = await this.generateExcelSpreadsheet(data, { topics, farmName });
                    break;
                default:
                    console.warn(`[DocumentGenerator] Unknown format: ${format}`);
                    continue;
            }

            const saved = await this.saveToOnedrive(content, { type: format });
            results.push(saved);
        }

        return results;
    }

    /**
     * Get status
     */
    getStatus() {
        return {
            templatesLoaded: this.templates.size,
            blobStorageConnected: !!this.blobStorage,
            onedriveSyncConnected: !!this.onedriveSync
        };
    }
}

module.exports = DocumentGenerator;
