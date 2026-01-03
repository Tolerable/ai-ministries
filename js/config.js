/**
 * Database Configuration - NO KEYS IN FRONTEND
 * All database calls go through Netlify function
 */
const SUPABASE_URL = 'https://todhqdgatlejylifqpni.supabase.co';

async function dbQuery(action, params = {}) {
  const response = await fetch('/.netlify/functions/db-query', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, params })
  });
  return response.json();
}
