/**
 * Centralized Supabase Configuration
 * UPDATE THIS ONE FILE when rotating keys
 */
const CONFIG = {
    SUPABASE_URL: 'https://todhqdgatlejylifqpni.supabase.co',
    SUPABASE_KEY: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InRvZGhxZGdhdGxlanlsaWZxcG5pIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Njc0NTM5OTIsImV4cCI6MjA4MjgxMzk5Mn0.ySyJMjGVl_hl7FGc-OEu9DhaeiD_dn6yUrRzVQg327M'
};

// Global aliases for backward compatibility
const SUPABASE_URL = CONFIG.SUPABASE_URL;
const SUPABASE_ANON = CONFIG.SUPABASE_KEY;
const SUPABASE_ANON_KEY = CONFIG.SUPABASE_KEY;
const SUPABASE_KEY = CONFIG.SUPABASE_KEY;
const PASSPORT_URL = CONFIG.SUPABASE_URL;
const PASSPORT_KEY = CONFIG.SUPABASE_KEY;
