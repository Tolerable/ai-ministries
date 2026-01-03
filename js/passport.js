/**
 * AI-MINISTRIES PASSPORT - Cross-domain identity system
 *
 * One identity across all network sites.
 * Login once, authenticated everywhere.
 * Age-verified once, unlocks appropriate content network-wide.
 *
 * Usage:
 *   <script src="https://ai-ministries.com/js/passport.js"></script>
 *
 *   // Check if user has passport session
 *   await passport.init();
 *
 *   if (passport.isAuthenticated()) {
 *       console.log(`Welcome ${passport.getDisplayName()}`);
 *       console.log(`Age: ${passport.getAge()}`);
 *   }
 *
 *   // Age-gated content
 *   if (passport.checkAge(21)) {
 *       showAdultContent();
 *   }
 *
 *   // Age gate for this site
 *   if (!passport.requireAge(21, 'This content requires 21+')) {
 *       return; // Shows gate message and blocks
 *   }
 */

const PASSPORT_URL = 'https://todhqdgatlejylifqpni.supabase.co';
// PASSPORT_KEY from config.js

// Storage keys
const PASSPORT_TOKEN_KEY = 'aim_passport_token';
const PASSPORT_DATA_KEY = 'aim_passport_data';

// RPC call helper
async function passportRPC(fn, params = {}) {
    const response = await fetch(`${PASSPORT_URL}/rest/v1/rpc/${fn}`, {
        method: 'POST',
        headers: {
            'apikey': PASSPORT_KEY,
            'Authorization': `Bearer ${PASSPORT_KEY}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify(params)
    });

    if (!response.ok) {
        const error = await response.text();
        throw new Error(error);
    }

    return response.json();
}

// REST API helper
async function passportREST(table, method = 'GET', query = '', body = null) {
    const headers = {
        'apikey': PASSPORT_KEY,
        'Authorization': `Bearer ${PASSPORT_KEY}`,
        'Content-Type': 'application/json'
    };

    if (method === 'POST' || method === 'PATCH') {
        headers['Prefer'] = 'return=representation';
    }

    const response = await fetch(`${PASSPORT_URL}/rest/v1/${table}${query}`, {
        method,
        headers,
        body: body ? JSON.stringify(body) : null
    });

    return response.json();
}

class Passport {
    constructor() {
        this.token = null;
        this.data = null; // { passport_id, email, display_name, age, tier }
        this._initialized = false;
    }

    /**
     * Initialize passport - checks for existing session
     * Call this on page load
     */
    async init() {
        if (this._initialized) return this.isAuthenticated();

        // Check URL for passport token (cross-domain redirect)
        const urlParams = new URLSearchParams(window.location.search);
        const urlToken = urlParams.get('passport_token');

        if (urlToken) {
            // Validate and store
            const valid = await this._validateToken(urlToken);
            if (valid) {
                // Clean URL
                urlParams.delete('passport_token');
                const newUrl = window.location.pathname +
                    (urlParams.toString() ? '?' + urlParams.toString() : '') +
                    window.location.hash;
                window.history.replaceState({}, '', newUrl);
            }
        } else {
            // Check localStorage
            this.token = localStorage.getItem(PASSPORT_TOKEN_KEY);
            const dataStr = localStorage.getItem(PASSPORT_DATA_KEY);

            if (this.token && dataStr) {
                try {
                    this.data = JSON.parse(dataStr);
                    // Re-validate periodically (every page load validates)
                    await this._validateToken(this.token);
                } catch (e) {
                    this._clear();
                }
            }
        }

        this._initialized = true;
        return this.isAuthenticated();
    }

    /**
     * Validate a passport token via RPC
     */
    async _validateToken(token) {
        try {
            const result = await passportRPC('validate_passport_session', { p_token: token });

            if (result && result.length > 0) {
                this.token = token;
                this.data = result[0];
                this._save();
                return true;
            } else {
                this._clear();
                return false;
            }
        } catch (e) {
            console.warn('Passport validation failed:', e);
            this._clear();
            return false;
        }
    }

    /**
     * Sign in with email - creates or gets passport, creates session
     */
    async signIn(email, displayName = null) {
        try {
            // Get or create passport
            const passportId = await passportRPC('get_or_create_passport', {
                p_email: email,
                p_name: displayName
            });

            if (!passportId) {
                throw new Error('Failed to create passport');
            }

            // Create session
            const token = await passportRPC('create_passport_session', {
                p_passport_id: passportId,
                p_ua: navigator.userAgent,
                p_ip: null // Server will get this
            });

            if (!token) {
                throw new Error('Failed to create session');
            }

            // Validate to get full data
            await this._validateToken(token);

            return this.data;
        } catch (e) {
            console.error('Passport sign in failed:', e);
            throw e;
        }
    }

    /**
     * Sign out - clears local session
     */
    signOut() {
        // TODO: Invalidate session on server
        this._clear();

        // Trigger callback if set
        if (typeof window.onPassportChange === 'function') {
            window.onPassportChange(null);
        }
    }

    /**
     * Get redirect URL for cross-domain auth
     * Use this to link to another site while maintaining session
     */
    getRedirectUrl(targetUrl) {
        if (!this.token) return targetUrl;

        const url = new URL(targetUrl);
        url.searchParams.set('passport_token', this.token);
        return url.toString();
    }

    /**
     * Redirect to another site with passport token
     */
    redirectTo(targetUrl) {
        window.location.href = this.getRedirectUrl(targetUrl);
    }

    // ==================
    // STATUS CHECKS
    // ==================

    isAuthenticated() {
        return !!this.token && !!this.data;
    }

    getPassportId() {
        return this.data?.passport_id;
    }

    getEmail() {
        return this.data?.email;
    }

    getDisplayName() {
        return this.data?.display_name || this.data?.email?.split('@')[0] || 'Guest';
    }

    getAge() {
        return this.data?.age || null;
    }

    getTier() {
        return this.data?.tier || 'free';
    }

    // ==================
    // AGE GATES
    // ==================

    /**
     * Check if user meets age requirement (silent check)
     */
    checkAge(minAge) {
        const age = this.getAge();
        if (age === null) return false;
        return age >= minAge;
    }

    /**
     * Require age - shows message and returns false if not met
     */
    requireAge(minAge, message = null) {
        if (!this.isAuthenticated()) {
            this._showAgeGate('Please sign in to access this content', true);
            return false;
        }

        if (!this.checkAge(minAge)) {
            const age = this.getAge();
            const defaultMsg = age
                ? `This content requires age ${minAge}+. You'll be able to access it in ${minAge - age} year(s).`
                : `This content requires age ${minAge}+. Please update your profile with your date of birth.`;
            this._showAgeGate(message || defaultMsg, false);
            return false;
        }

        return true;
    }

    /**
     * Check site age gate via database
     */
    async checkSiteGate(siteKey) {
        if (!this.isAuthenticated()) return false;

        try {
            const result = await passportRPC('check_age_gate', {
                p_passport_id: this.getPassportId(),
                p_site_key: siteKey
            });
            return result === true;
        } catch (e) {
            console.warn('Site gate check failed:', e);
            return false;
        }
    }

    _showAgeGate(message, showLogin) {
        // Create overlay
        const overlay = document.createElement('div');
        overlay.id = 'passport-age-gate';
        overlay.innerHTML = `
            <style>
                #passport-age-gate {
                    position: fixed;
                    top: 0; left: 0; right: 0; bottom: 0;
                    background: rgba(0,0,0,0.9);
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    z-index: 99999;
                    font-family: -apple-system, BlinkMacSystemFont, sans-serif;
                }
                #passport-age-gate .gate-box {
                    background: #1a1a2e;
                    border: 2px solid #f0883e;
                    border-radius: 12px;
                    padding: 40px;
                    max-width: 400px;
                    text-align: center;
                    color: #fff;
                }
                #passport-age-gate h2 {
                    color: #f0883e;
                    margin: 0 0 20px 0;
                }
                #passport-age-gate p {
                    color: #ccc;
                    margin: 0 0 20px 0;
                    line-height: 1.5;
                }
                #passport-age-gate .btn {
                    display: inline-block;
                    padding: 12px 24px;
                    background: #238636;
                    color: #fff;
                    border: none;
                    border-radius: 6px;
                    cursor: pointer;
                    font-size: 14px;
                    text-decoration: none;
                    margin: 5px;
                }
                #passport-age-gate .btn:hover {
                    background: #2ea043;
                }
                #passport-age-gate .btn-secondary {
                    background: #21262d;
                    border: 1px solid #30363d;
                }
            </style>
            <div class="gate-box">
                <h2>Age Restricted</h2>
                <p>${message}</p>
                ${showLogin
                    ? '<a href="https://ai-ministries.com/login.html" class="btn">Sign In</a>'
                    : '<button class="btn btn-secondary" onclick="history.back()">Go Back</button>'
                }
            </div>
        `;
        document.body.appendChild(overlay);
    }

    // ==================
    // INTERNAL
    // ==================

    _save() {
        localStorage.setItem(PASSPORT_TOKEN_KEY, this.token);
        localStorage.setItem(PASSPORT_DATA_KEY, JSON.stringify(this.data));
    }

    _clear() {
        this.token = null;
        this.data = null;
        localStorage.removeItem(PASSPORT_TOKEN_KEY);
        localStorage.removeItem(PASSPORT_DATA_KEY);
    }
}

// Global instance
window.passport = new Passport();

// Auto-init
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => window.passport.init());
} else {
    window.passport.init();
}
