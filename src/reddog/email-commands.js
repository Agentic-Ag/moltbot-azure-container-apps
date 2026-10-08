/**
 * Red Dog Email Commands
 * 
 * Handles email-related commands from user messages
 * Integrates with EmailManager for email operations
 */

class EmailCommands {
    constructor({ emailManager }) {
        this.emailManager = emailManager;
    }

    /**
     * Parse email commands from user message
     * Returns command info or null if not an email command
     */
    parseCommand(message) {
        const msg = message.toLowerCase().trim();
        
        // Fetch emails: "check emails", "read emails", "fetch emails"
        if (msg.match(/^(check|read|fetch)\s+emails?$/)) {
            return { action: 'fetch' };
        }
        
        // Fetch with limit: "check 5 emails", "read 10 emails"
        const fetchMatch = msg.match(/^(check|read|fetch)\s+(\d+)\s+emails?$/);
        if (fetchMatch) {
            return {
                action: 'fetch',
                limit: parseInt(fetchMatch[2])
            };
        }
        
        // Send email: "send email to <address> subject <subject> body <body>"
        const sendMatch = msg.match(/^send\s+email\s+to\s+(\S+)\s+subject\s+(.+?)\s+body\s+(.+)$/i);
        if (sendMatch) {
            return {
                action: 'send',
                to: sendMatch[1],
                subject: sendMatch[2],
                body: sendMatch[3]
            };
        }
        
        // Approve email: "approve email <emailId>"
        const approveEmailMatch = msg.match(/^approve\s+email\s+([a-z0-9-]+)$/i);
        if (approveEmailMatch) {
            return {
                action: 'approve_email',
                emailId: approveEmailMatch[1]
            };
        }
        
        // Deny email: "deny email <emailId> [reason]"
        const denyEmailMatch = msg.match(/^deny\s+email\s+([a-z0-9-]+)(?:\s+(.+))?$/i);
        if (denyEmailMatch) {
            return {
                action: 'deny_email',
                emailId: denyEmailMatch[1],
                reason: denyEmailMatch[2] || 'No reason provided'
            };
        }
        
        // List pending emails: "list pending emails", "pending emails"
        if (msg.match(/^(list|show|pending)\s+(emails?|pending\s+emails?)$/)) {
            return { action: 'list_pending' };
        }
        
        // Add notification threshold: "add threshold <metric> above/below <value> to <email>"
        const addThresholdMatch = msg.match(/^add\s+threshold\s+(\w+)\s+(above|below)\s+(\d+)\s+to\s+(\S+)$/i);
        if (addThresholdMatch) {
            return {
                action: 'add_threshold',
                metric: addThresholdMatch[1],
                condition: addThresholdMatch[2],
                value: parseInt(addThresholdMatch[3]),
                recipient: addThresholdMatch[4]
            };
        }
        
        // List thresholds: "list thresholds", "show thresholds"
        if (msg.match(/^(list|show)\s+thresholds?$/)) {
            return { action: 'list_thresholds' };
        }
        
        // Send notification: "notify <email> subject <subject> body <body>"
        const notifyMatch = msg.match(/^notify\s+(\S+)\s+subject\s+(.+?)\s+body\s+(.+)$/i);
        if (notifyMatch) {
            return {
                action: 'notify',
                to: notifyMatch[1],
                subject: notifyMatch[2],
                body: notifyMatch[3]
            };
        }
        
        return null;
    }

    /**
     * Execute email command
     */
    async execute(command, userId = 'system') {
        switch (command.action) {
            case 'fetch':
                return await this.handleFetch(command.limit);
            
            case 'send':
                return await this.handleSend(command.to, command.subject, command.body, userId);
            
            case 'approve_email':
                return await this.handleApproveEmail(command.emailId, userId);
            
            case 'deny_email':
                return await this.handleDenyEmail(command.emailId, userId, command.reason);
            
            case 'list_pending':
                return await this.handleListPending();
            
            case 'add_threshold':
                return await this.handleAddThreshold(command.metric, command.condition, command.value, command.recipient);
            
            case 'list_thresholds':
                return await this.handleListThresholds();
            
            case 'notify':
                return await this.handleNotify(command.to, command.subject, command.body);
            
            default:
                return { error: 'Unknown email command' };
        }
    }

    /**
     * Handle fetch emails command
     */
    async handleFetch(limit = 10) {
        try {
            const emails = await this.emailManager.fetchRecentEmails(limit);
            
            if (emails.length === 0) {
                return {
                    success: true,
                    message: '📬 No recent emails found'
                };
            }
            
            let message = `📬 **Recent Emails (${emails.length})**\n\n`;
            
            for (const email of emails) {
                message += `**From:** ${email.from}\n`;
                message += `**Subject:** ${email.subject}\n`;
                message += `**Date:** ${email.date.toLocaleString()}\n`;
                message += `**Summary:** ${email.summary}\n\n`;
            }
            
            return {
                success: true,
                message,
                emails
            };
        } catch (err) {
            return {
                success: false,
                error: err.message,
                message: `❌ Failed to fetch emails: ${err.message}`
            };
        }
    }

    /**
     * Handle send email command
     */
    async handleSend(to, subject, body, userId) {
        try {
            const result = await this.emailManager.queueEmailForApproval(to, subject, body, userId);
            return result;
        } catch (err) {
            return {
                success: false,
                error: err.message,
                message: `❌ Failed to queue email: ${err.message}`
            };
        }
    }

    /**
     * Handle approve email command
     */
    async handleApproveEmail(emailId, userId) {
        try {
            const result = await this.emailManager.approveAndSendEmail(emailId, userId);
            return result;
        } catch (err) {
            return {
                success: false,
                error: err.message,
                message: `❌ Failed to approve email: ${err.message}`
            };
        }
    }

    /**
     * Handle deny email command
     */
    async handleDenyEmail(emailId, userId, reason) {
        try {
            const result = await this.emailManager.denyEmail(emailId, userId, reason);
            return result;
        } catch (err) {
            return {
                success: false,
                error: err.message,
                message: `❌ Failed to deny email: ${err.message}`
            };
        }
    }

    /**
     * Handle list pending emails command
     */
    async handleListPending() {
        const pending = Array.from(this.emailManager.pendingEmails.values());
        
        if (pending.length === 0) {
            return {
                success: true,
                message: '📭 No pending emails awaiting approval',
                pending: []
            };
        }
        
        let message = `📭 **Pending Emails (${pending.length})**\n\n`;
        
        for (const email of pending) {
            message += `**Email ID:** ${email.emailId}\n`;
            message += `**To:** ${email.to}\n`;
            message += `**Subject:** ${email.subject}\n`;
            message += `**Created:** ${email.createdAt.toLocaleString()}\n`;
            message += `**Body Preview:** ${email.body.substring(0, 100)}...\n\n`;
            message += `Commands:\n`;
            message += `- \`approve email ${email.emailId}\` - Send this email\n`;
            message += `- \`deny email ${email.emailId} <reason>\` - Cancel this email\n\n`;
        }
        
        return {
            success: true,
            message,
            pending
        };
    }

    /**
     * Handle add threshold command
     */
    async handleAddThreshold(metric, condition, value, recipient) {
        try {
            const result = await this.emailManager.addNotificationThreshold(metric, condition, value, recipient);
            
            return {
                success: true,
                message: `✅ Notification threshold added\n\n` +
                        `**Metric:** ${metric}\n` +
                        `**Condition:** ${condition}\n` +
                        `**Value:** ${value}\n` +
                        `**Recipient:** ${recipient}\n` +
                        `**Threshold ID:** ${result.thresholdId}`
            };
        } catch (err) {
            return {
                success: false,
                error: err.message,
                message: `❌ Failed to add threshold: ${err.message}`
            };
        }
    }

    /**
     * Handle list thresholds command
     */
    async handleListThresholds() {
        const thresholds = Array.from(this.emailManager.notificationThresholds.values());
        
        if (thresholds.length === 0) {
            return {
                success: true,
                message: 'No notification thresholds configured',
                thresholds: []
            };
        }
        
        let message = `🔔 **Notification Thresholds (${thresholds.length})**\n\n`;
        
        for (const threshold of thresholds) {
            message += `**Metric:** ${threshold.metric}\n`;
            message += `**Condition:** ${threshold.condition}\n`;
            message += `**Value:** ${threshold.value}\n`;
            message += `**Recipient:** ${threshold.recipient}\n`;
            message += `**Created:** ${threshold.createdAt.toLocaleString()}\n\n`;
        }
        
        return {
            success: true,
            message,
            thresholds
        };
    }

    /**
     * Handle notify command (send notification without approval)
     */
    async handleNotify(to, subject, body) {
        try {
            const result = await this.emailManager.sendNotification(to, subject, body);
            
            if (result.success) {
                return {
                    success: true,
                    message: `✅ Notification sent\n\n` +
                            `**To:** ${to}\n` +
                            `**Subject:** ${subject}`
                };
            }
            
            return result;
        } catch (err) {
            return {
                success: false,
                error: err.message,
                message: `❌ Failed to send notification: ${err.message}`
            };
        }
    }
}

module.exports = EmailCommands;
