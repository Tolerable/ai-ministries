/**
 * AI-Ministries Auth - Clean, minimal authentication
 * Uses EZTUNES Supabase for shared user pool (future passport compatibility)
 *
 * PHILOSOPHY: Ministry is OPEN. Login is OPTIONAL for most features.
 * - Image gen, chat, tools = NO login required
 * - Admin, personal prefs, history = login adds value
 * - Never gate basic functionality behind auth
 *
 * Usage:
 *   await aiAuth.init();
 *
 *   // Optional auth - enhance if logged in, work if not
 *   if (aiAuth.isAuthenticated()) {
 *       showUserFeatures();
 *   }
 *
 *   // Required auth - only for admin pages
 *   if (!aiAuth.requireAdmin()) return;
 */

// AI-MINISTRIES Supabase - THE ONLY BACKEND
// DEAD: yjyryzl, bugpycick, wrsomqzd - NEVER USE THESE
const SUPABASE_URL = 'https://todhqdgatlejylifqpni.supabase.co';
// SUPABASE_ANON_KEY from config.js

// Storage keys
const TOKEN_KEY = 'aim_auth_token';
const REFRESH_KEY = 'aim_refresh_token';
const USER_KEY = 'aim_user';

// JWT expiry check
function isJwtExpired(token) {
    try {
        const [, payload] = token.split('.');
        const { exp } = JSON.parse(atob(payload));
        return !exp || exp <= Math.floor(Date.now() / 1000);
    } catch {
        return true;
    }
}

// Supabase REST API helper
async function supabaseAuth(endpoint, body = null, token = null) {
    const headers = {
        'apikey': SUPABASE_ANON_KEY,
        'Content-Type': 'application/json'
    };
    if (token) {
        headers['Authorization'] = `Bearer ${token}`;
    }

    const response = await fetch(`${SUPABASE_URL}/auth/v1/${endpoint}`, {
        method: body ? 'POST' : 'GET',
        headers,
        body: body ? JSON.stringify(body) : null
    });

    return response.json();
}

// Supabase REST API for data
async function supabaseRest(table, method = 'GET', body = null, token = null, query = '') {
    const headers = {
        'apikey': SUPABASE_ANON_KEY,
        'Content-Type': 'application/json',
        'Prefer': 'return=representation'
    };
    if (token) {
        headers['Authorization'] = `Bearer ${token}`;
    }

    const response = await fetch(`${SUPABASE_URL}/rest/v1/${table}${query}`, {
        method,
        headers,
        body: body ? JSON.stringify(body) : null
    });

    return response.json();
}

class AIMinistriesAuth {
    constructor() {
        this.user = null;
        this.token = null;
        this.refreshToken = null;
        this._refreshInterval = null;
    }

    async init() {
        // Load from localStorage
        this.token = localStorage.getItem(TOKEN_KEY);
        this.refreshToken = localStorage.getItem(REFRESH_KEY);
        const userStr = localStorage.getItem(USER_KEY);
        try { this.user = userStr ? JSON.parse(userStr) : null; } catch (e) { console.warn("Corrupted localStorage, clearing..."); localStorage.removeItem(USER_KEY); localStorage.removeItem(TOKEN_KEY); localStorage.removeItem(REFRESH_KEY); this.user = null; this.token = null; this.refreshToken = null; return false; }

        if (!this.token) return false;

        // Check if token expired
        if (isJwtExpired(this.token)) {
            // Try to refresh
            if (this.refreshToken) {
                const refreshed = await this.refreshSession();
                if (!refreshed) {
                    this.clearAuth();
                    return false;
                }
            } else {
                this.clearAuth();
                return false;
            }
        }

        // Start background refresh
        this._startRefreshWatcher();

        return true;
    }

    async signIn(email, password) {
        const result = await supabaseAuth('token?grant_type=password', {
            email,
            password
        });

        if (result.error || result.error_code || result.code >= 400) {
            throw new Error(result.error_description || result.msg || result.error || 'Sign in failed');
        }

        this.token = result.access_token;
        this.refreshToken = result.refresh_token;
        this.user = result.user;

        // Try to get profile (display_name, etc.)
        try {
            const profile = await supabaseRest('profiles', 'GET', null, this.token,
                `?id=eq.${this.user.id}&select=display_name,is_admin`);
            if (profile && profile[0]) {
                this.user.display_name = profile[0].display_name;
                this.user.is_admin = profile[0].is_admin || false;
            }
        } catch (e) {
            console.warn('Profile fetch failed:', e);
        }

        this._saveAuth();
        this._startRefreshWatcher();

        return this.user;
    }

    async signUp(email, password, displayName) {
        const result = await supabaseAuth('signup', {
            email,
            password,
            data: { display_name: displayName }
        });

        if (result.error || result.error_code || result.code >= 400) {
            throw new Error(result.error_description || result.msg || result.error || 'Sign up failed');
        }

        // Note: User needs to verify email before they can sign in
        return result;
    }

    async signOut() {
        if (this.token) {
            try {
                await supabaseAuth('logout', {}, this.token);
            } catch (_) {}
        }
        this.clearAuth();
    }

    async refreshSession() {
        if (!this.refreshToken) return false;

        try {
            const result = await supabaseAuth('token?grant_type=refresh_token', {
                refresh_token: this.refreshToken
            });

            if (result.error || !result.access_token) {
                return false;
            }

            this.token = result.access_token;
            this.refreshToken = result.refresh_token;
            this.user = result.user;
            this._saveAuth();

            return true;
        } catch (e) {
            console.warn('Refresh failed:', e);
            return false;
        }
    }

    _saveAuth() {
        localStorage.setItem(TOKEN_KEY, this.token);
        localStorage.setItem(REFRESH_KEY, this.refreshToken);
        localStorage.setItem(USER_KEY, JSON.stringify(this.user));
    }

    clearAuth() {
        this.user = null;
        this.token = null;
        this.refreshToken = null;
        localStorage.removeItem(TOKEN_KEY);
        localStorage.removeItem(REFRESH_KEY);
        localStorage.removeItem(USER_KEY);

        if (this._refreshInterval) {
            clearInterval(this._refreshInterval);
            this._refreshInterval = null;
        }
    }

    _startRefreshWatcher() {
        if (this._refreshInterval) return;

        // Check every 60 seconds
        this._refreshInterval = setInterval(async () => {
            if (!this.token || !isJwtExpired(this.token)) return;

            const refreshed = await this.refreshSession();
            if (!refreshed) {
                this.clearAuth();
                // Trigger UI update if available
                if (typeof window.onAuthChange === 'function') {
                    window.onAuthChange(null);
                }
            }
        }, 60000);
    }

    isAuthenticated() {
        return !!this.token && !isJwtExpired(this.token);
    }

    isAdmin() {
        return this.isAuthenticated() && this.user?.is_admin === true;
    }

    getUser() {
        return this.user;
    }

    getToken() {
        if (!this.token || isJwtExpired(this.token)) {
            return null;
        }
        return this.token;
    }

    getDisplayName() {
        return this.user?.display_name || this.user?.email?.split('@')[0] || 'User';
    }

    // Require admin - redirects to login if not admin
    requireAdmin() {
        if (!this.isAuthenticated()) {
            const returnUrl = encodeURIComponent(window.location.href);
            window.location.href = '/login.html?redirect=' + returnUrl;
            return false;
        }
        if (!this.isAdmin()) {
            alert('Admin access required');
            return false;
        }
        return true;
    }

    // Optional auth check - returns true if logged in, doesn't redirect
    checkAuth() {
        return this.isAuthenticated();
    }
}

// Global instance
window.aiAuth = new AIMinistriesAuth();

// Auto-init on load
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => window.aiAuth.init());
} else {
    window.aiAuth.init();
}
