/**
 * Email Provider Abstraction Layer
 * 
 * Supports multiple email providers through a common interface:
 * - Gmail (IMAP/SMTP with App Password)
 * - Outlook (IMAP/SMTP - may require OAuth2)
 * - Custom SMTP (generic SMTP server)
 * - Microsoft Graph (OAuth2 - for Outlook when Azure AD is available)
 */

const Imap = require('imap');
const { simpleParser } = require('mailparser');
const nodemailer = require('nodemailer');
const { Client } = require('@microsoft/microsoft-graph-client');

/**
 * Base Email Provider Interface
 */
class EmailProvider {
    constructor(config) {
        this.config = config;
    }

    async initialize() {
        throw new Error('initialize() must be implemented by subclass');
    }

    async fetchRecentEmails(limit, folder) {
        throw new Error('fetchRecentEmails() must be implemented by subclass');
    }

    async sendEmail(to, subject, body) {
        throw new Error('sendEmail() must be implemented by subclass');
    }

    async disconnect() {
        // Optional cleanup
    }
}

/**
 * Gmail Provider (IMAP/SMTP)
 */
class GmailProvider extends EmailProvider {
    constructor(config) {
        super(config);
        this.imapConnection = null;
        this.smtpTransporter = null;
    }

    async initialize() {
        const { email, password } = this.config;

        this.imapConfig = {
            user: email,
            password: password,
            host: 'imap.gmail.com',
            port: 993,
            tls: true
        };

        this.smtpConfig = {
            host: 'smtp.gmail.com',
            port: 587,
            secure: false,
            auth: {
                user: email,
                pass: password
            }
        };

        await this.connectIMAP();
        this.smtpTransporter = nodemailer.createTransport(this.smtpConfig);
        
        console.log('[GmailProvider] Connected');
    }

    async connectIMAP() {
        return new Promise((resolve, reject) => {
            this.imapConnection = new Imap(this.imapConfig);
            
            this.imapConnection.once('ready', () => {
                console.log('[GmailProvider] IMAP ready');
                resolve();
            });
            
            this.imapConnection.once('error', (err) => {
                console.error('[GmailProvider] IMAP error:', err);
                reject(err);
            });
            
            this.imapConnection.connect();
        });
    }

    async fetchRecentEmails(limit = 10, folder = 'INBOX') {
        return new Promise((resolve, reject) => {
            this.imapConnection.openBox(folder, false, (err, box) => {
                if (err) return reject(err);
                
                const fetch = this.imapConnection.seq.fetch(box.messages.total - limit + 1 + ':*', {
                    bodies: '',
                    struct: true
                });
                
                const emails = [];
                
                fetch.on('message', (msg, seqno) => {
                    msg.on('body', (stream) => {
                        simpleParser(stream, (err, parsed) => {
                            if (err) return;
                            
                            emails.push({
                                id: seqno,
                                from: parsed.from.text,
                                to: parsed.to.text,
                                subject: parsed.subject,
                                date: parsed.date,
                                body: parsed.text,
                                html: parsed.html
                            });
                        });
                    });
                });
                
                fetch.on('error', reject);
                fetch.on('end', () => resolve(emails));
            });
        });
    }

    async sendEmail(to, subject, body) {
        await this.smtpTransporter.sendMail({
            from: this.smtpConfig.auth.user,
            to,
            subject,
            text: body
        });
    }

    async disconnect() {
        if (this.imapConnection) {
            this.imapConnection.end();
        }
    }
}

/**
 * Outlook Provider (IMAP/SMTP)
 * Note: Basic auth may not work - OAuth2 preferred when Azure AD is available
 */
class OutlookProvider extends EmailProvider {
    constructor(config) {
        super(config);
        this.imapConnection = null;
        this.smtpTransporter = null;
    }

    async initialize() {
        const { email, password } = this.config;

        this.imapConfig = {
            user: email,
            password: password,
            host: 'outlook.office365.com',
            port: 993,
            tls: true
        };

        this.smtpConfig = {
            host: 'smtp.office365.com',
            port: 587,
            secure: false,
            auth: {
                user: email,
                pass: password
            }
        };

        try {
            await this.connectIMAP();
            this.smtpTransporter = nodemailer.createTransport(this.smtpConfig);
            console.log('[OutlookProvider] Connected');
        } catch (err) {
            console.error('[OutlookProvider] IMAP connection failed (may require OAuth2):', err.message);
            throw err;
        }
    }

    async connectIMAP() {
        return new Promise((resolve, reject) => {
            this.imapConnection = new Imap(this.imapConfig);
            
            this.imapConnection.once('ready', () => {
                console.log('[OutlookProvider] IMAP ready');
                resolve();
            });
            
            this.imapConnection.once('error', (err) => {
                console.error('[OutlookProvider] IMAP error:', err);
                reject(err);
            });
            
            this.imapConnection.connect();
        });
    }

    async fetchRecentEmails(limit = 10, folder = 'INBOX') {
        return new Promise((resolve, reject) => {
            this.imapConnection.openBox(folder, false, (err, box) => {
                if (err) return reject(err);
                
                const fetch = this.imapConnection.seq.fetch(box.messages.total - limit + 1 + ':*', {
                    bodies: '',
                    struct: true
                });
                
                const emails = [];
                
                fetch.on('message', (msg, seqno) => {
                    msg.on('body', (stream) => {
                        simpleParser(stream, (err, parsed) => {
                            if (err) return;
                            
                            emails.push({
                                id: seqno,
                                from: parsed.from.text,
                                to: parsed.to.text,
                                subject: parsed.subject,
                                date: parsed.date,
                                body: parsed.text,
                                html: parsed.html
                            });
                        });
                    });
                });
                
                fetch.on('error', reject);
                fetch.on('end', () => resolve(emails));
            });
        });
    }

    async sendEmail(to, subject, body) {
        await this.smtpTransporter.sendMail({
            from: this.smtpConfig.auth.user,
            to,
            subject,
            text: body
        });
    }

    async disconnect() {
        if (this.imapConnection) {
            this.imapConnection.end();
        }
    }
}

/**
 * Microsoft Graph Provider (OAuth2 for Outlook)
 * Requires Azure AD app registration
 */
class MicrosoftGraphProvider extends EmailProvider {
    constructor(config) {
        super(config);
        this.graphClient = null;
        this.oauthManager = config.oauthManager;
    }

    async initialize() {
        if (!this.oauthManager) {
            throw new Error('MicrosoftGraphProvider requires oauthManager');
        }

        const accessToken = await this.oauthManager.getAccessToken();
        
        if (!accessToken) {
            throw new Error('OAuth not authenticated');
        }
        
        this.graphClient = Client.init({
            authProvider: {
                getAccessToken: async () => {
                    return await this.oauthManager.getAccessToken();
                }
            }
        });
        
        console.log('[MicrosoftGraphProvider] Connected');
    }

    async fetchRecentEmails(limit = 10, folder = 'inbox') {
        const messages = await this.graphClient
            .api(`/me/mailFolders/${folder}/messages`)
            .top(limit)
            .select('id,from,to,subject,receivedDateTime,body')
            .orderby('receivedDateTime desc')
            .get();
        
        return messages.value.map(message => ({
            id: message.id,
            from: message.from?.emailAddress?.name || message.from?.emailAddress?.address,
            to: message.toRecipients?.map(r => r.emailAddress?.address).join(', '),
            subject: message.subject,
            date: message.receivedDateTime,
            body: message.body?.content || ''
        }));
    }

    async sendEmail(to, subject, body) {
        const message = {
            subject: subject,
            body: {
                contentType: 'Text',
                content: body
            },
            toRecipients: [
                {
                    emailAddress: {
                        address: to
                    }
                }
            ]
        };
        
        await this.graphClient
            .api('/me/sendMail')
            .post({ message });
    }
}

/**
 * Custom SMTP Provider
 */
class CustomSMTPProvider extends EmailProvider {
    constructor(config) {
        super(config);
        this.smtpTransporter = null;
    }

    async initialize() {
        const { email, password, smtpHost, smtpPort, secure } = this.config;

        this.smtpConfig = {
            host: smtpHost,
            port: smtpPort || 587,
            secure: secure || false,
            auth: {
                user: email,
                pass: password
            }
        };

        this.smtpTransporter = nodemailer.createTransport(this.smtpConfig);
        console.log('[CustomSMTPProvider] Connected');
    }

    async fetchRecentEmails(limit, folder) {
        throw new Error('Custom SMTP provider does not support fetching emails (SMTP only)');
    }

    async sendEmail(to, subject, body) {
        await this.smtpTransporter.sendMail({
            from: this.smtpConfig.auth.user,
            to,
            subject,
            text: body
        });
    }
}

/**
 * Mock Email Provider for Testing
 * Simulates email operations without real email server
 */
class MockEmailProvider extends EmailProvider {
    constructor(config) {
        super(config);
        this.inbox = [];
        this.sentEmails = [];
        this.email = config.email || 'mock@example.com';
    }

    async initialize() {
        // Add some sample emails to inbox
        this.inbox = [
            {
                id: 1,
                from: 'steve@realmgroup.global',
                to: this.email,
                subject: 'REALM Proposal - Phase 2',
                date: new Date(),
                body: 'Hi John, attached is the detailed proposal for Phase 2. Please review and let me know your thoughts. Best, Steve'
            },
            {
                id: 2,
                from: 'alerts@farm-monitor.com',
                to: this.email,
                subject: 'Alert: Soil moisture low in Field 3',
                date: new Date(Date.now() - 3600000),
                body: 'Soil moisture in Field 3 has dropped below threshold (15%). Current level: 12%. Consider irrigation.'
            },
            {
                id: 3,
                from: 'partner@bioenergy.coop',
                to: this.email,
                subject: 'Partnership opportunity',
                date: new Date(Date.now() - 86400000),
                body: 'We would like to discuss a potential partnership for bioenergy projects. Are you available next week?'
            }
        ];
        
        console.log('[MockEmailProvider] Initialized with sample inbox');
    }

    async fetchRecentEmails(limit = 10, folder = 'INBOX') {
        console.log(`[MockEmailProvider] Fetching ${limit} emails from ${folder}`);
        return this.inbox.slice(0, limit);
    }

    async sendEmail(to, subject, body) {
        const sentEmail = {
            id: this.sentEmails.length + 1,
            from: this.email,
            to,
            subject,
            body,
            sentAt: new Date()
        };
        
        this.sentEmails.push(sentEmail);
        console.log(`[MockEmailProvider] Email sent:`, {
            to,
            subject,
            body: body.substring(0, 100) + '...'
        });
        
        return sentEmail;
    }

    getSentEmails() {
        return this.sentEmails;
    }

    getInbox() {
        return this.inbox;
    }

    addMockEmail(email) {
        this.inbox.unshift({
            id: this.inbox.length + 1,
            ...email,
            date: new Date()
        });
    }
}

/**
 * Email Provider Factory
 */
class EmailProviderFactory {
    static create(providerType, config) {
        switch (providerType.toLowerCase()) {
            case 'gmail':
                return new GmailProvider(config);
            case 'outlook':
                return new OutlookProvider(config);
            case 'microsoft-graph':
            case 'graph':
                return new MicrosoftGraphProvider(config);
            case 'custom-smtp':
            case 'smtp':
                return new CustomSMTPProvider(config);
            case 'mock':
                return new MockEmailProvider(config);
            default:
                throw new Error(`Unknown email provider: ${providerType}`);
        }
    }
}

module.exports = {
    EmailProvider,
    GmailProvider,
    OutlookProvider,
    MicrosoftGraphProvider,
    CustomSMTPProvider,
    MockEmailProvider,
    EmailProviderFactory
};
