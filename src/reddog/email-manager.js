/**
 * Red Dog Email Manager
 * 
 * Handles email integration with provider-agnostic architecture
 * - Read/fetch emails with AI summarization
 * - Send emails with user approval
 * - Email notifications for farm data thresholds
 * - Email-triggered commands for farm system control
 * - Email approval workflow for data requests
 * 
 * Supported providers: Gmail, Outlook, Microsoft Graph (OAuth2), Custom SMTP
 */

const crypto = require('crypto');
const { EmailProviderFactory } = require('./email-providers');

// Inbound human advisory (agronomist / industry body emails a recommendation
// into the mesh). Lands as a pending Farmyard decision — same shape the
// reddog/decision/advisory MQTT subscriber produces. Env vars:
//   ADVISORY_SENDERS          — allow-list, comma-separated addresses or
//                               @domains (required — unset = feature off)
//   ADVISORY_TAG_REQUIRED     — 'false' to accept any subject from an
//                               allow-listed sender (default: require
//                               [ADVISORY] or [ADVISORY:{domain}] in subject)
//   ADVISORY_SOURCE           — decision provenance label (default 'industry')
//   ADVISORY_MQTT_URL         — broker carrying reddog/decision/advisory.
//                               Set when Red Dog can't reach Farmyard directly;
//                               the edge bridge + decision subscriber deliver it.
//   FARMYARD_API_URL          — direct delivery fallback (default
//                               http://localhost:8000)
//   ADVISORY_POLL_INTERVAL_MS — inbox poll cadence (default 300000; '0' = off)
//   ADVISORY_FETCH_LIMIT      — messages scanned per poll (default 20)
const ADVISORY_TOPIC = 'reddog/decision/advisory';
const ADVISORY_TAG_RE = /\[advisory(?::([a-z0-9_-]+))?\]/i;

class EmailManager {
    constructor({ aiEngine, blobStorage, serviceBus, approvalManager, billingSystem, oauthManager }) {
        this.aiEngine = aiEngine;
        this.blobStorage = blobStorage;
        this.serviceBus = serviceBus;
        this.approvalManager = approvalManager;
        this.billingSystem = billingSystem;
        this.oauthManager = oauthManager;

        this.emailProvider = null;

        // Email queue for pending sends (awaiting approval)
        this.pendingEmails = new Map();

        // Farm data thresholds for notifications
        this.notificationThresholds = new Map();

        // Inbound advisory state
        this._advisorySenders = (process.env.ADVISORY_SENDERS || '')
            .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
        this._advisoryTagRequired = (process.env.ADVISORY_TAG_REQUIRED || 'true') !== 'false';
        this._processedAdvisories = new Set();
        this._advisoryMqtt = null;
        this._advisoryPollTimer = null;

        // Email-triggered command patterns
        this.commandPatterns = [
            { pattern: /^approve\s+([a-z0-9-]+)$/i, action: 'approve', handler: 'handleEmailApprove' },
            { pattern: /^deny\s+([a-z0-9-]+)(?:\s+(.+))?$/i, action: 'deny', handler: 'handleEmailDeny' },
            { pattern: /^list\s+approvals?$/i, action: 'list', handler: 'handleEmailList' },
            { pattern: /^status\s+report$/i, action: 'status', handler: 'handleEmailStatus' },
            { pattern: /^irrigation\s+(on|off)$/i, action: 'irrigation', handler: 'handleEmailIrrigation' },
            { pattern: /^sensor\s+(\w+)\s+read$/i, action: 'sensor', handler: 'handleEmailSensor' }
        ];
    }

    /**
     * Initialize email with configured provider
     */
    async initialize() {
        const providerType = process.env.EMAIL_PROVIDER || 'outlook';
        const email = process.env.EMAIL_ADDRESS;
        const password = process.env.EMAIL_PASSWORD;
        
        if (!email || !password) {
            console.log('[EmailManager] Disabled (set EMAIL_ADDRESS + EMAIL_PASSWORD)');
            return false;
        }
        
        // Build provider config
        const config = {
            email,
            password,
            oauthManager: this.oauthManager
        };
        
        // Add custom SMTP config if provided
        if (providerType === 'custom-smtp' || providerType === 'smtp') {
            config.smtpHost = process.env.EMAIL_SMTP_HOST;
            config.smtpPort = parseInt(process.env.EMAIL_SMTP_PORT) || 587;
            config.secure = process.env.EMAIL_SMTP_SECURE === 'true';
        }
        
        try {
            this.emailProvider = EmailProviderFactory.create(providerType, config);
            await this.emailProvider.initialize();
            
            // Load notification thresholds from blob storage
            await this.loadNotificationThresholds();
            
            console.log(`[EmailManager] Initialized with ${providerType} provider`);
            return true;
        } catch (err) {
            console.error(`[EmailManager] Failed to initialize ${providerType} provider:`, err.message);
            console.log('[EmailManager] Email disabled due to initialization error');
            return false;
        }
    }

    /**
     * Fetch recent emails with AI summarization
     */
    async fetchRecentEmails(limit = 10, folder = 'INBOX', summarize = true) {
        if (!this.emailProvider) {
            throw new Error('Email provider not initialized');
        }

        const emails = await this.emailProvider.fetchRecentEmails(limit, folder);

        // Add AI summarization and command parsing
        for (const email of emails) {
            if (summarize && this.aiEngine && email.body) {
                email.summary = await this.generateEmailSummary(email);
            }
            email.commands = this.parseEmailCommands(email.body || '');
        }

        return emails;
    }

    /**
     * Generate AI summary of email
     */
    async generateEmailSummary(email) {
        const prompt = `Summarize this email in 2-3 sentences:\n\n` +
                      `From: ${email.from}\n` +
                      `Subject: ${email.subject}\n\n` +
                      `Body:\n${email.body.substring(0, 2000)}`;
        
        try {
            const response = await this.aiEngine.generateResponse(prompt);
            return response;
        } catch (err) {
            console.error('[EmailManager] Failed to generate summary:', err);
            return 'Summary unavailable';
        }
    }

    /**
     * Parse email body for commands
     */
    parseEmailCommands(body) {
        const commands = [];
        const text = body.toLowerCase();
        
        for (const pattern of this.commandPatterns) {
            const match = text.match(pattern.pattern);
            if (match) {
                commands.push({
                    action: pattern.action,
                    match: match[0],
                    params: match.slice(1)
                });
            }
        }
        
        return commands;
    }

    /**
     * Queue email for sending (requires user approval)
     */
    async queueEmailForApproval(to, subject, body, userId = 'system') {
        const emailId = crypto.randomUUID();
        
        const emailData = {
            emailId,
            to,
            subject,
            body,
            userId,
            createdAt: new Date(),
            status: 'pending_approval'
        };
        
        this.pendingEmails.set(emailId, emailData);
        
        // Store in blob storage for persistence
        await this.blobStorage.writeBlob('pending-emails', `${emailId}.json`, JSON.stringify(emailData));
        
        // Send notification to user
        await this.notifyUserForEmailApproval(emailData);
        
        return {
            success: true,
            emailId,
            message: `📧 Email queued for approval\n\n` +
                    `**To:** ${to}\n` +
                    `**Subject:** ${subject}\n` +
                    `**Email ID:** ${emailId}\n\n` +
                    `Commands:\n` +
                    `- \`approve email ${emailId}\` - Send this email\n` +
                    `- \`deny email ${emailId} <reason>\` - Cancel this email`
        };
    }

    /**
     * Notify user for email approval
     */
    async notifyUserForEmailApproval(emailData) {
        const notification = {
            type: 'email_approval',
            emailId: emailData.emailId,
            to: emailData.to,
            subject: emailData.subject,
            body: emailData.body.substring(0, 200) + '...',
            createdAt: emailData.createdAt
        };
        
        // Send via Service Bus if connected
        if (this.serviceBus && this.serviceBus.isConnected) {
            await this.serviceBus.sendMessage('user-notification', notification);
        }
        
        console.log('[EmailManager] Email approval notification sent:', emailData.emailId);
    }

    /**
     * Approve and send email using configured provider
     */
    async approveAndSendEmail(emailId, userId) {
        const emailData = this.pendingEmails.get(emailId);
        
        if (!emailData) {
            return {
                success: false,
                error: 'Email not found or already processed'
            };
        }
        
        if (!this.emailProvider) {
            return {
                success: false,
                error: 'Email provider not initialized'
            };
        }
        
        try {
            await this.emailProvider.sendEmail(emailData.to, emailData.subject, emailData.body);
            
            // Update status
            emailData.status = 'sent';
            emailData.approvedBy = userId;
            emailData.sentAt = new Date();
            
            // Remove from pending
            this.pendingEmails.delete(emailId);
            
            // Update blob storage
            await this.blobStorage.writeBlob('sent-emails', `${emailId}.json`, JSON.stringify(emailData));
            await this.blobStorage.deleteBlob('pending-emails', `${emailId}.json`);
            
            // Deduct credits
            if (this.billingSystem) {
                await this.billingSystem.deductCredits(userId, 1, 'email_send');
            }
            
            return {
                success: true,
                message: `✅ Email sent successfully\n\n` +
                        `**To:** ${emailData.to}\n` +
                        `**Subject:** ${emailData.subject}\n` +
                        `**Sent at:** ${emailData.sentAt.toLocaleString()}`
            };
        } catch (err) {
            return {
                success: false,
                error: err.message,
                message: `❌ Failed to send email: ${err.message}`
            };
        }
    }

    /**
     * Deny/cancel email
     */
    async denyEmail(emailId, userId, reason) {
        const emailData = this.pendingEmails.get(emailId);
        
        if (!emailData) {
            return {
                success: false,
                error: 'Email not found or already processed'
            };
        }
        
        emailData.status = 'denied';
        emailData.deniedBy = userId;
        emailData.deniedReason = reason;
        emailData.deniedAt = new Date();
        
        // Remove from pending
        this.pendingEmails.delete(emailId);
        
        // Update blob storage
        await this.blobStorage.writeBlob('denied-emails', `${emailId}.json`, JSON.stringify(emailData));
        await this.blobStorage.deleteBlob('pending-emails', `${emailId}.json`);
        
        return {
            success: true,
            message: `❌ Email cancelled\n\n` +
                    `**Email ID:** ${emailId}\n` +
                    `**Denied by:** ${userId}\n` +
                    `**Reason:** ${reason}`
        };
    }

    /**
     * Send notification email (no approval required for system alerts)
     */
    async sendNotification(to, subject, body, priority = 'normal') {
        try {
            await this.smtpTransporter.sendMail({
                from: this.smtpConfig.auth.user,
                to,
                subject: `[Red Dog Alert] ${subject}`,
                text: body,
                priority
            });
            
            console.log('[EmailManager] Notification sent:', subject);
            return { success: true };
        } catch (err) {
            console.error('[EmailManager] Failed to send notification:', err);
            return { success: false, error: err.message };
        }
    }

    /**
     * Check farm data thresholds and send notifications
     */
    async checkNotificationThresholds(farmData) {
        const notifications = [];
        
        for (const [thresholdId, threshold] of this.notificationThresholds) {
            const value = farmData[threshold.metric];
            
            if (value !== undefined) {
                if (threshold.condition === 'above' && value > threshold.value) {
                    notifications.push({
                        to: threshold.recipient,
                        subject: `${threshold.metric} above threshold`,
                        body: `Alert: ${threshold.metric} is ${value} (threshold: ${threshold.value})`
                    });
                } else if (threshold.condition === 'below' && value < threshold.value) {
                    notifications.push({
                        to: threshold.recipient,
                        subject: `${threshold.metric} below threshold`,
                        body: `Alert: ${threshold.metric} is ${value} (threshold: ${threshold.value})`
                    });
                }
            }
        }
        
        // Send notifications
        for (const notification of notifications) {
            await this.sendNotification(notification.to, notification.subject, notification.body, 'high');
        }
        
        return notifications;
    }

    /**
     * Add notification threshold
     */
    async addNotificationThreshold(metric, condition, value, recipient) {
        const thresholdId = crypto.randomUUID();
        
        const threshold = {
            thresholdId,
            metric,
            condition,
            value,
            recipient,
            createdAt: new Date()
        };
        
        this.notificationThresholds.set(thresholdId, threshold);
        
        // Persist to blob storage
        await this.blobStorage.writeBlob('notification-thresholds', `${thresholdId}.json`, JSON.stringify(threshold));
        
        return { success: true, thresholdId };
    }

    /**
     * Process incoming email for commands
     */
    async processIncomingEmail(email) {
        // Allow-listed advisor mail lands in the Farmyard decision queue
        // before any command parsing runs.
        if (this.isAdvisoryEmail(email)) {
            return await this.handleEmailAdvisory(email);
        }

        const body = (email.body || '').toLowerCase();
        
        for (const { pattern, action, handler } of this.commandPatterns) {
            const match = body.match(pattern);
            if (match) {
                const handlerMethod = this[handler];
                if (handlerMethod) {
                    return await handlerMethod.call(this, match, email);
                }
            }
        }
        
        return null; // No command found
    }

    // ── Inbound advisories (human recommendation → Farmyard decision) ────────

    get advisoryEnabled() {
        return this._advisorySenders.length > 0;
    }

    /** Extract the bare address from "Name <addr@x>" or a plain address. */
    _extractAddress(from) {
        const match = (from || '').match(/<([^>]+)>/);
        return (match ? match[1] : from || '').trim().toLowerCase();
    }

    /** True when the sender is on ADVISORY_SENDERS (address or @domain). */
    isAdvisorySender(from) {
        const address = this._extractAddress(from);
        if (!address) return false;
        return this._advisorySenders.some(entry =>
            entry.startsWith('@') ? address.endsWith(entry) : address === entry
        );
    }

    /**
     * An email is an advisory when the sender is allow-listed and the subject
     * carries [ADVISORY] / [ADVISORY:{domain}] (tag optional when
     * ADVISORY_TAG_REQUIRED=false).
     */
    isAdvisoryEmail(email) {
        if (!this.advisoryEnabled || !this.isAdvisorySender(email.from)) return false;
        if (!this._advisoryTagRequired) return true;
        return ADVISORY_TAG_RE.test(email.subject || '');
    }

    /**
     * Turn an advisor's email into a pending Farmyard decision.
     * Delivery: ADVISORY_MQTT_URL → reddog/decision/advisory (edge bridge
     * forwards it to Farmyard); otherwise a direct POST to the Farmyard
     * decisions endpoint — identical to the decision subscriber's path.
     */
    async handleEmailAdvisory(email) {
        const issuedAt = email.date ? new Date(email.date).toISOString() : new Date().toISOString();
        const cleanSubject = (email.subject || '').replace(ADVISORY_TAG_RE, '').trim() || '(no subject)';
        const domain = (email.subject || '').match(ADVISORY_TAG_RE)?.[1] || 'platform';
        const advisoryId = 'email-' + crypto
            .createHash('sha1')
            .update(`${email.from}|${email.subject}|${issuedAt}`)
            .digest('hex')
            .slice(0, 12);

        if (this._processedAdvisories.has(advisoryId)) {
            return { success: true, skipped: true, advisoryId };
        }

        const bodyText = (email.body || '').replace(/\s+/g, ' ').trim();
        let detail = bodyText.slice(0, 300);
        if (this.aiEngine && bodyText.length > 300) {
            try {
                detail = await this.generateEmailSummary({ ...email, body: bodyText });
            } catch { /* keep the truncated body */ }
        }

        const advisory = {
            advisory_id: advisoryId,
            domain,
            summary: `${cleanSubject}${detail ? ` — ${detail}` : ''}`.slice(0, 500),
            source: process.env.ADVISORY_SOURCE || 'industry',
            source_ref: email.from || null,
            issued_at: issuedAt,
            data_types: ['advisory', 'email_advisory'],
            action_label: 'Apply recommendation'
        };

        try {
            const via = await this._deliverAdvisory(advisory);
            this._processedAdvisories.add(advisoryId);
            console.log(`[EmailManager] Advisory ${advisoryId} from ${email.from} → Farmyard decision (${via})`);
            return { success: true, advisoryId, via };
        } catch (err) {
            console.warn(`[EmailManager] Advisory ${advisoryId} delivery failed:`, err.message);
            return { success: false, error: err.message, advisoryId };
        }
    }

    async _deliverAdvisory(advisory) {
        const mqttUrl = process.env.ADVISORY_MQTT_URL;
        if (mqttUrl) {
            if (!this._advisoryMqtt) {
                const mqtt = require('mqtt');
                this._advisoryMqtt = mqtt.connect(mqttUrl, {
                    clientId: `reddog-advisory-${Date.now()}`,
                    reconnectPeriod: 5000
                });
            }
            await new Promise((resolve, reject) => {
                const onErr = e => { this._advisoryMqtt.off('error', onErr); reject(e); };
                const publish = () => this._advisoryMqtt.publish(
                    ADVISORY_TOPIC, JSON.stringify(advisory), { qos: 1 },
                    err => { this._advisoryMqtt.off('error', onErr); err ? reject(err) : resolve(); }
                );
                this._advisoryMqtt.once('error', onErr);
                if (this._advisoryMqtt.connected) publish();
                else this._advisoryMqtt.once('connect', publish);
            });
            return 'mqtt';
        }

        const farmyard = process.env.FARMYARD_API_URL || 'http://localhost:8000';
        const axios = require('axios');
        await axios.post(`${farmyard}/api/v1/decisions`, {
            package_id: advisory.advisory_id,
            domain: advisory.domain,
            record_count: 0,
            gateways: [],
            data_types: advisory.data_types,
            timestamp: advisory.issued_at,
            summary: advisory.summary,
            action_route: advisory.action_route || null,
            action_label: advisory.action_label,
            source: advisory.source,
            source_ref: advisory.source_ref
        }, { headers: { 'Content-Type': 'application/json' }, timeout: 10000 });
        return 'http';
    }

    /**
     * Poll the inbox for allow-listed advisory mail. Off by default —
     * started from index.js when the provider supports fetching and
     * ADVISORY_POLL_INTERVAL_MS > 0. Command emails are left alone here;
     * they still run through processIncomingEmail when invoked manually.
     */
    startAdvisoryPolling() {
        if (!this.advisoryEnabled) {
            console.log('[EmailManager] Advisory intake disabled (set ADVISORY_SENDERS)');
            return;
        }
        const interval = parseInt(process.env.ADVISORY_POLL_INTERVAL_MS || '300000', 10);
        if (!interval) return;

        this._pollAdvisories().catch(() => {});
        this._advisoryPollTimer = setInterval(
            () => this._pollAdvisories().catch(e =>
                console.warn('[EmailManager] Advisory poll failed:', e.message)),
            interval
        );
        console.log(`[EmailManager] Advisory intake active — ${this._advisorySenders.length} trusted sender(s), poll ${interval}ms`);
    }

    stopAdvisoryPolling() {
        if (this._advisoryPollTimer) {
            clearInterval(this._advisoryPollTimer);
            this._advisoryPollTimer = null;
        }
    }

    async _pollAdvisories() {
        if (!this.emailProvider) return;
        const limit = parseInt(process.env.ADVISORY_FETCH_LIMIT || '20', 10);
        const emails = await this.fetchRecentEmails(limit, 'INBOX', false);
        for (const email of emails) {
            if (this.isAdvisoryEmail(email)) {
                await this.handleEmailAdvisory(email);
            }
        }
    }

    /**
     * Handle email approval command
     */
    async handleEmailApprove(match, email) {
        const approvalId = match[1];
        
        // Check if it's a data approval
        const approval = this.approvalManager?.getPendingApproval(approvalId);
        if (approval) {
            return await this.approvalManager.approve(approvalId, email.from);
        }
        
        // Check if it's an email approval
        const emailResult = await this.approveAndSendEmail(approvalId, email.from);
        return emailResult;
    }

    /**
     * Handle email deny command
     */
    async handleEmailDeny(match, email) {
        const approvalId = match[1];
        const reason = match[2] || 'Denied via email';
        
        // Check if it's a data approval
        const approval = this.approvalManager?.getPendingApproval(approvalId);
        if (approval) {
            return await this.approvalManager.deny(approvalId, email.from, reason);
        }
        
        // Check if it's an email approval
        const emailResult = await this.denyEmail(approvalId, email.from, reason);
        return emailResult;
    }

    /**
     * Handle email list command
     */
    async handleEmailList(match, email) {
        const pending = this.approvalManager?.listPendingApprovals() || [];
        
        let response = 'Pending Approvals:\n\n';
        for (const item of pending) {
            response += `- ${item.approvalId}: ${item.provider} - ${item.dataType}\n`;
        }
        
        // Send response via email
        await this.sendNotification(email.from, 'Pending Approvals List', response);
        
        return { success: true, message: 'Approval list sent via email' };
    }

    /**
     * Handle email status report command
     */
    async handleEmailStatus(match, email) {
        // Generate farm status report
        const status = await this.generateFarmStatusReport();
        
        // Send via email
        await this.sendNotification(email.from, 'Farm Status Report', status);
        
        return { success: true, message: 'Status report sent via email' };
    }

    /**
     * Handle email irrigation command
     */
    async handleEmailIrrigation(match, email) {
        const state = match[1];
        
        // Send control command via Service Bus
        if (this.serviceBus && this.serviceBus.isConnected) {
            await this.serviceBus.sendMessage('farm-control', {
                command: 'irrigation',
                state,
                requestedBy: email.from,
                timestamp: new Date()
            });
        }
        
        return { success: true, message: `Irrigation ${state} command sent` };
    }

    /**
     * Handle email sensor read command
     */
    async handleEmailSensor(match, email) {
        const sensorId = match[1];
        
        // Send sensor read command via Service Bus
        if (this.serviceBus && this.serviceBus.isConnected) {
            await this.serviceBus.sendMessage('farm-control', {
                command: 'sensor_read',
                sensorId,
                requestedBy: email.from,
                timestamp: new Date()
            });
        }
        
        return { success: true, message: `Sensor read command sent for ${sensorId}` };
    }

    /**
     * Generate farm status report
     */
    async generateFarmStatusReport() {
        // This would query the database for current farm status
        // For now, return a placeholder
        return 'Farm Status Report:\n\n' +
               '- Soil Moisture: Normal\n' +
               '- Temperature: 25°C\n' +
               '- Irrigation: Active\n' +
               '- Sensors: Online\n';
    }

    /**
     * Load notification thresholds from blob storage
     */
    async loadNotificationThresholds() {
        try {
            if (!this.blobStorage || !this.blobStorage.isConnected) {
                console.log('[EmailManager] Blob storage not connected - skipping threshold load');
                return;
            }
            const blobs = await this.blobStorage.listBlobs('notification-thresholds');
            
            for (const blob of blobs) {
                const data = await this.blobStorage.readBlob(blob.name, 'notification-thresholds');
                const threshold = JSON.parse(data);
                this.notificationThresholds.set(threshold.thresholdId, threshold);
            }
            
            console.log(`[EmailManager] Loaded ${this.notificationThresholds.size} notification thresholds`);
        } catch (err) {
            console.error('[EmailManager] Failed to load notification thresholds:', err);
        }
    }

    /**
     * Disconnect email connections
     */
    async disconnect() {
        this.stopAdvisoryPolling();

        if (this._advisoryMqtt) {
            this._advisoryMqtt.end();
            this._advisoryMqtt = null;
        }

        if (this.imapConnection) {
            this.imapConnection.end();
        }

        if (this.smtpTransporter) {
            this.smtpTransporter.close();
        }

        console.log('[EmailManager] Disconnected');
    }
}

module.exports = EmailManager;
