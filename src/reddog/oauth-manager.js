/**
 * Red Dog OAuth 2.0 Manager for Microsoft Graph
 * 
 * Handles OAuth 2.0 authorization code flow with PKCE
 * Manages token storage, refresh, and automatic renewal
 */

const crypto = require('crypto');
const axios = require('axios');

class OAuthManager {
    constructor({ blobStorage, scopes = ['Files.ReadWrite.All', 'User.Read'] }) {
        this.blobStorage = blobStorage;
        
        // OAuth configuration
        this.clientId = process.env.MICROSOFT_CLIENT_ID;
        this.clientSecret = process.env.MICROSOFT_CLIENT_SECRET;
        this.tenantId = process.env.MICROSOFT_TENANT_ID || 'common';
        this.redirectUri = process.env.MICROSOFT_REDIRECT_URI || 'http://localhost:3001/api/onedrive/callback';
        this.scopes = scopes;
        
        // Token storage
        this.tokens = null;
        this.pkceVerifier = null;
        this.pkceChallenge = null;
        
        // Token refresh timer
        this.refreshTimer = null;
    }

    /**
     * Generate PKCE code verifier and challenge
     */
    generatePKCE() {
        // Generate random code verifier (43-128 characters)
        this.pkceVerifier = crypto.randomBytes(32).toString('base64url');
        
        // Generate code challenge (SHA256 hash of verifier)
        const hash = crypto.createHash('sha256').update(this.pkceVerifier).digest();
        this.pkceChallenge = hash.toString('base64url');
        
        return {
            verifier: this.pkceVerifier,
            challenge: this.pkceChallenge
        };
    }

    /**
     * Get authorization URL for user login
     */
    getAuthorizationUrl() {
        const pkce = this.generatePKCE();
        
        const params = new URLSearchParams({
            client_id: this.clientId,
            response_type: 'code',
            redirect_uri: this.redirectUri,
            scope: this.scopes.join(' '),
            code_challenge: pkce.challenge,
            code_challenge_method: 'S256',
            state: this.generateState()
        });
        
        return `https://login.microsoftonline.com/${this.tenantId}/oauth2/v2.0/authorize?${params.toString()}`;
    }

    /**
     * Generate random state parameter for CSRF protection
     */
    generateState() {
        return crypto.randomBytes(16).toString('hex');
    }

    /**
     * Exchange authorization code for access token
     */
    async exchangeCodeForToken(code, state) {
        try {
            const params = new URLSearchParams({
                client_id: this.clientId,
                client_secret: this.clientSecret,
                code: code,
                redirect_uri: this.redirectUri,
                grant_type: 'authorization_code',
                code_verifier: this.pkceVerifier
            });
            
            const response = await axios.post(
                `https://login.microsoftonline.com/${this.tenantId}/oauth2/v2.0/token`,
                params.toString(),
                {
                    headers: {
                        'Content-Type': 'application/x-www-form-urlencoded'
                    }
                }
            );
            
            const tokens = {
                accessToken: response.data.access_token,
                refreshToken: response.data.refresh_token,
                expiresAt: new Date(Date.now() + response.data.expires_in * 1000),
                tokenType: response.data.token_type,
                scope: response.data.scope
            };
            
            // Store tokens
            await this.storeTokens(tokens);
            this.tokens = tokens;
            
            // Schedule token refresh
            this.scheduleTokenRefresh(tokens.expiresAt);
            
            console.log('[OAuth] Tokens obtained successfully');
            return tokens;
        } catch (err) {
            console.error('[OAuth] Failed to exchange code for token:', err.response?.data || err.message);
            throw new Error(`Token exchange failed: ${err.message}`);
        }
    }

    /**
     * Refresh access token using refresh token
     */
    async refreshAccessToken() {
        if (!this.tokens || !this.tokens.refreshToken) {
            throw new Error('No refresh token available');
        }
        
        try {
            const params = new URLSearchParams({
                client_id: this.clientId,
                client_secret: this.clientSecret,
                refresh_token: this.tokens.refreshToken,
                grant_type: 'refresh_token'
            });
            
            const response = await axios.post(
                `https://login.microsoftonline.com/${this.tenantId}/oauth2/v2.0/token`,
                params.toString(),
                {
                    headers: {
                        'Content-Type': 'application/x-www-form-urlencoded'
                    }
                }
            );
            
            const tokens = {
                accessToken: response.data.access_token,
                refreshToken: response.data.refresh_token || this.tokens.refreshToken,
                expiresAt: new Date(Date.now() + response.data.expires_in * 1000),
                tokenType: response.data.token_type,
                scope: response.data.scope
            };
            
            // Store updated tokens
            await this.storeTokens(tokens);
            this.tokens = tokens;
            
            // Schedule next refresh
            this.scheduleTokenRefresh(tokens.expiresAt);
            
            console.log('[OAuth] Token refreshed successfully');
            return tokens;
        } catch (err) {
            console.error('[OAuth] Failed to refresh token:', err.response?.data || err.message);
            throw new Error(`Token refresh failed: ${err.message}`);
        }
    }

    /**
     * Get current access token (refresh if needed)
     */
    async getAccessToken() {
        // Load tokens if not in memory
        if (!this.tokens) {
            await this.loadTokens();
        }
        
        // Check if tokens exist
        if (!this.tokens) {
            return null;
        }
        
        // Check if token is expired or will expire soon (5 minutes buffer)
        const now = new Date();
        const expiresAt = new Date(this.tokens.expiresAt);
        const bufferTime = 5 * 60 * 1000; // 5 minutes
        
        if (now.getTime() + bufferTime > expiresAt.getTime()) {
            console.log('[OAuth] Token expired or expiring soon, refreshing...');
            await this.refreshAccessToken();
        }
        
        return this.tokens.accessToken;
    }

    /**
     * Schedule automatic token refresh
     */
    scheduleTokenRefresh(expiresAt) {
        if (this.refreshTimer) {
            clearTimeout(this.refreshTimer);
        }
        
        const now = new Date();
        const expiryDate = new Date(expiresAt);
        const bufferTime = 5 * 60 * 1000; // Refresh 5 minutes before expiry
        const refreshTime = expiryDate.getTime() - now.getTime() - bufferTime;
        
        if (refreshTime > 0) {
            this.refreshTimer = setTimeout(async () => {
                try {
                    await this.refreshAccessToken();
                } catch (err) {
                    console.error('[OAuth] Automatic token refresh failed:', err);
                }
            }, refreshTime);
            
            console.log(`[OAuth] Scheduled token refresh in ${Math.floor(refreshTime / 1000 / 60)} minutes`);
        }
    }

    /**
     * Store tokens in blob storage
     */
    async storeTokens(tokens) {
        if (!this.blobStorage) {
            console.warn('[OAuth] Blob storage not available, tokens not persisted');
            return;
        }
        
        try {
            const tokenData = {
                ...tokens,
                storedAt: new Date().toISOString()
            };
            
            await this.blobStorage.writeBlob('oauth-tokens', 'microsoft-graph.json', JSON.stringify(tokenData));
            console.log('[OAuth] Tokens stored in blob storage');
        } catch (err) {
            console.error('[OAuth] Failed to store tokens:', err);
        }
    }

    /**
     * Load tokens from blob storage
     */
    async loadTokens() {
        if (!this.blobStorage) {
            return null;
        }
        
        try {
            const data = await this.blobStorage.readBlob('microsoft-graph.json', 'oauth-tokens');
            if (data) {
                this.tokens = JSON.parse(data);
                this.tokens.expiresAt = new Date(this.tokens.expiresAt);
                console.log('[OAuth] Tokens loaded from blob storage');
                
                // Schedule refresh if token is still valid
                if (new Date() < this.tokens.expiresAt) {
                    this.scheduleTokenRefresh(this.tokens.expiresAt);
                }
            }
        } catch (err) {
            console.error('[OAuth] Failed to load tokens:', err);
        }
        
        return this.tokens;
    }

    /**
     * Clear stored tokens (logout)
     */
    async clearTokens() {
        this.tokens = null;
        
        if (this.refreshTimer) {
            clearTimeout(this.refreshTimer);
            this.refreshTimer = null;
        }
        
        if (this.blobStorage) {
            try {
                await this.blobStorage.deleteBlob('oauth-tokens', 'microsoft-graph.json');
                console.log('[OAuth] Tokens cleared from blob storage');
            } catch (err) {
                console.error('[OAuth] Failed to clear tokens:', err);
            }
        }
    }

    /**
     * Check if authenticated
     */
    isAuthenticated() {
        return !!this.tokens && new Date() < new Date(this.tokens.expiresAt);
    }

    /**
     * Get authentication status
     */
    getStatus() {
        if (!this.tokens) {
            return {
                authenticated: false,
                message: 'Not authenticated'
            };
        }
        
        const now = new Date();
        const expiresAt = new Date(this.tokens.expiresAt);
        const isExpired = now >= expiresAt;
        
        return {
            authenticated: !isExpired,
            expiresAt: this.tokens.expiresAt,
            expiresIn: Math.max(0, Math.floor((expiresAt - now) / 1000 / 60)), // minutes
            message: isExpired ? 'Token expired' : 'Authenticated'
        };
    }

    /**
     * Disconnect
     */
    disconnect() {
        if (this.refreshTimer) {
            clearTimeout(this.refreshTimer);
            this.refreshTimer = null;
        }
        console.log('[OAuth] Disconnected');
    }
}

module.exports = OAuthManager;
