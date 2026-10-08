/**
 * Red Dog Document Commands
 * 
 * Commands for generating reports and documents from farm data
 */

class DocumentCommands {
    constructor({ documentGenerator, topicManager, db }) {
        this.documentGenerator = documentGenerator;
        this.topicManager = topicManager;
        this.db = db;
    }

    /**
     * Parse document generation command
     */
    parseCommand(message) {
        const lowerMessage = message.toLowerCase();

        // Generate report command
        if (lowerMessage.includes('generate report') || lowerMessage.includes('create report') || lowerMessage.includes('write report')) {
            return this.parseGenerateReport(message);
        }

        // Generate document command
        if (lowerMessage.includes('generate document') || lowerMessage.includes('create document') || lowerMessage.includes('write document')) {
            return this.parseGenerateDocument(message);
        }

        // Generate Word document
        if (lowerMessage.includes('word document') || lowerMessage.includes('word report')) {
            return this.parseGenerateWord(message);
        }

        // Generate PowerPoint
        if (lowerMessage.includes('powerpoint') || lowerMessage.includes('presentation') || lowerMessage.includes('ppt')) {
            return this.parseGeneratePowerPoint(message);
        }

        // Generate Excel
        if (lowerMessage.includes('excel') || lowerMessage.includes('spreadsheet')) {
            return this.parseGenerateExcel(message);
        }

        // List topics
        if (lowerMessage.includes('list topics') || lowerMessage.includes('what topics')) {
            return { action: 'list_topics' };
        }

        return null;
    }

    /**
     * Parse generate report command
     */
    parseGenerateReport(message) {
        const topics = this.extractTopics(message);
        const formats = this.extractFormats(message);
        
        return {
            action: 'generate_report',
            topics: topics.length > 0 ? topics : ['energy', 'carbon', 'water', 'soil'],
            formats: formats.length > 0 ? formats : ['word', 'excel'],
            options: {
                farmName: this.extractFarmName(message) || 'Grassgum Farm'
            }
        };
    }

    /**
     * Parse generate document command
     */
    parseGenerateDocument(message) {
        const topics = this.extractTopics(message);
        const type = this.extractDocumentType(message);
        
        return {
            action: 'generate_document',
            topics: topics.length > 0 ? topics : ['energy', 'carbon', 'water', 'soil'],
            type: type || 'word',
            options: {
                farmName: this.extractFarmName(message) || 'Grassgum Farm'
            }
        };
    }

    /**
     * Parse generate Word document command
     */
    parseGenerateWord(message) {
        const topics = this.extractTopics(message);
        
        return {
            action: 'generate_word',
            topics: topics.length > 0 ? topics : ['energy', 'carbon', 'water', 'soil'],
            options: {
                farmName: this.extractFarmName(message) || 'Grassgum Farm'
            }
        };
    }

    /**
     * Parse generate PowerPoint command
     */
    parseGeneratePowerPoint(message) {
        const topics = this.extractTopics(message);
        
        return {
            action: 'generate_powerpoint',
            topics: topics.length > 0 ? topics : ['energy', 'carbon', 'water', 'soil'],
            options: {
                farmName: this.extractFarmName(message) || 'Grassgum Farm'
            }
        };
    }

    /**
     * Parse generate Excel command
     */
    parseGenerateExcel(message) {
        const topics = this.extractTopics(message);
        
        return {
            action: 'generate_excel',
            topics: topics.length > 0 ? topics : ['energy', 'carbon', 'water', 'soil'],
            options: {
                farmName: this.extractFarmName(message) || 'Grassgum Farm'
            }
        };
    }

    /**
     * Extract topics from message
     */
    extractTopics(message) {
        const topics = [];
        const lowerMessage = message.toLowerCase();

        // Check for each topic
        const topicKeywords = {
            'energy': ['energy', 'power', 'solar', 'electricity', 'renewable'],
            'carbon': ['carbon', 'emissions', 'sequestration', 'co2', 'footprint'],
            'technology': ['technology', 'tech', 'automation', 'equipment', 'machinery'],
            'climate': ['climate', 'weather', 'temperature', 'rainfall', 'forecast'],
            'water': ['water', 'irrigation', 'moisture', 'rain'],
            'soil': ['soil', 'nutrients', 'ph', 'fertility'],
            'plants': ['plant', 'crop', 'vegetation', 'growth'],
            'livestock': ['livestock', 'animal', 'cattle', 'sheep', 'stock', 'herd'],
            'farming': ['farming', 'farm', 'agriculture']
        };

        for (const [topic, keywords] of Object.entries(topicKeywords)) {
            if (keywords.some(keyword => lowerMessage.includes(keyword))) {
                topics.push(topic);
            }
        }

        return topics;
    }

    /**
     * Extract formats from message
     */
    extractFormats(message) {
        const formats = [];
        const lowerMessage = message.toLowerCase();

        if (lowerMessage.includes('word') || lowerMessage.includes('docx')) {
            formats.push('word');
        }
        if (lowerMessage.includes('powerpoint') || lowerMessage.includes('presentation') || lowerMessage.includes('ppt')) {
            formats.push('powerpoint');
        }
        if (lowerMessage.includes('excel') || lowerMessage.includes('spreadsheet') || lowerMessage.includes('xlsx')) {
            formats.push('excel');
        }

        return formats;
    }

    /**
     * Extract document type from message
     */
    extractDocumentType(message) {
        const lowerMessage = message.toLowerCase();

        if (lowerMessage.includes('word') || lowerMessage.includes('docx')) {
            return 'word';
        }
        if (lowerMessage.includes('powerpoint') || lowerMessage.includes('presentation') || lowerMessage.includes('ppt')) {
            return 'powerpoint';
        }
        if (lowerMessage.includes('excel') || lowerMessage.includes('spreadsheet') || lowerMessage.includes('xlsx')) {
            return 'excel';
        }

        return 'word';
    }

    /**
     * Extract farm name from message
     */
    extractFarmName(message) {
        // Simple extraction - in production, use more sophisticated parsing
        const farmMatch = message.match(/farm\s+(?:name\s+)?["']?([^"'\n]+)["']?/i);
        return farmMatch ? farmMatch[1] : null;
    }

    /**
     * Execute document command
     */
    async executeCommand(command, data) {
        if (!this.documentGenerator) {
            return {
                success: false,
                message: 'Document generator not configured'
            };
        }

        try {
            let result;

            switch (command.action) {
                case 'generate_report':
                    result = await this.documentGenerator.generateReportPackage(data, command.options);
                    return {
                        success: true,
                        message: `🐕 Red Dog generated ${result.length} document(s) for topics: ${command.topics.join(', ')}`,
                        details: result
                    };

                case 'generate_document':
                case 'generate_word':
                    const wordContent = await this.documentGenerator.generateWordDocument(data, command.options);
                    const wordSaved = await this.documentGenerator.saveToOnedrive(wordContent, { type: 'word' });
                    return {
                        success: true,
                        message: `🐕 Red Dog generated Word document for topics: ${command.topics.join(', ')}`,
                        details: wordSaved
                    };

                case 'generate_powerpoint':
                    const pptContent = await this.documentGenerator.generatePowerPointPresentation(data, command.options);
                    const pptSaved = await this.documentGenerator.saveToOnedrive(pptContent, { type: 'powerpoint' });
                    return {
                        success: true,
                        message: `🐕 Red Dog generated PowerPoint presentation for topics: ${command.topics.join(', ')}`,
                        details: pptSaved
                    };

                case 'generate_excel':
                    const excelContent = await this.documentGenerator.generateExcelSpreadsheet(data, command.options);
                    const excelSaved = await this.documentGenerator.saveToOnedrive(excelContent, { type: 'excel' });
                    return {
                        success: true,
                        message: `🐕 Red Dog generated Excel spreadsheet for topics: ${command.topics.join(', ')}`,
                        details: excelSaved
                    };

                case 'list_topics':
                    const topics = this.topicManager.getMainTopics();
                    const topicList = topics.map(t => `- **${t.name}**: ${t.description}`).join('\n');
                    return {
                        success: true,
                        message: `🐕 Available Topics:\n\n${topicList}`
                    };

                default:
                    return {
                        success: false,
                        message: 'Unknown document command'
                    };
            }
        } catch (error) {
            console.error('[DocumentCommands] Error executing command:', error);
            return {
                success: false,
                message: `Error generating document: ${error.message}`
            };
        }
    }

    /**
     * Get help text
     */
    getHelp() {
        return `
**Document Generation Commands:**

- **Generate report**: "Generate a report on energy, carbon, and water"
- **Generate Word document**: "Create a Word document about soil and plants"
- **Generate PowerPoint**: "Make a presentation on climate and technology"
- **Generate Excel**: "Create an Excel spreadsheet for livestock data"
- **List topics**: "List topics" or "What topics can you analyze?"

**Available Topics:**
- Energy
- Carbon
- Technology
- Climate
- Water
- Soil
- Plants
- Livestock
- Farming

**Document Formats:**
- Word (.docx)
- PowerPoint (.pptx)
- Excel (.xlsx)

**Example:**
"Generate a report on energy, carbon, and water in Word and Excel formats"
`;
    }
}

module.exports = DocumentCommands;
