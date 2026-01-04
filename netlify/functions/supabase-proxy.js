// /.netlify/functions/supabase-proxy.js

const { createClient } = require('@supabase/supabase-js');
const { randomUUID } = require('crypto');

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseAnonKey = process.env.SUPABASE_ANON_KEY;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

// Role hierarchy
const ROLE_LEVELS = {
  OWNER: 4,
  ADMIN: 3,
  MODERATOR: 2,
  USER: 1,
};

// ------- CASINO WALLET CONSTANTS -------
const CREDITS_PER_USD   = 100; // $1 → 100 credits
const CREDITS_PER_TOKEN = 10;  // 100 credits → 1 token
const GEMS_PER_TOKEN    = 1;   // 1 gem → 1 token (universal gem conversion)
const XP_PER_SPIN       = 1;   // gain per spin
const SLOT_SPIN_COST    = 1;   // tokens per spin

async function getWalletRow(supabase, userId) {
  const { data, error } = await supabase
    .from('user_display_settings')
    .select('*')
    .eq('user_id', userId)
    .maybeSingle();
  if (error) throw error;
  const w = data || { user_id: userId };
  return {
    user_id: userId,
    cash_cents: Number(w.cash_cents || 0),
    credits: Number(w.credits || 0),
    tokens: Number(w.tokens || 0),
    xp: Number(w.xp || 0),
  };
}

async function saveWalletRow(supabase, row) {
  const { data, error } = await supabase
    .from('user_display_settings')
    .upsert(row, { onConflict: 'user_id' })
    .select('*')
    .single();
  if (error) throw error;
  return data;
}

async function checkPermission(supabase, requesterId, targetId, requiredLevel) {
  const { data } = await supabase
    .from('profiles')
    .select('role')
    .eq('id', requesterId)
    .single();

  const requesterRole = data?.role || 'USER';
  const requesterLevel = ROLE_LEVELS[requesterRole] || 0;
  const requiredRoleLevel = ROLE_LEVELS[requiredLevel] || 0;

  if (requesterLevel < requiredRoleLevel) {
    return { authorized: false, reason: 'Insufficient permissions' };
  }

  if (targetId) {
    const { data: targetData } = await supabase
      .from('profiles')
      .select('role')
      .eq('id', targetId)
      .single();

    const targetRole = targetData?.role || 'USER';
    const targetLevel = ROLE_LEVELS[targetRole] || 0;

    if (requesterLevel <= targetLevel) {
      return {
        authorized: false,
        reason: 'Cannot modify user of equal or higher rank',
      };
    }
  }

  return { authorized: true, role: requesterRole, level: requesterLevel };
}

exports.handler = async (event) => {
  // Handle CORS preflight requests
  if (event.httpMethod === 'OPTIONS') {
    const origin = event.headers.origin || event.headers.Origin || '';
    const allowed = new Set([
      'https://www.ai-ministries.com',
      'https://eztunes.xyz',
      'https://eztunesxyz-live.netlify.app'
    ]);
    const allowOrigin = allowed.has(origin) ? origin : '*';
    return {
      statusCode: 200,
      headers: {
        'Access-Control-Allow-Origin': allowOrigin,
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
        'Access-Control-Max-Age': '86400',
        'Vary': 'Origin'
      },
      body: ''
    };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  const respond = (obj, code = 200) => {
    const allowed = new Set([
      'https://www.ai-ministries.com',
      'https://eztunes.xyz',
      'https://eztunesxyz-live.netlify.app'
    ]);
    const origin = event.headers.origin || event.headers.Origin || '';
    const allowOrigin = allowed.has(origin) ? origin : '*';
  
    return {
      statusCode: code,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': allowOrigin,
        'Vary': 'Origin',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization'
      },
      body: JSON.stringify(obj),
    };
  };


  // --- Parse body safely
  let parsed;
  try {
    if (!event.body) throw new Error('Missing body');
    parsed = JSON.parse(event.body);
  } catch (err) {
    console.error('Bad request body:', event.body);
    return respond({ error: 'Invalid JSON', details: err.message }, 400);
  }

  const { action, payload } = parsed || {};
  const authHeader = event.headers.authorization || '';
  const token = authHeader.replace(/^Bearer\s+/i, '');

  const supabase = createClient(supabaseUrl, supabaseAnonKey, {
    auth: { persistSession: false, autoRefreshToken: true },
    global: { headers: token ? { Authorization: `Bearer ${token}` } : {} },
  });

  // Privileged client
  const adminSupabase = createClient(supabaseUrl, supabaseServiceKey, {
    auth: { persistSession: false },
  });

  try {
    // --- Resolve user (if token present)
    let user = null;
    if (token) {
      const {
        data: { user: authUser },
        error: authError,
      } = await supabase.auth.getUser(token);

      if (authError) {
        // Block protected actions
        const protectedActions = new Set([
          'getProfile',
          'getUserRole',
          'createMusicItem',
          'updateMusicItem',
          'deleteMusicItem',
          'adminCreateMusicItem',
          'followUser',
          'unfollowUser',
          'getFollowingList',
          'getFollowingFeed',
          'setNowPlaying',
          'stopNowPlaying',
          'getNowPlaying',
          'createVideoSession',
          'joinVideoSession',
          'updateVideoStatus',
          'updateVideoOffer',
          'updateVideoAnswer',
          'getVideoSession',
          'appendIceCandidates',
          'getIceCandidates',
          'listAvailableSessions',
          // 'getAds', - REMOVED: Allow public access for cross-site ad loading (claudecolab.com)
          'insertAd',
          'updateAd',
          'deleteAd',
          'getMessages',
          'createMessage',
          'updateMessage',
          'deleteMessage',
          'getDisplaySettings',
          'updateDisplaySettings',
          'searchUsers',
          'sendFriendRequest',
          'acceptFriendRequest',
          'getFriends',
          'getFriendRequests',
          'ignoreFriendRequest',
          'ignoreAllFriendRequests',
		  'updatePresence',
		  'getOnlineFriends',
		  'sendVideoCallInvite',
		  'respondToVideoCallInvite',
		  'checkPendingVideoInvites',
		  'endVideoCall',
		  // Support Tickets
		  'createTicket',
		  'listMyTickets',
		  'getTicket',
		  'getTicketReplies',
		  'adminListTickets',
		  'updateTicketStatus',
		  'addTicketReply',
		  // FoodChain actions
		  'createChain',
		  'createMeal',
		  'publishChain',
		  'getMyChains',
		  'likeChain',
		  'unlikeChain',
		  'addComment',
		  'getUserStats',
		  'uploadImage',
		  'createCustomIngredient',
		  'updateCustomIngredient',
		  'deleteCustomIngredient',
		  'submitIngredientForApproval',
		  'getMyIngredientSubmissions',
		  'getPendingIngredientSubmissions',
		  // NEXUS database operations (only writes are protected, reads are public for tags)
		  'insert',
		  'update',
		  'delete',
		  'approveIngredientSubmission',
		  'rejectIngredientSubmission',
		  // Religion system
		  'getReligionState',
		  'voteForReligion',
		  'checkAndUpdateReligionTally',
        ]);
        if (protectedActions.has(action)) {
          return respond({ error: 'Not authenticated' }, 401);
        }
      } else {
        user = authUser;
      }
    }

	async function getUserFromAuthHeader(headers) {
	  // try lowercase and uppercase because Netlify can send either
	  const authHeader =
		headers.authorization ||
		headers.Authorization ||
		'';

	  if (!authHeader.startsWith('Bearer ')) {
		return null;
	  }

	  const jwt = authHeader.slice(7); // strip "Bearer "

	  // ask Supabase who this is
	  const { data, error } = await supabase.auth.getUser(jwt);
	  if (error || !data || !data.user) {
		return null;
	  }

	  return {
		id: data.user.id,
		email: data.user.email
	  };
	}

    async function ensureUserStatsRow(supabaseClient, userId) {
      const { data, error } = await supabaseClient
        .from('haven_user_stats')
        .select('user_id')
        .eq('user_id', userId)
        .limit(1);

      if (error) {
        // if select fails, just stop trying to create
        return;
      }

      if (!data || !data.length) {
        // row doesn't exist yet → create minimal row
		await supabaseClient
		  .from('haven_user_stats')
		  .insert([{
			user_id: userId,
			slots_spins: 0,
			slots_wins: 0,
			slots_win_streak: 0,
			last_played_at: null,
			last_reels: null // latest visible spin result for UI
		  }]);
      }
    }

	// --- Slots: spin logic (returns { reels, winCredits, didWin, jackpot })
	function doSlotSpin() {
	  const symbols = ['🍒','🍋','🍇','🔔','⭐','7️⃣'];
	  const reels = [
		symbols[Math.floor(Math.random() * symbols.length)],
		symbols[Math.floor(Math.random() * symbols.length)],
		symbols[Math.floor(Math.random() * symbols.length)],
	  ];

	  let didWin = false;
	  let jackpot = false;
	  let winTokens = 0;

	  // triple match
	  if (reels[0] === reels[1] && reels[1] === reels[2]) {
		didWin = true;
		jackpot = (reels[0] === '7️⃣');
		winTokens = jackpot ? 100 : 20; // tweak payouts as you want
	  } else {
		// any two match = small win
		const twoMatch =
		  reels[0] === reels[1] ||
		  reels[0] === reels[2] ||
		  reels[1] === reels[2];
		if (twoMatch) {
		  didWin = true;
		  winTokens = 5;
		}
	  }

	  return { reels, winTokens, didWin, jackpot };
	}

	// ===== MEME / ESC HELPERS =====

	// only allow real image file URLs (basic guard)
	function isValidImageUrl(rawUrl) {
	  if (!rawUrl || typeof rawUrl !== 'string') return false;
	  const u = rawUrl.trim();
	  if (u.length > 1000) return false;
	  if (!/^https?:\/\//i.test(u)) return false;
	  // must end in actual image extension
	  if (!/\.(png|jpe?g|gif|webp|avif)$/i.test(u)) return false;
	  return true;
	}

	// award +1 ESC (Earned Social Credit) to a user
	// called ONLY when they first react (non-report) to a meme
	async function awardEscCredit(supabaseClient, userId) {
	  try {
		// get current esc
		const { data: row } = await supabaseClient
		  .from('user_display_settings')
		  .select('esc')
		  .eq('user_id', userId)
		  .maybeSingle();

		const currentEsc = row?.esc || 0;

		// upsert with +1 esc, leave other columns alone
		const { error: upErr } = await supabaseClient
		  .from('user_display_settings')
		  .upsert(
			{ user_id: userId, esc: currentEsc + 1 },
			{ onConflict: 'user_id' }
		  );

		if (upErr) {
		  console.warn('awardEscCredit upsert failed:', upErr.message);
		}
	  } catch (e) {
		console.warn('awardEscCredit crashed:', e.message || e);
	  }
	}

	async function forwardToFunction(path, bodyObj, extraHeaders = {}) {
	  // Build base from current request host so this works on preview & prod
	  const host = event.headers['x-forwarded-host'] || event.headers.host;
	  const proto = (event.headers['x-forwarded-proto'] || 'https');
	  const base = `${proto}://${host}`;
	  const target = `${base}${path}`;

	  // Ensure body is a JSON string
	  const body = typeof bodyObj === 'string' ? bodyObj : JSON.stringify(bodyObj || {});

	  const headers = {
		'Content-Type': 'application/json',
		...(event.headers.authorization ? { 'Authorization': event.headers.authorization } : {}),
		...extraHeaders
	  };

	  const res = await fetch(target, { method: 'POST', headers, body });

	  let data;
	  let text;
	  try {
		data = await res.json();
	  } catch {
		text = await res.text();
		data = { raw: text };
	  }

	  return { status: res.status, data };
	}

	if (typeof action === 'string' && action.startsWith('/.netlify/functions/')) {
	  const innerBody = (payload && payload.body) ? payload.body : {};
	  const innerHeaders = (payload && payload.headers) ? payload.headers : {};
	  let parsedBody = innerBody;
	  try { parsedBody = (typeof innerBody === 'string') ? JSON.parse(innerBody) : innerBody; } catch (_) {}
	  const fwd = await forwardToFunction(action, parsedBody, innerHeaders);
	  return respond(fwd.data, fwd.status);
	}

    // ---------- ROUTER ----------
    switch (action) {
      /* ==========================
         AUTH + PROFILE
      ========================== */

		// --- Pass-through to other Netlify functions when action is a path
	  case '/.netlify/functions/awareness': {
		  // Expecting payload like { body: {action:'canSpin', payload:{}}, headers:{...} }
		  const innerBody = (payload && payload.body) ? payload.body : {};
		  const innerHeaders = (payload && payload.headers) ? payload.headers : {};

		  // If body was sent as a string from the client, accept it
		  let parsedBody = innerBody;
		  try { parsedBody = (typeof innerBody === 'string') ? JSON.parse(innerBody) : innerBody; } catch (_) {}

		  const fwd = await forwardToFunction('/.netlify/functions/awareness', parsedBody, innerHeaders);
		  return respond(fwd.data, fwd.status);
	  }
	  
      case 'signIn': {
        const { data, error } = await supabase.auth.signInWithPassword(payload);
        if (error) return respond({ error: error.message }, 400);
        return respond({ data });
      }

      case 'signUp': {
        const { email, password, display_name, redirectTo } = payload || {};
        if (!email || !password) {
          return respond({ error: 'Missing email or password' }, 400);
        }
        const redirectUrl = redirectTo || 'https://eztunes.xyz/community/index.html';

        const { data, error } = await supabase.auth.signUp({
          email,
          password,
          options: {
            emailRedirectTo: redirectUrl,
            data: { display_name: display_name || null },
          },
        });
        if (error) return respond({ error: error.message }, 400);

        // Best-effort write to profiles
        if (data?.user && display_name) {
          await supabase
            .from('profiles')
            .update({ display_name: (display_name || '').trim() })
            .eq('id', data.user.id);
        }
        return respond({ data });
      }

      case 'changePassword': {
        if (!user) return respond({ error: 'Not authenticated' }, 401);
        const { new_password } = payload || {};
        if (!new_password) return respond({ error: 'Missing new password' }, 400);

        const { data, error } = await supabase.auth.updateUser({ password: new_password });
        if (error) return respond({ error: error.message }, 400);
        return respond({ data });
      }

      case 'deleteAccount': {
        if (!user) return respond({ error: 'Not authenticated' }, 401);

        await adminSupabase.from('profiles').delete().eq('id', user.id);
        const { error } = await adminSupabase.auth.admin.deleteUser(user.id);
        if (error) return respond({ error: error.message }, 400);

        return respond({ data: { success: true } });
      }

      case 'updateUserProfile': {
        if (!user) return respond({ error: 'Not authenticated' }, 401);
        const { display_name } = payload || {};
        if (!display_name || !display_name.trim()) {
          return respond({ error: 'Missing display_name' }, 400);
        }
        const { data, error } = await supabase
          .from('profiles')
          .update({ display_name: display_name.trim() })
          .eq('id', user.id)
          .select('id, display_name')
          .single();
        if (error) return respond({ error: error.message }, 400);
        return respond({ data });
      }

      case 'deleteUser': {
        if (!user) return respond({ error: 'Not authenticated' }, 401);

        const permission = await checkPermission(adminSupabase, user.id, null, 'ADMIN');
        if (!permission.authorized) return respond({ error: permission.reason }, 403);

        const { id, userId } = payload || {};
        const targetUserId = userId || id;
        if (!targetUserId) return respond({ error: 'Missing user id' }, 400);

        const targetPermission = await checkPermission(
          adminSupabase,
          user.id,
          targetUserId,
          'ADMIN'
        );
        if (!targetPermission.authorized) {
          return respond({ error: targetPermission.reason }, 403);
        }

        await adminSupabase.from('music_items').delete().eq('user_id', targetUserId);
        await adminSupabase.from('follows').delete().eq('follower_id', targetUserId);
        await adminSupabase.from('follows').delete().eq('following_id', targetUserId);
        await adminSupabase.from('now_playing').delete().eq('user_id', targetUserId);
        await adminSupabase.from('profiles').delete().eq('id', targetUserId);

        const { error: deleteError } = await adminSupabase.auth.admin.deleteUser(targetUserId);
        if (deleteError) return respond({ error: deleteError.message }, 400);

        return respond({ data: { success: true } });
      }

      case 'adminUpdateUserProfile': {
        if (!user) return respond({ error: 'Not authenticated' }, 401);

        const { id, email, display_name, role } = payload || {};
        if (!id) return respond({ error: 'Missing user id' }, 400);

        const permission = await checkPermission(adminSupabase, user.id, id, 'ADMIN');
        if (!permission.authorized) return respond({ error: permission.reason }, 403);

        const updates = {};
        if (email !== undefined) updates.email = email;
        if (display_name !== undefined) updates.display_name = display_name;
        if (role !== undefined) updates.role = role;

        const { data, error } = await adminSupabase
          .from('profiles')
          .update(updates)
          .eq('id', id)
          .select('*')
          .single();
        if (error) return respond({ error: error.message }, 400);
        return respond({ data });
      }

      case 'updateUserRole': {
        if (!user) return respond({ error: 'Not authenticated' }, 401);
        const { id, role } = payload || {};
        if (!id || !role) return respond({ error: 'Missing id or role' }, 400);

        const requiredLevel = role === 'ADMIN' ? 'OWNER' : 'ADMIN';
        const permission = await checkPermission(adminSupabase, user.id, id, requiredLevel);
        if (!permission.authorized) return respond({ error: permission.reason }, 403);
        if (role === 'OWNER') return respond({ error: 'Cannot promote to OWNER' }, 403);

        const { data, error } = await adminSupabase
          .from('profiles')
          .update({ role })
          .eq('id', id)
          .select('*')
          .single();
        if (error) return respond({ error: error.message }, 400);
        return respond({ data });
      }

      case 'resetPassword': {
        const { email } = payload || {};
        const { data, error } = await supabase.auth.resetPasswordForEmail(email, {
          redirectTo: 'https://eztunes.xyz/reset.html',
        });
        if (error) return respond({ error: error.message }, 400);
        return respond({ data });
      }

      case 'signOut': {
        const { error } = await supabase.auth.signOut();
        if (error) return respond({ error: error.message }, 400);
        return respond({ data: { success: true } });
      }

      case 'refreshSession': {
        try {
          const { refresh_token } = payload || {};
          if (!refresh_token) {
            return respond({ error: 'Missing refresh_token' }, 400);
          }

          // Use the refresh token to get a new session
          const { data, error } = await supabase.auth.refreshSession({ refresh_token });
          if (error) {
            console.error('refreshSession error:', error);
            return respond({ error: error.message }, 401);
          }
          if (!data || !data.session) {
            console.error('refreshSession: No session data returned');
            return respond({ error: 'No session data returned' }, 500);
          }

          console.log('✅ Session refreshed successfully');
          return respond({ data });
        } catch (e) {
          console.error('refreshSession crash:', e);
          return respond({ error: e.message || 'refreshSession failed' }, 500);
        }
      }

      case 'getProfile': {
        if (!user) return respond({ error: 'Not authenticated' }, 401);
        const { data, error } = await supabase
          .from('profiles')
          .select('display_name, email, role, is_supporter, supporter_since, supporter_tier, last_daily_gem_claim')
          .eq('id', user.id)
          .single();
        if (error) return respond({ error: error.message }, 400);
        return respond({ data });
      }

      case 'getUserRole': {
        if (!user) return respond({ error: 'Not authenticated' }, 401);
        const { data, error } = await supabase
          .from('profiles')
          .select('role')
          .eq('id', user.id)
          .single();
        if (error) return respond({ error: error.message }, 400);
        return respond({ data });
      }

      case 'getAllUsers': {
        if (!user) return respond({ error: 'Not authenticated' }, 401);
        const permission = await checkPermission(adminSupabase, user.id, null, 'MODERATOR');
        if (!permission.authorized) return respond({ error: permission.reason }, 403);

        const { data, error } = await adminSupabase
          .from('profiles')
          .select('id, email, display_name, role')
          .order('display_name', { ascending: true });
        if (error) return respond({ error: error.message }, 400);
        return respond({ data: data || [] });
      }

	  case 'removeFriend': {
        if (!user) return respond({ error: 'Not authenticated' }, 401);
        const { friend_id } = payload || {};
        if (!friend_id) return respond({ error: 'Missing friend_id' }, 400);

        // Delete both directions
        await supabase
          .from('awareness_friendships')
          .delete()
          .eq('user1_id', user.id)
          .eq('user2_id', friend_id);

        await supabase
          .from('awareness_friendships')
          .delete()
          .eq('user1_id', friend_id)
          .eq('user2_id', user.id);

        return respond({ data: { success: true } });
      }

      /* ==========================
         MESSAGES + DISPLAY
      ========================== */
	  case 'getMessages': {
	    if (!user) return respond({ error: 'Not authenticated' }, 401);
	    const { direction, target_id } = payload || {};
	  
	    let query = supabase.from('user_messages').select('*');
	  
	    if (direction === 'from_friend') {
	  	// friend → me
	  	if (!target_id) return respond({ error: 'Missing target_id' }, 400);
	  	query = query
	  	  .eq('user_id', target_id)
	  	  .eq('recipient_id', user.id);
	    } else if (direction === 'to_friend') {
	  	// me → friend
	  	if (!target_id) return respond({ error: 'Missing target_id' }, 400);
	  	query = query
	  	  .eq('user_id', user.id)
	  	  .eq('recipient_id', target_id);
	    } else {
	  	// default = my own board (self-only)
	  	query = query
	  	  .eq('user_id', user.id)
	  	  .is('recipient_id', null);
	    }
	  
	    query = query.order('created_at', { ascending: false });
	  
	    const { data, error } = await query;
	    if (error) return respond({ error: error.message }, 400);
	    return respond({ data: data || [] });
	  }

	  case 'markMessageRead': {
        if (!user) return respond({ error: 'Not authenticated' }, 401);
        const { id } = payload || {};
        if (!id) return respond({ error: 'Missing message id' }, 400);

        const { data, error } = await supabase
          .from('user_messages')
          .update({ 
            is_read: true, 
            read_at: new Date().toISOString() 
          })
          .eq('id', id)
          .eq('recipient_id', user.id)
          .select()
          .single();
        if (error) return respond({ error: error.message }, 400);
        return respond({ data });
      }

      case 'markAllMessagesRead': {
        if (!user) return respond({ error: 'Not authenticated' }, 401);
        const { sender_id } = payload || {};
        if (!sender_id) return respond({ error: 'Missing sender_id' }, 400);

        const { error } = await supabase
          .from('user_messages')
          .update({ 
            is_read: true, 
            read_at: new Date().toISOString() 
          })
          .eq('user_id', sender_id)
          .eq('recipient_id', user.id)
          .eq('is_read', false);
        if (error) return respond({ error: error.message }, 400);
        return respond({ data: { success: true } });
      }

      case 'deleteReceivedMessage': {
        if (!user) return respond({ error: 'Not authenticated' }, 401);
        const { id } = payload || {};
        if (!id) return respond({ error: 'Missing message id' }, 400);

        const { error } = await supabase
          .from('user_messages')
          .delete()
          .eq('id', id)
          .eq('recipient_id', user.id);
        if (error) return respond({ error: error.message }, 400);
        return respond({ data: { success: true } });
      }

      case 'getUnreadCount': {
        if (!user) return respond({ error: 'Not authenticated' }, 401);
        
        const { count, error } = await supabase
          .from('user_messages')
          .select('*', { count: 'exact', head: true })
          .eq('recipient_id', user.id)
          .eq('is_read', false);
        if (error) return respond({ error: error.message }, 400);
        return respond({ data: { count: count || 0 } });
      }

	  case 'upsertMessageToFriend': {
	    if (!user) return respond({ error: 'Not authenticated' }, 401);
	    const { id, recipient_id, message_text, text_align = 'center' } = payload || {};
	    if (!recipient_id) return respond({ error: 'Missing recipient_id' }, 400);
	    if (!message_text || !message_text.trim()) return respond({ error: 'Missing message_text' }, 400);
	  
	    if (id) {
	  	const { data, error } = await supabase
	  	  .from('user_messages')
	  	  .update({
	  		message_text: message_text.trim(),
	  		text_align
	  	  })
	  	  .eq('id', id)
	  	  .eq('user_id', user.id)
	  	  .eq('recipient_id', recipient_id)
	  	  .select('*')
	  	  .single();
	  
	  	if (error) throw error;
	  	return respond({ data });
	    } else {
	  	// create new entry
	  	const { data, error } = await supabase
	  	  .from('user_messages')
	  	  .insert([{
	  		user_id: user.id,
	  		recipient_id,
	  		message_text: message_text.trim(),
	  		text_align,
	  		is_active: true,
	  		display_order: 0
	  	  }])
	  	  .select('*')
	  	  .single();
	  	if (error) throw error;
	  	return respond({ data });
	    }
	  }

	  case 'getSentFriendRequests': {
	    if (!user) return respond({ error: 'Not authenticated' }, 401);
	    const { data, error } = await supabase
	  	.from('awareness_invitations')
	  	.select('id, recipient_email, accepted, created_at')
	  	.eq('sender_id', user.id)
	  	.eq('accepted', false)
	  	.order('created_at', { ascending: false });
	    if (error) throw error;
	    return respond({ data: data || [] });
	  }

	  case 'getIncomingFriendRequests': {
	    if (!user) return respond({ error: 'Not authenticated' }, 401);

	    // Get current user's email
	    const { data: profile, error: profileErr } = await supabase
	      .from('profiles')
	      .select('email')
	      .eq('id', user.id)
	      .single();

	    if (profileErr || !profile?.email) {
	      return respond({ error: 'Could not get user email' }, 400);
	    }

	    const userEmail = profile.email.toLowerCase();
	    console.log('[getIncomingFriendRequests] Looking for invites to:', userEmail);

	    // Get invites sent TO this user's email that haven't been accepted yet (case-insensitive)
	    const { data: invites, error } = await supabase
	      .from('awareness_invitations')
	      .select('id, sender_id, recipient_email, message, accepted, created_at')
	      .ilike('recipient_email', userEmail)
	      .eq('accepted', false)
	      .order('created_at', { ascending: false });

	    if (error) return respond({ error: error.message }, 400);

	    // Manual join: fetch sender profiles
	    const senderIds = [...new Set((invites || []).map((i) => i.sender_id))];
	    let senderMap = {};
	    if (senderIds.length) {
	      const { data: profs } = await supabase
	        .from('profiles')
	        .select('id, display_name, email')
	        .in('id', senderIds);
	      senderMap = Object.fromEntries((profs || []).map((p) => [p.id, p]));
	    }

	    const data = (invites || []).map((i) => ({
	      ...i,
	      sender: senderMap[i.sender_id] || null,
	    }));

	    console.log('[getIncomingFriendRequests] Found', data.length, 'invites');
	    return respond({ data });
	  }

	  // Aliases for awareness/index.html compatibility
	  case 'getPendingInvites': {
	    // This shows invites the user has SENT (not received) that are still pending
	    if (!user) return respond({ error: 'Not authenticated' }, 401);
	    const { data, error } = await supabase
	      .from('awareness_invitations')
	      .select('id, recipient_email, accepted, created_at')
	      .eq('sender_id', user.id)
	      .eq('accepted', false)
	      .order('created_at', { ascending: false });
	    if (error) return respond({ error: error.message }, 400);
	    return respond({ data: data || [] });
	  }

	  case 'sendGift': {
	    // Alias for sendFriendRequest but with email instead of recipient_id
	    if (!user) return respond({ error: 'Not authenticated' }, 401);
	    const { recipientEmail, message } = payload || {};
	    if (!recipientEmail) return respond({ error: 'Missing recipientEmail' }, 400);

	    // Check if recipient exists
	    const { data: recip, error: recipErr } = await supabase
	      .from('profiles')
	      .select('id, email')
	      .eq('email', recipientEmail.toLowerCase())
	      .single();

	    // If recipient doesn't exist, still create the invite (they can accept when they sign up)
	    const recipEmail = recip?.email || recipientEmail.toLowerCase();

	    // Avoid duplicates
	    const { data: existing } = await supabase
	      .from('awareness_invitations')
	      .select('id')
	      .eq('recipient_email', recipEmail)
	      .eq('sender_id', user.id)
	      .eq('accepted', false)
	      .limit(1);

	    if (existing && existing.length) {
	      return respond({ success: true, message: 'Already invited' });
	    }

	    const { data, error } = await supabase
	      .from('awareness_invitations')
	      .insert({
	        sender_id: user.id,
	        recipient_email: recipEmail,
	        message: message || 'Friend invitation',
	        invite_code: randomUUID(),
	        accepted: false,
	      })
	      .select()
	      .single();

	    if (error) return respond({ error: error.message }, 400);
	    return respond({ success: true, data });
	  }

	  case 'acceptInvite': {
	    // Alias for acceptFriendRequest but with inviteCode instead of invite_id
	    if (!user) return respond({ error: 'Not authenticated' }, 401);
	    const { inviteCode } = payload || {};
	    if (!inviteCode) return respond({ error: 'Missing inviteCode' }, 400);

	    const { data: invite, error: invErr } = await supabase
	      .from('awareness_invitations')
	      .select('*')
	      .eq('invite_code', inviteCode)
	      .single();

	    if (invErr || !invite) return respond({ error: 'Invite not found' }, 404);
	    if (invite.accepted) return respond({ error: 'Invite already accepted' }, 400);

	    // Create mutual friendship
	    await supabase.from('awareness_friendships').insert([
	      { user1_id: invite.sender_id, user2_id: user.id },
	      { user1_id: user.id, user2_id: invite.sender_id },
	    ]);

	    await supabase
	      .from('awareness_invitations')
	      .update({
	        accepted: true,
	        accepted_by: user.id,
	        accepted_at: new Date().toISOString(),
	      })
	      .eq('invite_code', inviteCode);

	    return respond({ success: true });
	  }

	  case 'resendFriendInvite': {
	    if (!user) return respond({ error: 'Not authenticated' }, 401);
	    const { invite_id } = payload || {};
	    if (!invite_id) return respond({ error: 'Missing invite_id' }, 400);

	    // Verify this is the sender's invite
	    const { data: invite, error: invErr } = await supabase
	      .from('awareness_invitations')
	      .select('*')
	      .eq('id', invite_id)
	      .eq('sender_id', user.id)
	      .single();

	    if (invErr || !invite) return respond({ error: 'Invite not found' }, 404);

	    // Update the created_at timestamp to "resend"
	    const { data, error } = await supabase
	      .from('awareness_invitations')
	      .update({
	        created_at: new Date().toISOString()
	      })
	      .eq('id', invite_id)
	      .select()
	      .single();

	    if (error) return respond({ error: error.message }, 400);
	    console.log('[resendFriendInvite] Resent invite to:', invite.recipient_email);
	    return respond({ success: true, data });
	  }

	  case 'createMessage': {
	    if (!user) return respond({ error: 'Not authenticated' }, 401);
	    const { message_text, text_align, display_order, is_active, recipient_id } = payload || {};
	    if (!message_text) return respond({ error: 'Missing message text' }, 400);
	  
	    const insertData = {
	  	user_id: user.id,
	  	recipient_id: recipient_id || null, // null = own board, UUID = friend's board
	  	message_text,
	  	text_align: text_align || 'center',
	  	display_order: display_order || 0,
	  	is_active: is_active ?? true,
	    };
	  
	    const { data, error } = await supabase
	  	.from('user_messages')
	  	.insert([insertData])
	  	.select()
	  	.single();
	  
	    if (error) throw error;
	    return respond({ data });
	  }


      case 'updateMessage': {
        if (!user) return respond({ error: 'Not authenticated' }, 401);
        const { id, ...updates } = payload || {};
        if (!id) return respond({ error: 'Missing message id' }, 400);

        const { data, error } = await supabase
          .from('user_messages')
          .update(updates)
          .eq('id', id)
          .eq('user_id', user.id)
          .select()
          .single();
        if (error) return respond({ error: error.message }, 400);
        return respond({ data });
      }

      case 'deleteMessage': {
        if (!user) return respond({ error: 'Not authenticated' }, 401);
        const { id } = payload || {};
        if (!id) return respond({ error: 'Missing message id' }, 400);

        const { error } = await supabase
          .from('user_messages')
          .delete()
          .eq('id', id)
          .eq('user_id', user.id);
        if (error) return respond({ error: error.message }, 400);
        return respond({ data: { success: true } });
      }

      case 'getDisplaySettings': {
        if (!user) return respond({ error: 'Not authenticated' }, 401);
        const { data, error } = await supabase
          .from('user_display_settings')
          .select('*')
          .eq('user_id', user.id)
          .maybeSingle();
        if (error) return respond({ error: error.message }, 400);
        return respond({ data: data || {} });
      }

      case 'updateDisplaySettings': {
        if (!user) return respond({ error: 'Not authenticated' }, 401);
        const { data, error } = await supabase
          .from('user_display_settings')
          .upsert({ user_id: user.id, ...payload }, { onConflict: 'user_id' })
          .select()
          .single();
        if (error) return respond({ error: error.message }, 400);
        return respond({ data });
      }

      /* ==========================
         FRIENDS / INVITES
      ========================== */
	  case 'searchUsers': {
        if (!user) return respond({ error: 'Not authenticated' }, 401);
        const { term } = payload || {};
        if (!term || !term.trim()) return respond({ data: [] });

        const searchTerm = term.trim().toLowerCase();
        
        // Exact email match only - must be valid email format
        if (!searchTerm.includes('@') || !searchTerm.includes('.')) {
          return respond({ data: [] });
        }

        const { data, error } = await supabase
          .from('profiles')
          .select('id, display_name, email')
          .eq('email', searchTerm)
          .limit(1);

        if (error) return respond({ error: error.message }, 400);
        
        // Exclude self from results
        const filtered = (data || []).filter(u => u.id !== user.id);
        
        return respond({ data: filtered });
      }

      case 'sendFriendRequest': {
        if (!user) return respond({ error: 'Not authenticated' }, 401);
        const { recipient_id } = payload || {};
        if (!recipient_id) return respond({ error: 'Missing recipient_id' }, 400);

        // Look up recipient email by id
        const { data: recip, error: recipErr } = await supabase
          .from('profiles')
          .select('id, email')
          .eq('id', recipient_id)
          .single();
        if (recipErr || !recip?.email) {
          return respond({ error: 'Recipient not found' }, 404);
        }

        // Avoid duplicates
        const { data: existing } = await supabase
          .from('awareness_invitations')
          .select('id')
          .eq('recipient_email', recip.email)
          .eq('sender_id', user.id)
          .eq('accepted', false)
          .limit(1);

        if (existing && existing.length) {
          return respond({ data: { message: 'Already invited' } });
        }

        const { data, error } = await supabase
          .from('awareness_invitations')
          .insert({
            sender_id: user.id,
            recipient_email: recip.email,
            message: 'Friend request',
            invite_code: randomUUID(),
            accepted: false,
          })
          .select()
          .single();

        if (error) return respond({ error: error.message }, 400);
        return respond({ data });
      }

      case 'acceptFriendRequest': {
        if (!user) return respond({ error: 'Not authenticated' }, 401);
        const { invite_id } = payload || {};
        if (!invite_id) return respond({ error: 'Missing invite_id' }, 400);

        console.log('[acceptFriendRequest] User:', user.id, 'accepting invite:', invite_id);

        const { data: invite, error: invErr } = await supabase
          .from('awareness_invitations')
          .select('*')
          .eq('id', invite_id)
          .single();
        if (invErr || !invite) {
          console.log('[acceptFriendRequest] Invite not found or error:', invErr);
          return respond({ error: 'Invite not found' }, 404);
        }

        // Check if already accepted
        if (invite.accepted) {
          console.log('[acceptFriendRequest] Invite already accepted');
          return respond({ error: 'Invite already accepted' }, 400);
        }

        // SECURITY: Verify that the user accepting is the intended recipient
        const { data: profile, error: profileErr } = await supabase
          .from('profiles')
          .select('email')
          .eq('id', user.id)
          .single();

        if (profileErr || !profile?.email) {
          console.log('[acceptFriendRequest] Could not get user email:', profileErr);
          return respond({ error: 'Could not verify user' }, 400);
        }

        const userEmail = profile.email.toLowerCase();
        const recipientEmail = invite.recipient_email.toLowerCase();

        if (userEmail !== recipientEmail) {
          console.log('[acceptFriendRequest] User', userEmail, 'is not the recipient', recipientEmail);
          return respond({ error: 'You are not the recipient of this invitation' }, 403);
        }

        console.log('[acceptFriendRequest] Creating friendships between', invite.sender_id, 'and', user.id);

        // Check if friendship already exists
        const { data: existingFriendship } = await supabase
          .from('awareness_friendships')
          .select('id')
          .eq('user1_id', invite.sender_id)
          .eq('user2_id', user.id)
          .maybeSingle();

        if (existingFriendship) {
          console.log('[acceptFriendRequest] Friendship already exists, just marking invite as accepted');
          // Friendship already exists, just mark the invite as accepted
          await supabase
            .from('awareness_invitations')
            .update({
              accepted: true,
              accepted_by: user.id,
              accepted_at: new Date().toISOString(),
            })
            .eq('id', invite_id);
          return respond({ data: { success: true, message: 'Already friends' } });
        }

        // Create mutual friendship with error handling
        const { data: friendshipData, error: friendshipErr } = await supabase
          .from('awareness_friendships')
          .insert([
            { user1_id: invite.sender_id, user2_id: user.id },
            { user1_id: user.id, user2_id: invite.sender_id },
          ])
          .select();

        if (friendshipErr) {
          console.error('[acceptFriendRequest] Failed to create friendship:', friendshipErr);
          return respond({ error: 'Failed to create friendship: ' + friendshipErr.message }, 500);
        }

        console.log('[acceptFriendRequest] Friendships created:', friendshipData);

        // Mark invitation as accepted
        const { error: updateErr } = await supabase
          .from('awareness_invitations')
          .update({
            accepted: true,
            accepted_by: user.id,
            accepted_at: new Date().toISOString(),
          })
          .eq('id', invite_id);

        if (updateErr) {
          console.error('[acceptFriendRequest] Failed to update invitation:', updateErr);
          return respond({ error: 'Failed to update invitation: ' + updateErr.message }, 500);
        }

        console.log('[acceptFriendRequest] Success!');
        return respond({ data: { success: true } });
      }

      case 'getFriends': {
        if (!user) return respond({ error: 'Not authenticated' }, 401);

        // 1) friendship rows
        const { data: friendships, error: rowsErr } = await supabase
          .from('awareness_friendships')
          .select('user2_id')
          .eq('user1_id', user.id);

        if (rowsErr) return respond({ error: rowsErr.message }, 400);

        if (!friendships || friendships.length === 0) {
          return respond({ data: [] });
        }

        const friendIds = friendships.map(f => f.user2_id);

        // 2) Get friend profiles with streaks - SAME fields as awareness.js
        const { data: friends, error: profErr } = await supabase
          .from('profiles')
          .select('id, display_name, email, current_streak, last_check_in, created_at')
          .in('id', friendIds);

        if (profErr) return respond({ error: profErr.message }, 400);

        return respond({ data: friends || [] });
      }

      case 'getFriendRequests': {
        if (!user) return respond({ error: 'Not authenticated' }, 401);

        // 1) invites for me
        const { data: invites, error } = await supabase
          .from('awareness_invitations')
          .select('id, sender_id, message, created_at, accepted')
          .eq('recipient_email', user.email)
          .eq('accepted', false)
          .order('created_at', { ascending: false });
        if (error) return respond({ error: error.message }, 400);

        // 2) fetch sender profiles (manual join)
        const senderIds = [...new Set((invites || []).map((i) => i.sender_id))];
        let profileMap = {};
        if (senderIds.length) {
          const { data: profs } = await supabase
            .from('profiles')
            .select('id, display_name, email')
            .in('id', senderIds);
          profileMap = Object.fromEntries((profs || []).map((p) => [p.id, p]));
        }

        const data = (invites || []).map((i) => ({
          ...i,
          profiles: profileMap[i.sender_id] || null,
        }));

        return respond({ data });
      }

	  case 'getSentFriendRequests': {
	    if (!user) return respond({ error: 'Not authenticated' }, 401);

	    try {
	  	const { data, error } = await supabase
	  	  .from('awareness_invitations')
	  	  .select('id, recipient_email, accepted, created_at')
	  	  .eq('sender_id', user.id)
	  	  .eq('accepted', false)
	  	  .order('created_at', { ascending: false });

	  	if (error) return respond({ error: error.message }, 400);
	  	return respond({ data: data || [] });
	    } catch (e) {
	  	console.error('getSentFriendRequests failed:', e);
	  	return respond({ error: e.message || 'Failed to load sent requests' }, 500);
	    }
	  }
	  break;

      case 'ignoreFriendRequest': {
        if (!user) return respond({ error: 'Not authenticated' }, 401);
        const { id } = payload || {};
        if (!id) return respond({ error: 'Missing id' }, 400);

        const { error } = await supabase.from('awareness_invitations').delete().eq('id', id);
        if (error) return respond({ error: error.message }, 400);
        return respond({ data: { success: true } });
      }

      case 'ignoreAllFriendRequests': {
        if (!user) return respond({ error: 'Not authenticated' }, 401);

        const { error } = await supabase
          .from('awareness_invitations')
          .delete()
          .eq('recipient_email', user.email)
          .eq('accepted', false);
        if (error) return respond({ error: error.message }, 400);
        return respond({ data: { success: true } });
      }

      /* ==========================
         MUSIC
      ========================== */
      case 'getUserMusic': {
        if (!user) return respond({ error: 'Not authenticated' }, 401);
        const { data, error } = await supabase
          .from('music_items')
          .select('*')
          .eq('user_id', user.id)
          .order('created_at', { ascending: false });
        if (error) return respond({ error: error.message }, 400);
        return respond({ data });
      }

      case 'getMusicItems': {
        const { data: musicItems, error: musicError } = await supabase
          .from('music_items')
          .select('*')
          .order('display_order', { ascending: true })
          .order('created_at', { ascending: false });
        if (musicError) return respond({ error: musicError.message }, 400);

        const userIds = [
          ...new Set((musicItems || []).map((i) => i.user_id).filter(Boolean)),
        ];
        let profileMap = {};
        if (userIds.length) {
          const { data: profs } = await supabase
            .from('profiles')
            .select('id, display_name, email')
            .in('id', userIds);
          profileMap = Object.fromEntries((profs || []).map((p) => [p.id, p]));
        }

        const itemsWithProfiles = (musicItems || []).map((item) => ({
          ...item,
          profiles: item.user_id
            ? profileMap[item.user_id] || { display_name: 'Unknown', email: null }
            : { display_name: 'EzTunes', email: null },
        }));

        return respond({ data: itemsWithProfiles });
      }

      case 'createMusicItem': {
        if (!user) return respond({ error: 'Not authenticated' }, 401);
        const { data, error } = await supabase
          .from('music_items')
          .insert([{ user_id: user.id, ...payload }])
          .select()
          .single();
        if (error) return respond({ error: error.message }, 400);
        return respond({ data });
      }

      case 'updateMusicItem': {
        if (!user) return respond({ error: 'Not authenticated' }, 401);
        const musicId = payload.musicId || payload.id;
        if (!musicId) return respond({ error: 'Missing id' }, 400);

        const updates =
          payload.updates || {
            type: payload.type,
            title: payload.title,
            artist: payload.artist,
            youtube_url: payload.youtube_url,
            thumbnail_url: payload.thumbnail_url,
            genre: payload.genre,
            description: payload.description,
            tags: payload.tags,
            is_public: payload.is_public,
          };

        const { data, error } = await supabase
          .from('music_items')
          .update(updates)
          .eq('id', musicId)
          .eq('user_id', user.id)
          .select()
          .single();
        if (error) return respond({ error: error.message }, 400);
        return respond({ data });
      }

      case 'deleteMusicItem': {
        if (!user) return respond({ error: 'Not authenticated' }, 401);
        const { musicId } = payload || {};
        if (!musicId) return respond({ error: 'Missing id' }, 400);

        const { error } = await supabase
          .from('music_items')
          .delete()
          .eq('id', musicId)
          .eq('user_id', user.id);
        if (error) return respond({ error: error.message }, 400);
        return respond({ data: { success: true } });
      }

      case 'adminCreateMusicItem': {
        if (!user) return respond({ error: 'Not authenticated' }, 401);
        const {
          type,
          title,
          artist,
          youtube_url,
          thumbnail_url,
          genre,
          description,
          tags,
          is_public,
          user_id,
          system,
        } = payload || {};
        if (!title || !artist || !youtube_url)
          return respond({ error: 'Missing required fields' }, 400);

        const row = {
          type: type || 'track',
          title,
          artist,
          youtube_url,
          thumbnail_url: thumbnail_url || null,
          genre: genre || null,
          description: description || null,
          tags: tags || null,
          is_public: !!is_public,
          user_id: user_id || null,
          system: !!system,
        };

        const { data, error } = await supabase.from('music_items').insert(row).select('*').single();
        if (error) return respond({ error: error.message }, 400);
        return respond({ data });
      }

      case 'adminUpdateMusicItem': {
        if (!user) return respond({ error: 'Not authenticated' }, 401);
        const {
          id,
          type,
          title,
          artist,
          youtube_url,
          thumbnail_url,
          genre,
          description,
          tags,
          is_public,
          user_id,
          system,
        } = payload || {};
        if (!id || !title || !artist || !youtube_url)
          return respond({ error: 'Missing required fields' }, 400);

        const updates = {
          type: type || 'track',
          title,
          artist,
          youtube_url,
          thumbnail_url: thumbnail_url || null,
          genre: genre || null,
          description: description || null,
          tags: tags || null,
          is_public: !!is_public,
          user_id: user_id || null,
          system: !!system,
        };

        const { data, error } = await supabase
          .from('music_items')
          .update(updates)
          .eq('id', id)
          .select('*')
          .single();
        if (error) return respond({ error: error.message }, 400);
        return respond({ data });
      }

      case 'adminDeleteMusicItem': {
        if (!user) return respond({ error: 'Not authenticated' }, 401);
        const { id } = payload || {};
        if (!id) return respond({ error: 'Missing id' }, 400);

        const { error } = await supabase.from('music_items').delete().eq('id', id);
        if (error) return respond({ error: error.message }, 400);
        return respond({ data: { success: true } });
      }

      case 'getTrendingMusic': {
        const sevenDaysAgo = new Date();
        sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

        const { data: plays, error: playsError } = await supabase
          .from('play_history')
          .select('music_item_id')
          .gte('played_at', sevenDaysAgo.toISOString())
          .not('music_item_id', 'is', null);
        if (playsError) return respond({ error: playsError.message }, 400);
        if (!plays || !plays.length) return respond({ data: [] });

        const playCount = {};
        plays.forEach((p) => {
          const id = p.music_item_id;
          if (id) playCount[id] = (playCount[id] || 0) + 1;
        });

        const topIds = Object.entries(playCount)
          .sort((a, b) => b[1] - a[1])
          .slice(0, 24)
          .map(([id]) => id);

        if (!topIds.length) return respond({ data: [] });

        const { data: items, error: itemsError } = await supabase
          .from('music_items')
          .select('*')
          .in('id', topIds)
          .eq('is_public', true);
        if (itemsError) return respond({ error: itemsError.message }, 400);

        const userIds = [...new Set(items.map((i) => i.user_id).filter(Boolean))];
        const { data: profiles } = await supabase
          .from('profiles')
          .select('id, display_name')
          .in('id', userIds);

        const profileMap = {};
        (profiles || []).forEach((p) => (profileMap[p.id] = p));

        const itemsMap = {};
        items.forEach((item) => {
          itemsMap[item.id] = {
            ...item,
            profiles: item.user_id ? profileMap[item.user_id] : null,
            play_count: playCount[item.id] || 0,
          };
        });

        const result = topIds.map((id) => itemsMap[id]).filter(Boolean);
        return respond({ data: result });
      }

      /* ==========================
         FOLLOW SYSTEM (basic)
      ========================== */
      case 'followUser': {
        if (!user) return respond({ error: 'Not authenticated' }, 401);
        const { target_id } = payload || {};
        if (!target_id) return respond({ error: 'Missing target user ID' }, 400);
        if (user.id === target_id) return respond({ error: 'You cannot follow yourself.' }, 400);

        const { data: existing, error: existingErr } = await supabase
          .from('follows')
          .select('follower_id, following_id')
          .eq('follower_id', user.id)
          .eq('following_id', target_id)
          .maybeSingle();
        if (existingErr) return respond({ error: existingErr.message }, 400);
        if (existing) return respond({ data: existing, message: 'Already following' });

        const { data, error } = await supabase
          .from('follows')
          .insert([{ follower_id: user.id, following_id: target_id }])
          .select()
          .single();
        if (error) return respond({ error: error.message }, 400);
        return respond({ data });
      }

      case 'unfollowUser': {
        if (!user) return respond({ error: 'Not authenticated' }, 401);
        const { target_id } = payload || {};
        if (!target_id) return respond({ error: 'Missing target user ID' }, 400);

        const { error } = await supabase
          .from('follows')
          .delete()
          .eq('follower_id', user.id)
          .eq('following_id', target_id);
        if (error) return respond({ error: error.message }, 400);
        return respond({ data: { success: true } });
      }

      case 'getFollowingList': {
        if (!user) return respond({ error: 'Not authenticated' }, 401);

        const { data: follows, error: followErr } = await supabase
          .from('follows')
          .select('following_id')
          .eq('follower_id', user.id);
        if (followErr) return respond({ error: followErr.message }, 400);

        const ids = (follows || []).map((f) => f.following_id);
        if (!ids.length) return respond({ data: [] });

        const { data: profs, error: profErr } = await supabase
          .from('profiles')
          .select('id, display_name')
          .in('id', ids);
        if (profErr) return respond({ error: profErr.message }, 400);

        const list = (profs || [])
          .map((p) => ({ id: p.id, display_name: p.display_name || 'Unknown' }))
          .sort((a, b) => a.display_name.localeCompare(b.display_name));

        return respond({ data: list });
      }

      case 'getFollowingFeed': {
        if (!user) return respond({ error: 'Not authenticated' }, 401);

        const { data: follows, error: followErr } = await supabase
          .from('follows')
          .select('following_id')
          .eq('follower_id', user.id);
        if (followErr) return respond({ error: followErr.message }, 400);

        const ids = (follows || []).map((f) => f.following_id);
        if (!ids.length) return respond({ data: [] });

        const { data: profs, error: profErr } = await supabase
          .from('profiles')
          .select('id, display_name')
          .in('id', ids);
        if (profErr) return respond({ error: profErr.message }, 400);

        const nameById = Object.fromEntries(
          (profs || []).map((p) => [p.id, p.display_name || 'Unknown'])
        );

        const { data: items, error: itemsErr } = await supabase
          .from('music_items')
          .select(
            'id, type, title, artist, youtube_url, thumbnail_url, genre, description, tags, is_public, user_id, created_at'
          )
          .in('user_id', ids)
          .eq('is_public', true)
          .order('created_at', { ascending: false });
        if (itemsErr) return respond({ error: itemsErr.message }, 400);

        const data = (items || []).map((i) => ({
          ...i,
          profiles: { display_name: nameById[i.user_id] || 'Unknown' },
        }));

        return respond({ data });
      }

      /* ==========================
         NOW PLAYING
      ========================== */
      case 'setNowPlaying': {
        if (!user) return respond({ error: 'Not authenticated' }, 401);
        const {
          music_item_id,
          title,
          artist,
          youtube_url,
          is_playing = true,
          started_at = new Date().toISOString(),
        } = payload || {};
        if (!title || !youtube_url) return respond({ error: 'Missing required fields' }, 400);

        const row = {
          user_id: user.id,
          music_item_id: music_item_id || null,
          title,
          artist: artist || null,
          youtube_url,
          is_playing: !!is_playing,
          started_at,
        };

        const { data, error } = await supabase
          .from('now_playing')
          .upsert(row, { onConflict: 'user_id' })
          .select('*')
          .single();
        if (error) return respond({ error: error.message }, 400);
        return respond({ data });
      }

      case 'stopNowPlaying': {
        if (!user) return respond({ error: 'Not authenticated' }, 401);
        const { data, error } = await supabase
          .from('now_playing')
          .update({ is_playing: false })
          .eq('user_id', user.id)
          .select('*')
          .maybeSingle();
        if (error) return respond({ error: error.message }, 400);
        return respond({ data: data || { success: true } });
      }

      case 'getNowPlaying': {
        if (!user) return respond({ error: 'Not authenticated' }, 401);
        const target = payload?.target_user_id ? payload.target_user_id : user.id;

        const { data, error } = await supabase
          .from('now_playing')
          .select('user_id, music_item_id, title, artist, youtube_url, is_playing, started_at')
          .eq('user_id', target)
          .maybeSingle();
        if (error) return respond({ error: error.message }, 400);
        return respond({ data });
      }

      /* ==========================
         VIDEO SIGNALING
      ========================== */
      case 'createVideoSession': {
        if (!user) return respond({ error: 'Not authenticated' }, 401);
        const { tags = ['music'] } = payload || {};
        const { data, error } = await supabase
          .from('video_sessions')
          .insert([{ host_id: user.id, status: 'waiting', tags }])
          .select()
          .single();
        if (error) return respond({ error: error.message }, 400);
        return respond({ data });
      }

      case 'joinVideoSession': {
        if (!user) return respond({ error: 'Not authenticated' }, 401);
        const { session_id } = payload || {};
        if (!session_id) return respond({ error: 'Missing session_id' }, 400);

        const { data, error } = await supabase
          .from('video_sessions')
          .update({ guest_id: user.id, status: 'active' })
          .eq('id', session_id)
          .select()
          .single();
        if (error) return respond({ error: error.message }, 400);
        return respond({ data });
      }

      case 'updateVideoStatus': {
        if (!user) return respond({ error: 'Not authenticated' }, 401);
        const { session_id, updates } = payload || {};
        if (!session_id || !updates) return respond({ error: 'Missing required fields' }, 400);

        const { data, error } = await supabase
          .from('video_sessions')
          .update(updates)
          .eq('id', session_id)
          .select()
          .single();
        if (error) return respond({ error: error.message }, 400);
        return respond({ data });
      }

      case 'listAvailableSessions': {
        if (!user) return respond({ error: 'Not authenticated' }, 401);
        const { tags = [] } = payload || {};
        let query = supabase
          .from('video_sessions')
          .select(
            'id, host_id, guest_id, status, tags, created_at, offer_sdp, answer_sdp, ice_candidates'
          )
          .is('guest_id', null)
          .eq('status', 'waiting')
          .order('created_at', { ascending: false })
          .limit(10);

        query = tags.length ? query.overlaps('tags', tags) : query.overlaps('tags', ['music']);

        const { data, error } = await query;
        if (error) return respond({ error: error.message }, 400);
        return respond({ data });
      }

      case 'listActiveSessions': {
        if (!user) return respond({ error: 'Not authenticated' }, 401);
        const { tags } = payload || {};
        const { data, error } = await supabase
          .from('video_sessions')
          .select('*')
          .eq('status', 'active')
          .contains('tags', tags || [])
          .order('created_at', { ascending: false });
        if (error) return respond({ error: error.message }, 400);
        return respond({ data });
      }

      case 'updateVideoOffer': {
        if (!user) return respond({ error: 'Not authenticated' }, 401);
        const { session_id, offer_sdp } = payload || {};
        if (!session_id || !offer_sdp) return respond({ error: 'Missing data' }, 400);

        const { data, error } = await supabase
          .from('video_sessions')
          .update({ offer_sdp })
          .eq('id', session_id)
          .eq('host_id', user.id)
          .select()
          .single();
        if (error) return respond({ error: error.message }, 400);
        return respond({ data });
      }

      case 'updateVideoAnswer': {
        if (!user) return respond({ error: 'Not authenticated' }, 401);
        const { session_id, answer_sdp } = payload || {};
        if (!session_id || !answer_sdp) return respond({ error: 'Missing data' }, 400);

        const { data, error } = await supabase
          .from('video_sessions')
          .update({ answer_sdp, status: 'connected' })
          .eq('id', session_id)
          .select()
          .single();
        if (error) return respond({ error: error.message }, 400);
        return respond({ data });
      }

      case 'getVideoSession': {
        if (!user) return respond({ error: 'Not authenticated' }, 401);
        const { session_id } = payload || {};
        if (!session_id) return respond({ error: 'Missing session_id' }, 400);

        const { data, error } = await supabase
          .from('video_sessions')
          .select('*')
          .eq('id', session_id)
          .single();
        if (error) return respond({ error: error.message }, 400);
        return respond({ data });
      }

      case 'appendIceCandidates': {
        if (!user) return respond({ error: 'Not authenticated' }, 401);
        const { session_id, from, candidates } = payload || {};
        if (!session_id || !from || !Array.isArray(candidates)) {
          return respond({ error: 'Missing data' }, 400);
        }

        const { data: row, error: getErr } = await supabase
          .from('video_sessions')
          .select('ice_candidates')
          .eq('id', session_id)
          .single();
        if (getErr) return respond({ error: getErr.message }, 400);

        const existing = Array.isArray(row?.ice_candidates) ? row.ice_candidates : [];
        const stamped = candidates.map((c) => ({ ...c, from }));
        const next = existing.concat(stamped);

        const { data, error } = await supabase
          .from('video_sessions')
          .update({ ice_candidates: next })
          .eq('id', session_id)
          .select()
          .single();
        if (error) return respond({ error: error.message }, 400);
        return respond({ data });
      }

      case 'getIceCandidates': {
        if (!user) return respond({ error: 'Not authenticated' }, 401);
        const { session_id, from } = payload || {};
        if (!session_id || !from) return respond({ error: 'Missing data' }, 400);

        const { data: row, error } = await supabase
          .from('video_sessions')
          .select('ice_candidates')
          .eq('id', session_id)
          .single();
        if (error) return respond({ error: error.message }, 400);

        const all = Array.isArray(row?.ice_candidates) ? row.ice_candidates : [];
        const filtered = all.filter((c) => c && c.from === from).map(({ from: _f, ...rest }) => rest);
        return respond({ data: filtered });
      }

	  /* ==========================
	     AD MANAGEMENT CORE ACTIONS
	  ========================== */

	  case 'getAdFiles': {
	    const baseUrl = 'https://www.eztunes.xyz/ads/';
	    try {
	  	const res = await fetch(baseUrl + 'files.json');
	  	const files = await res.json();
	  	const data = files.map(f => ({ filename: f, url: baseUrl + f }));
	  	return respond({ data });
	    } catch (err) {
	  	console.error('Failed to load files.json', err);
	  	return respond({ error: 'Failed to load ad file list' }, 500);
	    }
	  }
	  
	  case 'getAds': {
	    // Allow admins only
	    if (!user) return respond({ error: 'Not authenticated' }, 401);
	  
	    const { data, error } = await adminSupabase
	  	.from('ads')
	  	.select('*')
	  	.order('created_at', { ascending: false });
	  
	    if (error) return respond({ error: error.message }, 400);
	    return respond({ data });
	  }
	  
	  case 'insertAd': {
	    if (!user) return respond({ error: 'Not authenticated' }, 401);
	    const { title, image_url, target_url, zone, width, height, active, ad_number } = payload || {};
	  
	    if (!title || !image_url || !target_url)
	  	return respond({ error: 'Missing required fields' }, 400);
	  
	    const { data, error } = await adminSupabase
	  	.from('ads')
	  	.insert([{
	  	  title,
	  	  image_url,
	  	  target_url,
	  	  zone: zone || 'default',
	  	  width: width || null,
	  	  height: height || null,
	  	  active: active ?? true,
	  	  ad_number: ad_number || null,
	  	  created_by: user.id,
	  	  created_at: new Date().toISOString()
	  	}])
	  	.select('*')
	  	.single();
	  
	    if (error) return respond({ error: error.message }, 400);
	    return respond({ data });
	  }
	  
	  case 'updateAd': {
	    if (!user) return respond({ error: 'Not authenticated' }, 401);
	    const { id, updates } = payload || {};
	    if (!id || !updates) return respond({ error: 'Missing id or updates' }, 400);
	  
	    const { data, error } = await adminSupabase
	  	.from('ads')
	  	.update(updates)
	  	.eq('id', id)
	  	.select('*')
	  	.single();
	  
	    if (error) return respond({ error: error.message }, 400);
	    return respond({ data });
	  }
	  
	  case 'deleteAd': {
	    if (!user) return respond({ error: 'Not authenticated' }, 401);
	    const { id } = payload || {};
	    if (!id) return respond({ error: 'Missing ad id' }, 400);
	  
	    const { error } = await adminSupabase.from('ads').delete().eq('id', id);
	    if (error) return respond({ error: error.message }, 400);
	    return respond({ data: { success: true } });
	  }


      /* ==========================
         ADS
      ========================== */
      case 'fetchAd': {
        const { zone, id, ad_number } = payload || {};
        let query = supabase.from('ads').select('*').eq('active', true);

        const isUuid =
          typeof id === 'string' &&
          /^[0-9a-fA-F-]{8}-[0-9a-fA-F-]{4}-[0-9a-fA-F-]{4}-[0-9a-fA-F-]{4}-[0-9a-fA-F-]{12}$/.test(
            id
          );

        if (isUuid) {
          query = query.eq('id', id);
        } else if (id && !isNaN(id)) {
          query = query.eq('ad_number', Number(id));
        } else if (ad_number && !isNaN(ad_number)) {
          query = query.eq('ad_number', Number(ad_number));
        }

        if (zone) query = query.ilike('zone', zone);

        const { data, error } = await query.limit(1).maybeSingle();
        if (error) return respond({ error: error.message }, 400);
        if (!data) return respond({ error: 'No ad found' }, 404);

        if (data.image_file && !data.image_url) {
          data.image_url = `https://www.eztunes.xyz/ads/${data.image_file}`;
        }

        return respond({ data });
      }

      case 'logView': {
        const { id, page_url, referrer } = payload || {};
        if (!id) return respond({ error: 'Missing ad ID' }, 400);

        const { error } = await supabase.from('ad_views').insert({
          ad_id: id,
          page_url: page_url || null,
          referrer: referrer || null,
        });
        if (error) return respond({ error: error.message }, 400);
        return respond({ data: 'view logged' });
      }

      case 'logClick': {
        const { id, page_url, referrer } = payload || {};
        if (!id) return respond({ error: 'Missing ad ID' }, 400);

        const { error } = await supabase.from('ad_clicks').insert({
          ad_id: id,
          page_url: page_url || null,
          referrer: referrer || null,
        });
        if (error) return respond({ error: error.message }, 400);
        return respond({ data: 'click logged' });
      }

      case 'getAdStats': {
        const { id } = payload || {};
        if (!id) return respond({ error: 'Missing ad ID' }, 400);

        const { count: views } = await supabase
          .from('ad_views')
          .select('*', { count: 'exact', head: true })
          .eq('ad_id', id);

        const { count: clicks } = await supabase
          .from('ad_clicks')
          .select('*', { count: 'exact', head: true })
          .eq('ad_id', id);

        const { data: topPages } = await supabase
          .from('ad_views')
          .select('page_url')
          .eq('ad_id', id)
          .order('viewed_at', { ascending: false })
          .limit(1000);

        const counts = {};
        (topPages || []).forEach((row) => {
          const url = row.page_url || '(unknown)';
          counts[url] = (counts[url] || 0) + 1;
        });

        const topList = Object.entries(counts)
          .sort((a, b) => b[1] - a[1])
          .slice(0, 5)
          .map(([page_url, count]) => ({ page_url, count }));

        return respond({ data: { views: views || 0, clicks: clicks || 0, topPages: topList } });
      }

      /* ==========================
         CASINO WALLET + PLAY
      ========================== */

      case 'getBalances': {
        if (!user) return respond({ error: 'Not authenticated' }, 401);
        const w = await getWalletRow(supabase, user.id);
        return respond({ data: { cash_cents: w.cash_cents, credits: w.credits, tokens: w.tokens, xp: w.xp } });
      }

      case 'addCashCents': {
        if (!user) return respond({ error: 'Not authenticated' }, 401);
        const cents = Math.max(0, Math.floor((payload && payload.cents) || 0));
        if (!cents) return respond({ error: 'Invalid amount' }, 400);

        const w = await getWalletRow(supabase, user.id);
        w.cash_cents += cents;
        await saveWalletRow(supabase, w);
        return respond({ data: { cash_cents: w.cash_cents, credits: w.credits, tokens: w.tokens, xp: w.xp } });
      }

	  case 'cashToCredits': {
	    if (!user) return respond({ error: 'Not authenticated' }, 401);
	    const usd = Math.max(0, Math.floor((payload && payload.usd) || 0));
	    if (!usd) return respond({ error: 'Invalid amount' }, 400);
	  
	    const need = usd * 100; // cents
	    const w = await getWalletRow(supabase, user.id);
	    if (w.cash_cents < need) return respond({ error: 'Not enough cash' }, 400);
	  
	    w.cash_cents -= need;
	    w.credits += usd * CREDITS_PER_USD; // ← uses the constant you defined above
	    await saveWalletRow(supabase, w);
	    return respond({ data: { cash_cents: w.cash_cents, credits: w.credits, tokens: w.tokens, xp: w.xp } });
	  }


      case 'creditsToTokens': {
        if (!user) return respond({ error: 'Not authenticated' }, 401);
        const credits = Math.max(0, Math.floor((payload && payload.credits) || 0));
        if (!credits) return respond({ error: 'Invalid amount' }, 400);

        const w = await getWalletRow(supabase, user.id);
        if (w.credits < credits) return respond({ error: 'Not enough credits' }, 400);

        const tokens = Math.floor(credits / CREDITS_PER_TOKEN);
        if (tokens <= 0) return respond({ error: 'Amount below 1 token' }, 400);

        w.credits -= tokens * CREDITS_PER_TOKEN;
        w.tokens  += tokens;
        await saveWalletRow(supabase, w);
        return respond({ data: { cash_cents: w.cash_cents, credits: w.credits, tokens: w.tokens, xp: w.xp } });
      }

      case 'gemsToTokens': {
        if (!user) return respond({ error: 'Not authenticated' }, 401);
        const gemsToConvert = Math.max(0, Math.floor((payload && payload.gems) || 0));
        if (!gemsToConvert) return respond({ error: 'Invalid amount' }, 400);

        // Get user's profile gems (universal gems)
        const { data: profile, error: profileError } = await supabase
          .from('profiles')
          .select('gems, gems_spent')
          .eq('id', user.id)
          .single();

        if (profileError || !profile) {
          return respond({ error: 'Profile not found' }, 400);
        }

        const currentGems = profile.gems || 0;
        if (currentGems < gemsToConvert) {
          return respond({ error: 'Not enough gems' }, 400);
        }

        const tokensToAdd = Math.floor(gemsToConvert / GEMS_PER_TOKEN);
        if (tokensToAdd <= 0) {
          return respond({ error: 'Amount below 1 token' }, 400);
        }

        const gemsUsed = tokensToAdd * GEMS_PER_TOKEN;

        // Deduct gems from profile
        const { error: gemUpdateError } = await supabase
          .from('profiles')
          .update({
            gems: currentGems - gemsUsed,
            gems_spent: (profile.gems_spent || 0) + gemsUsed
          })
          .eq('id', user.id);

        if (gemUpdateError) {
          return respond({ error: 'Failed to update gems' }, 500);
        }

        // Add tokens to Haven wallet
        const w = await getWalletRow(supabase, user.id);
        w.tokens += tokensToAdd;
        await saveWalletRow(supabase, w);

        return respond({
          data: {
            gems_remaining: currentGems - gemsUsed,
            tokens_added: tokensToAdd,
            cash_cents: w.cash_cents,
            credits: w.credits,
            tokens: w.tokens,
            xp: w.xp
          }
        });
      }

      case 'spinResult': {
        if (!user) return respond({ error: 'Not authenticated' }, 401);
        const bet = Math.max(1, Math.floor((payload && payload.bet) || 0));
        const win = Math.max(0, Math.floor((payload && payload.win) || 0));

        const w = await getWalletRow(supabase, user.id);
        if (w.tokens < bet) return respond({ error: 'Not enough tokens' }, 400);

        w.tokens -= bet;
        w.tokens += win;
        w.xp     += XP_PER_SPIN;

        await saveWalletRow(supabase, w);
        return respond({ data: { cash_cents: w.cash_cents, credits: w.credits, tokens: w.tokens, xp: w.xp } });
      }

      /* ==========================
         CASINO PACK PURCHASE
      ========================== */
	  case 'buyCreditsPack': {
		if (!user) return respond({ error: 'Not authenticated' }, 401);
		
		// ADMIN ONLY for testing - remove this check when Stripe is integrated
		const perm = await checkPermission(adminSupabase, user.id, null, 'ADMIN');
		if (!perm.authorized) {
		  return respond({ error: 'Admin only during testing phase' }, 403);
		}
		
		const usd = Math.max(0, Math.floor((payload && payload.usd) || 0));
		if (![5,10].includes(usd)) return respond({ error: 'Only $5 or $10 packs in this demo' }, 400);
	  
		const w = await getWalletRow(supabase, user.id);
		w.credits = (w.credits || 0) + (usd * CREDITS_PER_USD); // $1 → 100 credits
		await saveWalletRow(supabase, w);
		return respond({ data: { cash_cents: w.cash_cents, credits: w.credits, tokens: w.tokens, xp: w.xp } });
	  }

	  case 'claimWelcomeBonus': {
		if (!user) return respond({ error: 'Not authenticated' }, 401);

		// Check if they already claimed it
		const { data: settings, error: settingsErr } = await supabase
		  .from('user_display_settings')
		  .select('welcome_bonus_claimed')
		  .eq('user_id', user.id)
		  .maybeSingle();

		if (settingsErr) {
		  return respond({ error: 'Could not check bonus status' }, 500);
		}

		// Already claimed
		if (settings && settings.welcome_bonus_claimed === true) {
		  return respond({ error: 'You already claimed your welcome bonus' }, 400);
		}

		// Give them $5 worth of credits (500 credits)
		const w = await getWalletRow(supabase, user.id);
		w.credits = (w.credits || 0) + 500; // $5 = 500 credits
		await saveWalletRow(supabase, w);

		// Mark as claimed
		const { error: updateErr } = await supabase
		  .from('user_display_settings')
		  .upsert({
			user_id: user.id,
			welcome_bonus_claimed: true,
			welcome_bonus_claimed_at: new Date().toISOString()
		  }, { onConflict: 'user_id' });

		if (updateErr) {
		  console.error('Failed to mark bonus claimed:', updateErr);
		  // Don't fail the response - they got their credits already
		}

		return respond({ 
		  data: { 
			credits: w.credits,
			tokens: w.tokens,
			xp: w.xp,
			message: 'Welcome bonus claimed! You got 500 credits ($5 value)!'
		  } 
		});
	  }

	  case 'checkWelcomeBonusStatus': {
		if (!user) return respond({ error: 'Not authenticated' }, 401);

		const { data: settings, error: settingsErr } = await supabase
		  .from('user_display_settings')
		  .select('welcome_bonus_claimed')
		  .eq('user_id', user.id)
		  .maybeSingle();

		if (settingsErr) {
		  return respond({ error: 'Could not check bonus status' }, 500);
		}

		const canClaim = !settings || settings.welcome_bonus_claimed !== true;

		return respond({ 
		  data: { 
			can_claim: canClaim,
			already_claimed: !canClaim
		  } 
		});
	  }

		/* ==========================
		   JOURNALGEN: ENTRIES (table)
		========================== */
	  case 'upsertJournalEntries': {
		  if (!user) return respond({ error: 'Not authenticated' }, 401);
		  // payload.rows: [{ day, items }]
		  const rows = Array.isArray(payload?.rows) ? payload.rows : [];
		  if (!rows.length) return respond({ data: [] });

		  // store per-user by (user_id, day)
		  const shaped = rows.map(r => ({ user_id: user.id, day: String(r.day), items: r.items || [] }));

		  const { error } = await adminSupabase
			.from('journal_entries')
			.upsert(shaped, { onConflict: 'user_id,day' });

		  if (error) return respond({ error: error.message }, 400);
		  return respond({ data: 'ok' });
	  }

	  case 'fetchJournalEntries': {
		  if (!user) return respond({ error: 'Not authenticated' }, 401);

		  const { data, error } = await adminSupabase
			.from('journal_entries')
			.select('day, items')
			.eq('user_id', user.id)
			.order('day', { ascending: true });

		  if (error) return respond({ error: error.message }, 400);
		  return respond({ data: data || [] });
	  }

		/* ==========================
		   JOURNALGEN: IMAGES (bucket)
		========================== */
	  case 'uploadJournalImage': {
		  if (!user) return respond({ error: 'Not authenticated' }, 401);

		  const entryId = String(payload?.entryId || '');
		  const base64 = payload?.base64; // raw base64 (no data: header)
		  if (!entryId || !base64) return respond({ error: 'Bad payload' }, 400);

		  // ensure private bucket exists (idempotent)
		  try { await adminSupabase.storage.createBucket('journalgen', { public: false }); } catch (_) {}

		  const buffer = Buffer.from(base64, 'base64');
		  const path = `${user.id}/${entryId}.webp`;

		  const { error } = await adminSupabase
			.storage
			.from('journalgen')
			.upload(path, buffer, { upsert: true, contentType: 'image/webp' });

		  if (error) return respond({ error: error.message }, 400);
		  return respond({ data: { path } });
	  }

	  case 'getJournalImage': {
		  if (!user) return respond({ error: 'Not authenticated' }, 401);

		  const entryId = String(payload?.entryId || '');
		  if (!entryId) return respond({ error: 'Bad payload' }, 400);

		  const path = `${user.id}/${entryId}.webp`;

		  const { data, error } = await adminSupabase
			.storage
			.from('journalgen')
			.download(path);

		  if (error || !data) return respond({ error: 'Not found' }, 404);

		  const arrayBuffer = await data.arrayBuffer();
		  const base64 = Buffer.from(arrayBuffer).toString('base64');
		  return respond({ data: { base64 } });
	  }

	  case 'getSlotsState': {
		  const authedUser = await getUserFromAuthHeader(event.headers);
		  if (!authedUser) {
			return respond({ error: 'not-authenticated' }, 401);
		  }

		  // wallet
		  const { data: walletRows, error: walletErr } = await supabase
			.from('user_display_settings')
			.select('tokens, credits, xp')
			.eq('user_id', authedUser.id)
			.limit(1);

		  if (walletErr) {
			return respond({ error: 'wallet-failed' }, 500);
		  }

		  const wallet = walletRows && walletRows[0]
			? walletRows[0]
			: { tokens: 0, credits: 0, xp: 0 };

		  // make sure stats row exists
		  await ensureUserStatsRow(supabase, authedUser.id);

		  // stats (NOTE: last_reels is stored in haven_user_stats.last_reels)
		  const { data: statRows, error: statErr } = await supabase
			.from('haven_user_stats')
			.select('slots_spins, slots_wins, slots_win_streak, last_played_at, last_reels')
			.eq('user_id', authedUser.id)
			.limit(1);

		  if (statErr) {
			return respond({ error: 'stats-failed' }, 500);
		  }

		  const stats = statRows && statRows[0]
			? statRows[0]
			: {
				slots_spins: 0,
				slots_wins: 0,
				slots_win_streak: 0,
				last_played_at: null,
				last_reels: null
			  };

		  return respond({
			data: {
			  tokens: wallet.tokens || 0,
			  credits: wallet.credits || 0,
			  xp: wallet.xp || 0,

			  slots_spins: stats.slots_spins || 0,
			  slots_wins: stats.slots_wins || 0,
			  slots_win_streak: stats.slots_win_streak || 0,
			  last_played_at: stats.last_played_at || null,
			  last_reels: stats.last_reels || null,

			  spin_cost: SLOT_SPIN_COST
			}
		  }, 200);
	  }


	  case 'spinSlots': {
		  const authedUser = await getUserFromAuthHeader(event.headers);
		  if (!authedUser) {
			return respond({ error: 'not-authenticated' }, 401);
		  }

		  // read wallet
		  const { data: walletRows, error: walletErr } = await supabase
			.from('user_display_settings')
			.select('tokens, credits, xp')
			.eq('user_id', authedUser.id)
			.limit(1);

		  if (walletErr) {
			return respond({ error: 'wallet-failed' }, 500);
		  }

		  // default wallet if row doesn't exist yet
		  let wallet = walletRows && walletRows[0]
			? walletRows[0]
			: { tokens: 0, credits: 0, xp: 0 };

		  // have enough tokens to spin?
		  if ((wallet.tokens || 0) < SLOT_SPIN_COST) {
			return respond({ data: { error: 'not-enough-tokens' } }, 200);
		  }

		  // spin the machine
		  const spin = doSlotSpin();
		  // spin = { reels:[..3..], winTokens, didWin, jackpot }

		  // apply cost / winnings / xp
		  let newTokens = (wallet.tokens || 0) - SLOT_SPIN_COST;
		  newTokens += (spin.winTokens || 0);

		  let newXp = (wallet.xp || 0) + XP_PER_SPIN;

		  // write wallet back
		  const { error: upWalletErr } = await supabase
			.from('user_display_settings')
			.update({
			  tokens: newTokens,
			  credits: wallet.credits || 0,
			  xp: newXp,
			  updated_at: new Date().toISOString()
			})
			.eq('user_id', authedUser.id);

		  if (upWalletErr) {
			return respond({ error: 'wallet-update-failed' }, 500);
		  }

		  // make sure stats row exists
		  await ensureUserStatsRow(supabase, authedUser.id);

		  // pull current stats
		  const { data: statRows, error: statErr } = await supabase
			.from('haven_user_stats')
			.select('slots_spins, slots_wins, slots_win_streak')
			.eq('user_id', authedUser.id)
			.limit(1);

		  if (statErr) {
			return respond({ error: 'stats-read-failed' }, 500);
		  }

		  let stats = statRows && statRows[0]
			? statRows[0]
			: { slots_spins: 0, slots_wins: 0, slots_win_streak: 0 };

		  // bump stats
		  const nextSpins = (stats.slots_spins || 0) + 1;
		  let nextWins = stats.slots_wins || 0;
		  let nextStreak = stats.slots_win_streak || 0;

		  if (spin.didWin) {
			nextWins += 1;
			nextStreak += 1;
		  } else {
			nextStreak = 0;
		  }

		  // save stats, including last_reels for dashboard + reload
		  // PostgreSQL text[] array needs proper format
		  const reelsArray = Array.isArray(spin.reels) ? spin.reels : [spin.reels[0], spin.reels[1], spin.reels[2]];
		  
		  const { error: upStatsErr } = await supabase
			.from('haven_user_stats')
			.update({
			  slots_spins: nextSpins,
			  slots_wins: nextWins,
			  slots_win_streak: nextStreak,
			  last_reels: reelsArray, // PostgreSQL will accept JS array and convert to text[]
			  last_played_at: new Date().toISOString(),
			  updated_at: new Date().toISOString()
			})
			.eq('user_id', authedUser.id);

		  if (upStatsErr) {
			console.error('Stats update error:', upStatsErr);
			return respond({ error: 'stats-update-failed', details: upStatsErr.message }, 500);
		  }

		  // send result back to UI
		  return respond({
			data: {
			  reels: spin.reels,
			  didWin: spin.didWin,
			  jackpot: spin.jackpot,
			  winTokens: spin.winTokens,

			  tokens: newTokens,
			  credits: wallet.credits || 0,
			  xp: newXp,

			  slots_spins: nextSpins,
			  slots_wins: nextWins,
			  slots_win_streak: nextStreak,

			  last_reels: spin.reels,
			  spin_cost: SLOT_SPIN_COST
			}
		  }, 200);
	  }


      case 'getHavenDashboard': {
        if (!user) return respond({ error: 'Not authenticated' }, 401);

        // 1. Core profile / streak / role / base credits
        const { data: profRow, error: profErr } = await adminSupabase
          .from('profiles')
          .select('id, email, display_name, role, current_streak, last_check_in, credits')
          .eq('id', user.id)
          .single();
        if (profErr) return respond({ error: profErr.message }, 400);

        // 2. Wallet-ish numbers from user_display_settings (cash/credits/tokens/xp)
        const { data: walletRow, error: walletErr } = await adminSupabase
          .from('user_display_settings')
          .select('cash_cents, credits, tokens, xp')
          .eq('user_id', user.id)
          .maybeSingle();
        // walletRow can be null if they've never saved settings; that's fine

        // 3. Streamer payout info from haven_wallet (their running balance etc.)
        const { data: payoutRow, error: payoutErr } = await adminSupabase
          .from('haven_wallet')
          .select('payout_balance_usd, last_payout_requested_at')
          .eq('user_id', user.id)
          .maybeSingle();
        // payoutRow can be null if they haven't earned yet

        // 4. Mood / status line from haven_profiles
        // (this is what we'd show in "Status / Mood" card)
        const { data: statusRow, error: statusErr } = await adminSupabase
          .from('haven_profiles')
          .select('status_flag, mood_note, updated_at')
          .eq('user_id', user.id)
          .maybeSingle();
        // no hard fail if null
        if (statusErr) {
          console.warn('getHavenDashboard haven_profiles err', statusErr.message);
        }

        // 5. Pet state (emotional support buddy panel)
        const { data: petRow, error: petErr } = await adminSupabase
          .from('haven_pet_state')
          .select('pet_name, mood, affection_level, hunger_level, last_interaction, updated_at')
          .eq('user_id', user.id)
          .maybeSingle();
        if (petErr) {
          console.warn('getHavenDashboard haven_pet_state err', petErr.message);
        }

        // 6. User stats / mini-games / participation record
        const { data: statsRow, error: statsErr } = await adminSupabase
          .from('haven_user_stats')
          .select('survey_best_score, last_played_at, updated_at')
          .eq('user_id', user.id)
          .maybeSingle();
        if (statsErr) {
          console.warn('getHavenDashboard haven_user_stats err', statsErr.message);
        }

        // 7. What they're currently listening to / sharing
        //    (now_playing is per-user, 1 row max keyed by user_id in your schema)
        const { data: nowPlayingRow, error: nowErr } = await adminSupabase
          .from('now_playing')
          .select('music_item_id, title, artist, youtube_url, started_at, is_playing, updated_at')
          .eq('user_id', user.id)
          .maybeSingle();
        if (nowErr) {
          console.warn('getHavenDashboard now_playing err', nowErr.message);
        }

        // 8. Upcoming / recent events (listen parties, watch hangs, etc.)
        // We’ll grab next ~24 hours and also anything that started in last ~2 hours,
        // so host can still see "what just happened / what's about to happen."
        const nowTs = new Date();
        const twoHoursAgo = new Date(nowTs.getTime() - 2 * 60 * 60 * 1000).toISOString();
        const nextDay = new Date(nowTs.getTime() + 24 * 60 * 60 * 1000).toISOString();

        const { data: eventsRows, error: eventsErr } = await adminSupabase
          .from('haven_events')
          .select('id, host_user_id, type, title, description, start_time, end_time, access_type, credit_cost, media_url, created_at')
          .gte('start_time', twoHoursAgo)
          .lte('start_time', nextDay)
          .order('start_time', { ascending: true });
        if (eventsErr) {
          console.warn('getHavenDashboard haven_events err', eventsErr.message);
        }

        // 9. Optional: count active video sessions the user is in or could join
        //    (We're not returning SDP blobs etc. Just high-level summary.)
        //    "status" looks like 'waiting' / 'active'
        const { data: vidRows, error: vidErr } = await adminSupabase
          .from('video_sessions')
          .select('id, host_id, guest_id, status, tags, created_at, updated_at')
          .or(`host_id.eq.${user.id},guest_id.eq.${user.id}`)
          .in('status', ['waiting','active']);
        if (vidErr) {
          console.warn('getHavenDashboard video_sessions err', vidErr.message);
        }

        // Shape the final response so the front-end can just consume it
        const dashboardPayload = {
          profile: {
            id: profRow.id,
            email: profRow.email,
            display_name: profRow.display_name,
            role: profRow.role || 'USER',
            current_streak: profRow.current_streak ?? 0,
            last_check_in: profRow.last_check_in || null,
            base_credits: profRow.credits ?? 0
          },

          wallet: {
            // from user_display_settings
            cash_cents: walletRow ? Number(walletRow.cash_cents || 0) : 0,
            credits: walletRow ? Number(walletRow.credits || 0) : 0,
            tokens: walletRow ? Number(walletRow.tokens || 0) : 0,
            xp: walletRow ? Number(walletRow.xp || 0) : 0,

            // from haven_wallet
            payout_balance_usd: payoutRow ? Number(payoutRow.payout_balance_usd || 0) : 0,
            last_payout_requested_at: payoutRow ? payoutRow.last_payout_requested_at || null : null
          },

          status: {
            status_flag: statusRow ? statusRow.status_flag : null,
            mood_note: statusRow ? statusRow.mood_note : null,
            updated_at: statusRow ? statusRow.updated_at : null
          },

          pet: petRow
            ? {
                pet_name: petRow.pet_name || 'Buddy',
                mood: petRow.mood || 'okay',
                affection_level: petRow.affection_level ?? 0,
                hunger_level: petRow.hunger_level ?? 0,
                last_interaction: petRow.last_interaction || null,
                updated_at: petRow.updated_at || null
              }
            : null,

          stats: statsRow
            ? {
                survey_best_score: statsRow.survey_best_score ?? 0,
                last_played_at: statsRow.last_played_at || null,
                updated_at: statsRow.updated_at || null
              }
            : null,

          now_playing: nowPlayingRow
            ? {
                title: nowPlayingRow.title,
                artist: nowPlayingRow.artist || null,
                youtube_url: nowPlayingRow.youtube_url,
                started_at: nowPlayingRow.started_at,
                is_playing: nowPlayingRow.is_playing,
                updated_at: nowPlayingRow.updated_at || null
              }
            : null,

          events_upcoming: (eventsRows || []).map(e => ({
            id: e.id,
            host_user_id: e.host_user_id,
            type: e.type, // "watch" / "listen" / "hang" etc.
            title: e.title,
            description: e.description,
            start_time: e.start_time,
            end_time: e.end_time,
            access_type: e.access_type,   // "open", "paid", etc.
            credit_cost: e.credit_cost,
            media_url: e.media_url,
            created_at: e.created_at
          })),

          live_sessions: (vidRows || []).map(v => ({
            id: v.id,
            status: v.status,       // 'waiting' / 'active'
            host_id: v.host_id,
            guest_id: v.guest_id,
            tags: v.tags || [],
            created_at: v.created_at,
            updated_at: v.updated_at
          }))
        };

        return respond({ data: dashboardPayload });
      }


      /* ==========================
         PEANUT BUTTER CRUSADES GAME
      ========================== */

      case 'getPBCProgress': {
        if (!user) return respond({ error: 'Not authenticated' }, 401);

        const { data, error } = await supabase
          .from('pbc_game_progress')
          .select('*')
          .eq('user_id', user.id)
          .maybeSingle();

        if (error) return respond({ error: error.message }, 400);
        return respond({ data });
      }

      case 'savePBCProgress': {
        if (!user) return respond({ error: 'Not authenticated' }, 401);

        const {
          bananas,
          peanuts,
          bread,
          sandwiches,
          royal_coins,
          rare_resources,
          special_items,
          potions,
          equipment,
          treasury,
          knights,
          active_quests,
          active_crusades,
          squads,
          castle_positions,
          buildings,
          castle_level,
          total_quests_completed,
          total_sandwiches_made,
          total_feasts_held,
          total_special_sandwiches_crafted,
          total_potions_crafted,
          total_equipment_crafted,
          last_farm_collection,
          quest_launches,
          global_event_cooldowns,
          royal_shop,
          skip_shop_confirmations,
          quest_speed_buff_expires,
          luck_buff_expires,
          treasury_tax
        } = payload || {};

        // If treasury_tax is provided, add it to the royal treasury balance
        if (treasury_tax && treasury_tax > 0) {
          try {
            // Get current royal treasury balance - USE ADMIN CLIENT
            const { data: kingdomData } = await adminSupabase
              .from('pbc_kingdom_state')
              .select('royal_treasury_balance')
              .eq('id', 1)
              .maybeSingle();

            if (kingdomData) {
              const currentBalance = kingdomData.royal_treasury_balance || 0;
              const newBalance = currentBalance + parseInt(treasury_tax);

              // Update the balance - USE ADMIN CLIENT
              await adminSupabase
                .from('pbc_kingdom_state')
                .update({ royal_treasury_balance: newBalance })
                .eq('id', 1);
            }
          } catch (error) {
            console.error('Error processing treasury tax:', error);
          }
        }

        // Check if user already has progress
        const { data: existing } = await supabase
          .from('pbc_game_progress')
          .select('id')
          .eq('user_id', user.id)
          .maybeSingle();

        const defaultRareResources = {
          blue_hawaiian_banana: 0,
          ruby_red_banana: 0,
          golden_banana: 0,
          honey_roasted_peanuts: 0,
          chocolate_peanuts: 0,
          sourdough_bread: 0,
          cinnamon_swirl_bread: 0,
          royal_brioche: 0
        };

        const defaultSquads = [
          { id: 1, leaderId: null, memberIds: [], assignedQuest: null, status: 'idle', startTime: null, endTime: null, runsCompleted: 0, maxRuns: 6, unlocked: false },
          { id: 2, leaderId: null, memberIds: [], assignedQuest: null, status: 'idle', startTime: null, endTime: null, runsCompleted: 0, maxRuns: 6, unlocked: false }
        ];

        const defaultTreasury = {
          royal_coins: 0,
          bananas: 0,
          peanuts: 0,
          bread: 0,
          sandwiches: 0,
          rare_resources: { ...defaultRareResources },
          special_items: {},
          potions: {},
          equipment: {}
        };

        let result;
        if (existing) {
          // Update existing progress
          const { data, error } = await supabase
            .from('pbc_game_progress')
            .update({
              bananas: bananas ?? 10,
              peanuts: peanuts ?? 10,
              bread: bread ?? 10,
              sandwiches: sandwiches ?? 0,
              royal_coins: royal_coins ?? 100,
              rare_resources: rare_resources ?? defaultRareResources,
              special_items: special_items ?? {},
              potions: potions ?? {},
              equipment: equipment ?? {},
              treasury: treasury ?? defaultTreasury,
              knights: knights ?? [],
              active_quests: active_quests ?? [],
              active_crusades: active_crusades ?? [],
              squads: squads ?? defaultSquads,
              castle_positions: castle_positions ?? [],
              buildings: buildings ?? { pantry: 0, toastery: 0, crunch_hall: 0, smooth_sanctum: 0 },
              castle_level: castle_level ?? 1,
              total_quests_completed: total_quests_completed ?? 0,
              total_sandwiches_made: total_sandwiches_made ?? 0,
              total_feasts_held: total_feasts_held ?? 0,
              total_special_sandwiches_crafted: total_special_sandwiches_crafted ?? 0,
              total_potions_crafted: total_potions_crafted ?? 0,
              total_equipment_crafted: total_equipment_crafted ?? 0,
              last_farm_collection: last_farm_collection,
              quest_launches: quest_launches ?? [],
              global_event_cooldowns: global_event_cooldowns ?? {},
              royal_shop: royal_shop,
              skip_shop_confirmations: skip_shop_confirmations ?? false,
              quest_speed_buff_expires: quest_speed_buff_expires,
              luck_buff_expires: luck_buff_expires,
              updated_at: new Date().toISOString()
            })
            .eq('user_id', user.id)
            .select()
            .single();

          if (error) return respond({ error: error.message }, 400);
          result = data;
        } else {
          // Insert new progress
          const { data, error } = await supabase
            .from('pbc_game_progress')
            .insert([{
              user_id: user.id,
              bananas: bananas ?? 10,
              peanuts: peanuts ?? 10,
              bread: bread ?? 10,
              sandwiches: sandwiches ?? 0,
              royal_coins: royal_coins ?? 100,
              rare_resources: rare_resources ?? defaultRareResources,
              special_items: special_items ?? {},
              potions: potions ?? {},
              equipment: equipment ?? {},
              treasury: treasury ?? defaultTreasury,
              knights: knights ?? [],
              active_quests: active_quests ?? [],
              active_crusades: active_crusades ?? [],
              squads: squads ?? defaultSquads,
              castle_positions: castle_positions ?? [],
              buildings: buildings ?? { pantry: 0, toastery: 0, crunch_hall: 0, smooth_sanctum: 0 },
              castle_level: castle_level ?? 1,
              total_quests_completed: total_quests_completed ?? 0,
              total_sandwiches_made: total_sandwiches_made ?? 0,
              total_feasts_held: total_feasts_held ?? 0,
              total_special_sandwiches_crafted: total_special_sandwiches_crafted ?? 0,
              total_potions_crafted: total_potions_crafted ?? 0,
              total_equipment_crafted: total_equipment_crafted ?? 0,
              last_farm_collection: last_farm_collection,
              quest_launches: quest_launches ?? [],
              global_event_cooldowns: global_event_cooldowns ?? {},
              royal_shop: royal_shop,
              skip_shop_confirmations: skip_shop_confirmations ?? false,
              quest_speed_buff_expires: quest_speed_buff_expires,
              luck_buff_expires: luck_buff_expires
            }])
            .select()
            .single();

          if (error) return respond({ error: error.message }, 400);
          result = data;
        }

        return respond({ data: result });
      }

      case 'addUserTags': {
        if (!user) return respond({ error: 'Not authenticated' }, 401);

        const { tag_ids } = payload || {};

        if (!tag_ids || !Array.isArray(tag_ids) || tag_ids.length === 0) {
          return respond({ error: 'tag_ids array is required' }, 400);
        }

        const results = [];

        for (let i = 0; i < tag_ids.length; i++) {
          const tag_id = tag_ids[i];
          const display_order = i;
          const intensity = 3; // default intensity

          // Check if this user_tag already exists - USE ADMIN CLIENT to bypass RLS
          const { data: existing } = await adminSupabase
            .from('user_tags')
            .select('id')
            .eq('user_id', user.id)
            .eq('tag_id', tag_id)
            .maybeSingle();

          let result;
          if (existing) {
            // Update existing user_tag - USE ADMIN CLIENT to bypass RLS
            const { data, error } = await adminSupabase
              .from('user_tags')
              .update({
                interest_level: intensity,
                display_order: display_order
              })
              .eq('user_id', user.id)
              .eq('tag_id', tag_id)
              .select()
              .single();

            if (error) {
              console.error(`Failed to update tag ${tag_id}:`, error);
              return respond({ error: `Failed to update tag: ${error.message}` }, 400);
            }
            result = data;
          } else {
            // Insert new user_tag - USE ADMIN CLIENT to bypass RLS
            const { data, error } = await adminSupabase
              .from('user_tags')
              .insert([{
                user_id: user.id,
                tag_id: tag_id,
                display_order: display_order,
                interest_level: intensity
              }])
              .select()
              .single();

            if (error) {
              console.error(`Failed to insert tag ${tag_id}:`, error);
              return respond({ error: `Failed to insert tag: ${error.message}` }, 400);
            }
            result = data;
          }

          results.push(result);
        }

        return respond({ data: results });
      }

      case 'getUserTags': {
        if (!user) return respond({ error: 'Not authenticated' }, 401);

        const { user_id } = payload || {};
        const targetUserId = user_id || user.id;

        // Get user_tags with tag details - USE ADMIN CLIENT to bypass RLS
        const { data: userTagsData, error: userTagsError } = await adminSupabase
          .from('user_tags')
          .select('tag_id, version_locked, display_order, interest_level, experience_level, added_at')
          .eq('user_id', targetUserId)
          .order('display_order', { ascending: true });

        if (userTagsError) {
          console.error('Failed to get user_tags:', userTagsError);
          return respond({ error: userTagsError.message }, 400);
        }

        if (!userTagsData || userTagsData.length === 0) {
          return respond({ data: [] });
        }

        // Get tag details - USE ADMIN CLIENT
        const tagIds = userTagsData.map(ut => ut.tag_id);
        const { data: tagsData, error: tagsError } = await adminSupabase
          .from('tags')
          .select('*')
          .in('id', tagIds);

        if (tagsError) {
          console.error('Failed to get tags:', tagsError);
          return respond({ error: tagsError.message }, 400);
        }

        // Map tags by ID
        const tagsMap = {};
        (tagsData || []).forEach(t => {
          tagsMap[t.id] = t;
        });

        // Merge user_tags with tag details
        const mergedTags = userTagsData.map(ut => ({
          ...tagsMap[ut.tag_id],
          version_locked: ut.version_locked,
          display_order: ut.display_order,
          interest_level: ut.interest_level,
          experience_level: ut.experience_level,
          // Keep intensity as alias for backwards compatibility
          intensity: ut.interest_level,
          added_at: ut.added_at
        }));

        return respond({ data: mergedTags });
      }

      case 'getKingdomState': {
        if (!user) return respond({ error: 'Not authenticated' }, 401);

        try {
          // Get current kingdom state - USE ADMIN CLIENT to bypass RLS
          const { data: kingdomData, error: kingdomError } = await adminSupabase
            .from('pbc_kingdom_state')
            .select('*')
            .eq('id', 1)
            .maybeSingle();

          let currentState = kingdomData;

          // If no kingdom state exists, create one with defaults using UPSERT
          if (!currentState) {
            const defaultState = {
              id: 1,
              current_king_id: null,
              king_crowned_at: null,
              next_election_at: null,
              king_free_changes_remaining: 1,
              royal_treasury_balance: 0,
              active_doctrines: {
                religious: null,
                economic: null,
                military: null,
                cultural: null
              }
            };

            const { data: newState, error: upsertError } = await adminSupabase
              .from('pbc_kingdom_state')
              .upsert(defaultState, { onConflict: 'id' })
              .select()
              .maybeSingle();

            if (upsertError) throw upsertError;
            currentState = newState || defaultState;
          }

          // Check if election is due OR if there's no king at all
          // Always ensure there's a king if there are any players
          const now = new Date();
          const shouldRunElection = !currentState.current_king_id || !currentState.next_election_at || new Date(currentState.next_election_at) <= now;

          console.log('[getKingdomState] Election check:', {
            current_king_id: currentState.current_king_id,
            next_election_at: currentState.next_election_at,
            shouldRunElection
          });

          if (shouldRunElection) {
            // Get top player by royal_coins (including pocket + treasury coins)
            const { data: allPlayers, error: playersError } = await supabase
              .from('pbc_game_progress')
              .select('user_id, royal_coins, treasury');

            console.log('[getKingdomState] Players query result:', {
              playersError,
              playerCount: allPlayers?.length,
              players: allPlayers
            });

            if (playersError) {
              console.error('[getKingdomState] Error fetching players:', playersError);
            }

            if (!playersError && allPlayers && allPlayers.length > 0) {
              // Calculate total coins (pocket + treasury) for each player
              const playersWithTotalCoins = allPlayers.map(p => {
                const pocketCoins = p.royal_coins || 0;
                const treasuryCoins = p.treasury && p.treasury.royal_coins ? p.treasury.royal_coins : 0;
                return {
                  user_id: p.user_id,
                  total_coins: pocketCoins + treasuryCoins
                };
              });

              // Sort by total coins descending
              playersWithTotalCoins.sort((a, b) => b.total_coins - a.total_coins);
              const topPlayer = playersWithTotalCoins[0];

              console.log('[getKingdomState] Top player calculated:', {
                topPlayer,
                allPlayerCoins: playersWithTotalCoins
              });

              // Always crown the top player when election is due (even if already king)
              // This ensures there's always a king and election date is always set
              if (topPlayer) {
                const nextElectionDate = new Date(now.getTime() + (30 * 24 * 60 * 60 * 1000));

                console.log('[getKingdomState] Attempting to crown king:', {
                  user_id: topPlayer.user_id,
                  total_coins: topPlayer.total_coins,
                  next_election_at: nextElectionDate.toISOString()
                });

                const { data: updatedState, error: updateError } = await adminSupabase
                  .from('pbc_kingdom_state')
                  .upsert({
                    id: 1,
                    current_king_id: topPlayer.user_id,
                    king_crowned_at: now.toISOString(),
                    next_election_at: nextElectionDate.toISOString(),
                    king_free_changes_remaining: 1,
                    royal_treasury_balance: currentState.royal_treasury_balance || 0,
                    // Set balanced default doctrines for new king if none exist
                    active_doctrines: currentState.active_doctrines &&
                      (currentState.active_doctrines.religious ||
                       currentState.active_doctrines.economic ||
                       currentState.active_doctrines.military ||
                       currentState.active_doctrines.cultural)
                      ? currentState.active_doctrines
                      : {
                          religious: 'prosperity_gospel',    // +15% Royal Coin rewards
                          economic: 'free_market',           // +50% Royal Shop stock
                          military: 'knights_errant',        // +15% quest speed
                          cultural: 'warrior_culture'        // +15% raid rewards, +15% knight training
                        }
                  }, { onConflict: 'id' })
                  .select()
                  .maybeSingle();

                console.log('[getKingdomState] Crown result:', {
                  updateError,
                  updatedState
                });

                if (updateError) {
                  console.error('[getKingdomState] Error crowning king:', updateError);
                  throw updateError;
                }
                currentState = updatedState || currentState;
                console.log('[getKingdomState] King crowned successfully!', currentState);
              } else {
                console.warn('[getKingdomState] No top player found to crown');
              }
            } else {
              console.warn('[getKingdomState] No players found or query failed');
            }
          } else {
            console.log('[getKingdomState] Election not needed, current king:', currentState.current_king_id);
          }

          // Initialize default doctrines if none are set yet (regardless of when king was crowned)
          const hasAnyDoctrine = currentState.active_doctrines &&
            (currentState.active_doctrines.religious ||
             currentState.active_doctrines.economic ||
             currentState.active_doctrines.military ||
             currentState.active_doctrines.cultural);

          if (!hasAnyDoctrine) {
            console.log('[getKingdomState] No doctrines set, initializing defaults...');
            const { data: updatedWithDoctrines, error: doctrineError } = await adminSupabase
              .from('pbc_kingdom_state')
              .update({
                active_doctrines: {
                  religious: 'prosperity_gospel',    // +15% Royal Coin rewards
                  economic: 'free_market',           // +50% Royal Shop stock
                  military: 'knights_errant',        // +15% quest speed
                  cultural: 'warrior_culture'        // +15% raid rewards, +15% knight training
                }
              })
              .eq('id', 1)
              .select()
              .maybeSingle();

            if (doctrineError) {
              console.error('[getKingdomState] Error setting default doctrines:', doctrineError);
            } else {
              console.log('[getKingdomState] Default doctrines set successfully!');
              currentState = updatedWithDoctrines || currentState;
            }
          }

          // Get king's display name
          let kingDisplayName = 'No Ruler';
          if (currentState.current_king_id) {
            const { data: kingProfile } = await supabase
              .from('profiles')
              .select('display_name')
              .eq('id', currentState.current_king_id)
              .maybeSingle();

            if (kingProfile && kingProfile.display_name) {
              kingDisplayName = kingProfile.display_name;
            }
          }

          // Return kingdom state with timestamps as milliseconds
          return respond({
            data: {
              current_king_id: currentState.current_king_id,
              king_display_name: kingDisplayName,
              king_crowned_at: currentState.king_crowned_at ? new Date(currentState.king_crowned_at).getTime() : null,
              next_election_at: currentState.next_election_at ? new Date(currentState.next_election_at).getTime() : null,
              king_free_changes_remaining: currentState.king_free_changes_remaining || 0,
              royal_treasury_balance: currentState.royal_treasury_balance || 0,
              active_doctrines: currentState.active_doctrines || {
                religious: null,
                economic: null,
                military: null,
                cultural: null
              }
            }
          });
        } catch (error) {
          console.error('getKingdomState error:', error);
          return respond({ error: error.message }, 500);
        }
      }

      case 'setKingdomDoctrine': {
        if (!user) return respond({ error: 'Not authenticated' }, 401);

        const { category, doctrine } = payload;

        if (!category || !doctrine) {
          return respond({ error: 'Missing category or doctrine' }, 400);
        }

        // Validate category
        const validCategories = ['religious', 'economic', 'military', 'cultural'];
        if (!validCategories.includes(category)) {
          return respond({ error: 'Invalid category' }, 400);
        }

        try {
          // Get current kingdom state - USE ADMIN CLIENT
          const { data: kingdomData, error: kingdomError } = await adminSupabase
            .from('pbc_kingdom_state')
            .select('*')
            .eq('id', 1)
            .maybeSingle();

          if (kingdomError) throw kingdomError;

          if (!kingdomData) {
            return respond({ error: 'Kingdom state not initialized' }, 400);
          }

          // Validate user is current king
          if (kingdomData.current_king_id !== user.id) {
            return respond({ error: 'Only the current king can change doctrines' }, 403);
          }

          const DOCTRINE_CHANGE_COST = 1000;
          let newFreeChanges = kingdomData.king_free_changes_remaining || 0;
          let newTreasuryBalance = kingdomData.royal_treasury_balance || 0;

          // Check if king has free changes or enough treasury balance
          if (newFreeChanges > 0) {
            // Use free change
            newFreeChanges -= 1;
          } else {
            // Deduct from treasury
            if (newTreasuryBalance < DOCTRINE_CHANGE_COST) {
              return respond({ error: `Not enough treasury balance. Need ${DOCTRINE_CHANGE_COST} coins, have ${newTreasuryBalance}` }, 400);
            }
            newTreasuryBalance -= DOCTRINE_CHANGE_COST;
          }

          // Update doctrine
          const newDoctrines = { ...kingdomData.active_doctrines };
          newDoctrines[category] = doctrine;

          // Save updated state - USE ADMIN CLIENT
          const { data: updatedState, error: updateError } = await adminSupabase
            .from('pbc_kingdom_state')
            .update({
              active_doctrines: newDoctrines,
              king_free_changes_remaining: newFreeChanges,
              royal_treasury_balance: newTreasuryBalance
            })
            .eq('id', 1)
            .select()
            .maybeSingle();

          if (updateError) throw updateError;
          if (!updatedState) throw new Error('Failed to update kingdom state');

          return respond({
            success: true,
            data: {
              king_free_changes_remaining: updatedState.king_free_changes_remaining,
              royal_treasury_balance: updatedState.royal_treasury_balance,
              active_doctrines: updatedState.active_doctrines
            }
          });
        } catch (error) {
          console.error('setKingdomDoctrine error:', error);
          return respond({ error: error.message }, 500);
        }
      }

      case 'addTaxToKingdomTreasury': {
        if (!user) return respond({ error: 'Not authenticated' }, 401);

        const { taxAmount } = payload;

        if (!taxAmount || taxAmount <= 0) {
          return respond({ error: 'Invalid tax amount' }, 400);
        }

        try {
          // Get current kingdom state - USE ADMIN CLIENT
          const { data: kingdomData, error: kingdomError } = await adminSupabase
            .from('pbc_kingdom_state')
            .select('royal_treasury_balance')
            .eq('id', 1)
            .maybeSingle();

          if (kingdomError) throw kingdomError;

          if (!kingdomData) {
            return respond({ error: 'Kingdom state not initialized' }, 400);
          }

          const newBalance = (kingdomData.royal_treasury_balance || 0) + taxAmount;

          // Update treasury balance - USE ADMIN CLIENT
          const { data: updatedState, error: updateError } = await adminSupabase
            .from('pbc_kingdom_state')
            .update({
              royal_treasury_balance: newBalance
            })
            .eq('id', 1)
            .select()
            .maybeSingle();

          if (updateError) throw updateError;
          if (!updatedState) throw new Error('Failed to update kingdom treasury');

          return respond({
            success: true,
            data: {
              royal_treasury_balance: updatedState.royal_treasury_balance
            }
          });
        } catch (error) {
          console.error('addTaxToKingdomTreasury error:', error);
          return respond({ error: error.message }, 500);
        }
      }

      case 'admin_setKingdomTreasuryBalance': {
        if (!user) return respond({ error: 'Not authenticated' }, 401);

        // Check if user is admin
        const { data: profile } = await supabase
          .from('profiles')
          .select('is_admin')
          .eq('id', user.id)
          .single();

        if (!profile?.is_admin) {
          return respond({ error: 'Admin access required' }, 403);
        }

        const { newBalance } = payload;

        if (typeof newBalance !== 'number' || newBalance < 0) {
          return respond({ error: 'Invalid balance amount' }, 400);
        }

        try {
          // Update treasury balance - USE ADMIN CLIENT
          const { data: updatedState, error: updateError } = await adminSupabase
            .from('pbc_kingdom_state')
            .update({
              royal_treasury_balance: newBalance
            })
            .eq('id', 1)
            .select()
            .maybeSingle();

          if (updateError) throw updateError;
          if (!updatedState) throw new Error('Failed to update kingdom treasury');

          return respond({
            success: true,
            data: {
              royal_treasury_balance: updatedState.royal_treasury_balance
            }
          });
        } catch (error) {
          console.error('admin_setKingdomTreasuryBalance error:', error);
          return respond({ error: error.message }, 500);
        }
      }

      // ========== RELIGION SYSTEM ==========

      case 'getReligionState': {
        if (!user) return respond({ error: 'Not authenticated' }, 401);

        try {
          // Get current religion state - USE ADMIN CLIENT
          const { data: religionState, error: religionError } = await adminSupabase
            .from('pbc_religion_state')
            .select('*')
            .eq('id', 1)
            .maybeSingle();

          if (religionError) throw religionError;

          // Get player's current vote
          const { data: playerVote, error: voteError } = await supabase
            .from('pbc_religion_votes')
            .select('*')
            .eq('user_id', user.id)
            .maybeSingle();

          if (voteError && voteError.code !== 'PGRST116') {
            console.error('Error fetching player vote:', voteError);
          }

          // Return religion state with player's vote info
          return respond({
            data: {
              active_religion: religionState?.active_religion || 'crusader_faith',
              last_tally_date: religionState?.last_tally_date ? new Date(religionState.last_tally_date).getTime() : null,
              next_tally_date: religionState?.next_tally_date ? new Date(religionState.next_tally_date).getTime() : null,
              total_voters: religionState?.total_voters || 0,
              vote_counts: religionState?.vote_counts || {},
              player_vote: playerVote?.religion_choice || null,
              player_vote_cooldown: playerVote?.vote_cooldown_expires ? new Date(playerVote.vote_cooldown_expires).getTime() : 0
            }
          });
        } catch (error) {
          console.error('getReligionState error:', error);
          return respond({ error: error.message }, 500);
        }
      }

      case 'voteForReligion': {
        if (!user) return respond({ error: 'Not authenticated' }, 401);

        const { religion } = payload;

        // Validate religion choice
        const validReligions = ['crusader_faith', 'druidic_path', 'norse_paganism', 'monastic_order', 'chivalric_code'];
        if (!religion || !validReligions.includes(religion)) {
          return respond({ error: 'Invalid religion choice' }, 400);
        }

        try {
          // Check if player has an existing vote
          const { data: existingVote, error: voteError } = await supabase
            .from('pbc_religion_votes')
            .select('*')
            .eq('user_id', user.id)
            .maybeSingle();

          if (voteError && voteError.code !== 'PGRST116') throw voteError;

          const now = new Date();

          // If player has existing vote, check cooldown
          if (existingVote) {
            const cooldownExpires = new Date(existingVote.vote_cooldown_expires);
            if (now < cooldownExpires) {
              const remainingMs = cooldownExpires.getTime() - now.getTime();
              const remainingHours = Math.ceil(remainingMs / (1000 * 60 * 60));
              return respond({
                error: `You can change your religion vote in ${remainingHours} hour(s)`,
                cooldown_remaining_ms: remainingMs
              }, 400);
            }

            // Update existing vote
            const { data: updatedVote, error: updateError } = await supabase
              .from('pbc_religion_votes')
              .update({
                religion_choice: religion,
                voted_at: now.toISOString(),
                vote_cooldown_expires: new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString() // 24 hours from now
              })
              .eq('user_id', user.id)
              .select()
              .single();

            if (updateError) throw updateError;

            return respond({
              success: true,
              message: 'Religion vote updated successfully',
              data: {
                religion_choice: updatedVote.religion_choice,
                voted_at: new Date(updatedVote.voted_at).getTime(),
                vote_cooldown_expires: new Date(updatedVote.vote_cooldown_expires).getTime()
              }
            });
          } else {
            // Insert new vote
            const { data: newVote, error: insertError } = await supabase
              .from('pbc_religion_votes')
              .insert({
                user_id: user.id,
                religion_choice: religion,
                voted_at: now.toISOString(),
                vote_cooldown_expires: new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString()
              })
              .select()
              .single();

            if (insertError) throw insertError;

            return respond({
              success: true,
              message: 'Religion vote cast successfully',
              data: {
                religion_choice: newVote.religion_choice,
                voted_at: new Date(newVote.voted_at).getTime(),
                vote_cooldown_expires: new Date(newVote.vote_cooldown_expires).getTime()
              }
            });
          }
        } catch (error) {
          console.error('voteForReligion error:', error);
          return respond({ error: error.message }, 500);
        }
      }

      case 'checkAndUpdateReligionTally': {
        if (!user) return respond({ error: 'Not authenticated' }, 401);

        try {
          // Get current religion state - USE ADMIN CLIENT
          const { data: religionState, error: religionError } = await adminSupabase
            .from('pbc_religion_state')
            .select('*')
            .eq('id', 1)
            .maybeSingle();

          if (religionError) throw religionError;

          if (!religionState) {
            return respond({ error: 'Religion state not initialized' }, 500);
          }

          const now = new Date();
          const nextTallyDate = new Date(religionState.next_tally_date);

          // Check if it's time for a new tally
          if (now >= nextTallyDate) {
            // Run the tally update function - USE ADMIN CLIENT
            const { error: tallyError } = await adminSupabase.rpc('update_religion_tally');

            if (tallyError) {
              console.error('Error running religion tally:', tallyError);
              throw tallyError;
            }

            // Fetch updated state
            const { data: updatedState, error: fetchError } = await adminSupabase
              .from('pbc_religion_state')
              .select('*')
              .eq('id', 1)
              .single();

            if (fetchError) throw fetchError;

            return respond({
              success: true,
              tally_updated: true,
              message: 'Religion tally has been updated',
              data: {
                active_religion: updatedState.active_religion,
                last_tally_date: new Date(updatedState.last_tally_date).getTime(),
                next_tally_date: new Date(updatedState.next_tally_date).getTime(),
                total_voters: updatedState.total_voters,
                vote_counts: updatedState.vote_counts
              }
            });
          } else {
            return respond({
              success: true,
              tally_updated: false,
              message: 'Next tally not yet due',
              data: {
                active_religion: religionState.active_religion,
                next_tally_date: nextTallyDate.getTime()
              }
            });
          }
        } catch (error) {
          console.error('checkAndUpdateReligionTally error:', error);
          return respond({ error: error.message }, 500);
        }
      }

      // ========== END RELIGION SYSTEM ==========

      case 'getPBCLeaderboard': {
        if (!user) return respond({ error: 'Not authenticated' }, 401);

        const { category, page, page_size } = payload;
        const limit = Math.min(page_size || 20, 100);
        const offset = ((page || 1) - 1) * limit;

        // Map category to database field and determine if we need to count array length
        let orderField;
        let selectFields = 'user_id, castle_level, royal_coins, knights, total_quests_completed, treasury';

        switch (category) {
          case 'castle':
            orderField = 'castle_level';
            break;
          case 'coins':
            orderField = 'royal_coins';
            break;
          case 'knights':
            // For knights, we'll need to calculate array length in memory
            orderField = 'knights';
            break;
          case 'quests':
            orderField = 'total_quests_completed';
            break;
          default:
            orderField = 'castle_level';
        }

        // Get user profiles for display names
        const { data: progressData, error: progressError } = await supabase
          .from('pbc_game_progress')
          .select(selectFields);

        if (progressError) return respond({ error: progressError.message }, 400);

        // Get user profiles
        const userIds = progressData.map(p => p.user_id);
        const { data: profiles } = await supabase
          .from('profiles')
          .select('id, display_name, flagged, banned')
          .in('id', userIds);

        // Create a map of user_id to profile info
        const profileMap = {};
        if (profiles) {
          profiles.forEach(p => {
            profileMap[p.id] = {
              display_name: p.display_name,
              flagged: p.flagged || false,
              banned: p.banned || false
            };
          });
        }

        // Enrich progress data with display names and calculate values
        let enrichedData = progressData
          .filter(p => {
            // Exclude flagged or banned users from leaderboards
            const profile = profileMap[p.user_id];
            return profile && !profile.flagged && !profile.banned;
          })
          .map(p => {
            let value;
            switch (category) {
              case 'castle':
                value = p.castle_level || 1;
                break;
              case 'coins':
                // Include treasury coins in total
                const pocketCoins = p.royal_coins || 0;
                const treasuryCoins = p.treasury && p.treasury.royal_coins ? p.treasury.royal_coins : 0;
                value = pocketCoins + treasuryCoins;
                break;
              case 'knights':
                value = Array.isArray(p.knights) ? p.knights.length : 0;
                break;
              case 'quests':
                value = p.total_quests_completed || 0;
                break;
              default:
                value = p.castle_level || 1;
            }

            // Generate fallback display name if profile doesn't have one
            const profile = profileMap[p.user_id];
            const displayName = profile?.display_name || `Anonymous-${p.user_id.substring(0, 8)}`;

            return {
              user_id: p.user_id,
              display_name: displayName,
              castle_level: p.castle_level || 1,
              value: value
            };
          });

        // Sort by value descending
        enrichedData.sort((a, b) => b.value - a.value);

        // Add rank
        enrichedData = enrichedData.map((item, index) => ({
          ...item,
          rank: index + 1
        }));

        // Get total count
        const totalCount = enrichedData.length;

        // Find current user's rank (return full object, not just rank number)
        const yourRank = enrichedData.find(item => item.user_id === user.id) || null;

        // Paginate
        const paginatedData = enrichedData.slice(offset, offset + limit);

        return respond({
          data: {
            rankings: paginatedData,
            total_count: totalCount,
            your_rank: yourRank
          }
        });
      }

      case 'getMarketplace': {
        if (!user) return respond({ error: 'Not authenticated' }, 401);

        const { data, error } = await supabase
          .from('pbc_marketplace')
          .select('*')
          .eq('status', 'active')
          .gt('quantity_remaining', 0)
          .order('created_at', { ascending: false })
          .limit(100);

        if (error) return respond({ error: error.message }, 400);

        // Get seller profiles to check flagged/banned status
        const sellerIds = [...new Set(data.map(l => l.seller_id))];
        const { data: profiles } = await supabase
          .from('profiles')
          .select('id, flagged, banned')
          .in('id', sellerIds);

        // Create profile map for quick lookup
        const profileMap = {};
        if (profiles) {
          profiles.forEach(p => {
            profileMap[p.id] = {
              flagged: p.flagged || false,
              banned: p.banned || false
            };
          });
        }

        // Filter out listings from flagged/banned users and add is_own_listing flag
        const enrichedData = data
          .filter(listing => {
            const profile = profileMap[listing.seller_id];
            return profile && !profile.flagged && !profile.banned;
          })
          .map(listing => ({
            ...listing,
            is_own_listing: listing.seller_id === user.id
          }));

        return respond({ data: enrichedData });
      }

      case 'getMyListings': {
        if (!user) return respond({ error: 'Not authenticated' }, 401);

        const { data, error } = await supabase
          .from('pbc_marketplace')
          .select('*')
          .eq('seller_id', user.id)
          .in('status', ['active', 'sold_out'])
          .order('created_at', { ascending: false });

        if (error) return respond({ error: error.message }, 400);
        return respond({ data });
      }

      case 'createListing': {
        if (!user) return respond({ error: 'Not authenticated' }, 401);

        const { resource_type, resource_name, quantity, price_coins } = payload || {};

        if (!resource_type || !resource_name || !quantity || !price_coins) {
          return respond({ error: 'Missing required fields' }, 400);
        }

        // Get user's display name
        const { data: profile } = await supabase
          .from('profiles')
          .select('display_name')
          .eq('id', user.id)
          .single();

        const seller_name = profile?.display_name || user.email || 'Anonymous';

        // Get user's current resources to verify they have enough
        const { data: progress } = await supabase
          .from('pbc_game_progress')
          .select('*')
          .eq('user_id', user.id)
          .single();

        if (!progress) {
          return respond({ error: 'No game progress found' }, 400);
        }

        // Verify user has the resources
        let hasResources = false;
        if (resource_type === 'basic') {
          const basicResources = { bananas: progress.bananas, peanuts: progress.peanuts, bread: progress.bread, sandwiches: progress.sandwiches };
          hasResources = basicResources[resource_name] >= quantity;
        } else if (resource_type === 'rare') {
          hasResources = (progress.rare_resources?.[resource_name] || 0) >= quantity;
        }

        if (!hasResources) {
          return respond({ error: 'Insufficient resources' }, 400);
        }

        // Deduct resources
        let updateData = {};
        if (resource_type === 'basic') {
          updateData[resource_name] = progress[resource_name] - quantity;
        } else if (resource_type === 'rare') {
          const newRareResources = { ...progress.rare_resources };
          newRareResources[resource_name] = (newRareResources[resource_name] || 0) - quantity;
          updateData.rare_resources = newRareResources;
        }

        await supabase
          .from('pbc_game_progress')
          .update(updateData)
          .eq('user_id', user.id);

        // Create listing
        const { data, error } = await supabase
          .from('pbc_marketplace')
          .insert([{
            seller_id: user.id,
            seller_name,
            resource_type,
            resource_name,
            quantity,
            quantity_remaining: quantity,
            price_coins
          }])
          .select()
          .single();

        if (error) return respond({ error: error.message }, 400);
        return respond({ data });
      }

      case 'purchaseListing': {
        if (!user) return respond({ error: 'Not authenticated' }, 401);

        const { listing_id, purchase_quantity } = payload || {};
        if (!listing_id) return respond({ error: 'Missing listing_id' }, 400);

        const quantityToPurchase = purchase_quantity || 1;

        // Get the listing
        const { data: listing, error: listingError } = await supabase
          .from('pbc_marketplace')
          .select('*')
          .eq('id', listing_id)
          .eq('status', 'active')
          .single();

        if (listingError || !listing) {
          return respond({ error: 'Listing not found or no longer available' }, 400);
        }

        // Check if enough quantity remaining
        if (listing.quantity_remaining < quantityToPurchase) {
          return respond({ error: `Only ${listing.quantity_remaining} items remaining` }, 400);
        }

        // Can't buy your own listing
        if (listing.seller_id === user.id) {
          return respond({ error: 'Cannot purchase your own listing' }, 400);
        }

        // Calculate total cost
        const totalCost = listing.price_coins * quantityToPurchase;

        // Get buyer's progress
        const { data: buyerProgress } = await supabase
          .from('pbc_game_progress')
          .select('*')
          .eq('user_id', user.id)
          .single();

        if (!buyerProgress) {
          return respond({ error: 'No game progress found' }, 400);
        }

        // Check if buyer has enough coins
        if (buyerProgress.royal_coins < totalCost) {
          return respond({ error: `Insufficient coins. Need ${totalCost}, have ${buyerProgress.royal_coins}` }, 400);
        }

        // Get buyer's display name
        const { data: buyerProfile } = await supabase
          .from('profiles')
          .select('display_name')
          .eq('id', user.id)
          .single();

        const buyer_name = buyerProfile?.display_name || user.email || 'Anonymous';

        // Get seller's progress
        const { data: sellerProgress } = await supabase
          .from('pbc_game_progress')
          .select('*')
          .eq('user_id', listing.seller_id)
          .single();

        // Update buyer: deduct coins, add resources
        let buyerUpdate = {
          royal_coins: buyerProgress.royal_coins - totalCost
        };

        if (listing.resource_type === 'basic') {
          buyerUpdate[listing.resource_name] = (buyerProgress[listing.resource_name] || 0) + quantityToPurchase;
        } else if (listing.resource_type === 'rare') {
          const newRareResources = { ...buyerProgress.rare_resources };
          newRareResources[listing.resource_name] = (newRareResources[listing.resource_name] || 0) + quantityToPurchase;
          buyerUpdate.rare_resources = newRareResources;
        }

        await supabase
          .from('pbc_game_progress')
          .update(buyerUpdate)
          .eq('user_id', user.id);

        // Update seller: add coins
        if (sellerProgress) {
          await supabase
            .from('pbc_game_progress')
            .update({ royal_coins: sellerProgress.royal_coins + totalCost })
            .eq('user_id', listing.seller_id);
        }

        // Update listing: decrease quantity_remaining
        const newQuantityRemaining = listing.quantity_remaining - quantityToPurchase;
        const newStatus = newQuantityRemaining <= 0 ? 'sold_out' : 'active';

        const { error: updateError } = await supabase
          .from('pbc_marketplace')
          .update({
            quantity_remaining: newQuantityRemaining,
            status: newStatus,
            updated_at: new Date().toISOString()
          })
          .eq('id', listing_id);

        if (updateError) {
          console.error('Error updating marketplace listing:', updateError);
          return respond({ error: `Failed to update listing: ${updateError.message}` }, 400);
        }

        // Record transaction
        const { error: transactionError } = await supabase
          .from('pbc_transactions')
          .insert([{
            buyer_id: user.id,
            seller_id: listing.seller_id,
            buyer_name,
            seller_name: listing.seller_name,
            resource_type: listing.resource_type,
            resource_name: listing.resource_name,
            quantity: quantityToPurchase,
            price_coins: totalCost
          }]);

        if (transactionError) {
          console.error('Error recording transaction:', transactionError);
          // Don't fail the purchase if transaction recording fails
        }

        return respond({ data: { success: true, quantity_purchased: quantityToPurchase, quantity_remaining: newQuantityRemaining } });
      }

      case 'cancelListing': {
        if (!user) return respond({ error: 'Not authenticated' }, 401);

        const { listing_id } = payload || {};
        if (!listing_id) return respond({ error: 'Missing listing_id' }, 400);

        // Get the listing (allow cancelling active or sold_out listings)
        const { data: listing } = await supabase
          .from('pbc_marketplace')
          .select('*')
          .eq('id', listing_id)
          .eq('seller_id', user.id)
          .in('status', ['active', 'sold_out'])
          .single();

        if (!listing) {
          return respond({ error: 'Listing not found or already cancelled' }, 400);
        }

        // Return remaining resources to user
        const { data: progress } = await supabase
          .from('pbc_game_progress')
          .select('*')
          .eq('user_id', user.id)
          .single();

        if (progress && listing.quantity_remaining > 0) {
          let updateData = {};
          if (listing.resource_type === 'basic') {
            updateData[listing.resource_name] = (progress[listing.resource_name] || 0) + listing.quantity_remaining;
          } else if (listing.resource_type === 'rare') {
            const newRareResources = { ...progress.rare_resources };
            newRareResources[listing.resource_name] = (newRareResources[listing.resource_name] || 0) + listing.quantity_remaining;
            updateData.rare_resources = newRareResources;
          }

          await supabase
            .from('pbc_game_progress')
            .update(updateData)
            .eq('user_id', user.id);
        }

        // Mark as cancelled
        await supabase
          .from('pbc_marketplace')
          .update({ status: 'cancelled', updated_at: new Date().toISOString() })
          .eq('id', listing_id);

        return respond({ data: { success: true, quantity_returned: listing.quantity_remaining } });
      }

      case 'restockListing': {
        if (!user) return respond({ error: 'Not authenticated' }, 401);

        const { listing_id, restock_quantity } = payload || {};
        if (!listing_id || !restock_quantity || restock_quantity <= 0) {
          return respond({ error: 'Missing listing_id or invalid restock_quantity' }, 400);
        }

        // Get the listing (must be owned by user)
        const { data: listing } = await supabase
          .from('pbc_marketplace')
          .select('*')
          .eq('id', listing_id)
          .eq('seller_id', user.id)
          .in('status', ['active', 'sold_out'])
          .single();

        if (!listing) {
          return respond({ error: 'Listing not found or already cancelled' }, 400);
        }

        // Get user's resources
        const { data: progress } = await supabase
          .from('pbc_game_progress')
          .select('*')
          .eq('user_id', user.id)
          .single();

        if (!progress) {
          return respond({ error: 'No game progress found' }, 400);
        }

        // Verify user has the resources to restock
        let hasResources = false;
        if (listing.resource_type === 'basic') {
          const basicResources = { bananas: progress.bananas, peanuts: progress.peanuts, bread: progress.bread, sandwiches: progress.sandwiches };
          hasResources = basicResources[listing.resource_name] >= restock_quantity;
        } else if (listing.resource_type === 'rare') {
          hasResources = (progress.rare_resources?.[listing.resource_name] || 0) >= restock_quantity;
        }

        if (!hasResources) {
          return respond({ error: 'Insufficient resources to restock' }, 400);
        }

        // Deduct resources from user
        let updateData = {};
        if (listing.resource_type === 'basic') {
          updateData[listing.resource_name] = progress[listing.resource_name] - restock_quantity;
        } else if (listing.resource_type === 'rare') {
          const newRareResources = { ...progress.rare_resources };
          newRareResources[listing.resource_name] = (newRareResources[listing.resource_name] || 0) - restock_quantity;
          updateData.rare_resources = newRareResources;
        }

        await supabase
          .from('pbc_game_progress')
          .update(updateData)
          .eq('user_id', user.id);

        // Update listing: add to quantity_remaining and set to active
        const newQuantityRemaining = listing.quantity_remaining + restock_quantity;
        const newTotalQuantity = listing.quantity + restock_quantity;

        await supabase
          .from('pbc_marketplace')
          .update({
            quantity: newTotalQuantity,
            quantity_remaining: newQuantityRemaining,
            status: 'active',
            updated_at: new Date().toISOString()
          })
          .eq('id', listing_id);

        return respond({ data: { success: true, new_quantity_remaining: newQuantityRemaining } });
      }

      case 'getTransactionHistory': {
        if (!user) return respond({ error: 'Not authenticated' }, 401);

        const { data, error} = await supabase
          .from('pbc_transactions')
          .select('*')
          .or(`buyer_id.eq.${user.id},seller_id.eq.${user.id}`)
          .order('created_at', { ascending: false })
          .limit(50);

        if (error) return respond({ error: error.message }, 400);
        return respond({ data });
      }

      case 'getRecipes': {
        if (!user) return respond({ error: 'Not authenticated' }, 401);

        const { data, error } = await supabase
          .from('pbc_recipes')
          .select('*')
          .order('name');

        if (error) return respond({ error: error.message }, 400);
        return respond({ data });
      }

      case 'craftRecipe': {
        if (!user) return respond({ error: 'Not authenticated' }, 401);

        const { recipe_id } = payload || {};
        if (!recipe_id) return respond({ error: 'Missing recipe_id' }, 400);

        // Get the recipe
        const { data: recipe, error: recipeError } = await supabase
          .from('pbc_recipes')
          .select('*')
          .eq('id', recipe_id)
          .single();

        if (recipeError || !recipe) {
          return respond({ error: 'Recipe not found' }, 400);
        }

        // Get player progress
        const { data: progress } = await supabase
          .from('pbc_game_progress')
          .select('*')
          .eq('user_id', user.id)
          .single();

        if (!progress) {
          return respond({ error: 'No game progress found' }, 400);
        }

        // Check if player has required basic resources
        const requiredBasic = recipe.required_basic || {};
        for (const [resource, amount] of Object.entries(requiredBasic)) {
          if ((progress[resource] || 0) < amount) {
            return respond({ error: `Insufficient ${resource}. Need ${amount}, have ${progress[resource] || 0}` }, 400);
          }
        }

        // Check if player has required rare resources
        const requiredRare = recipe.required_rare || {};
        for (const [resource, amount] of Object.entries(requiredRare)) {
          if ((progress.rare_resources?.[resource] || 0) < amount) {
            return respond({ error: `Insufficient ${resource}. Need ${amount}, have ${progress.rare_resources?.[resource] || 0}` }, 400);
          }
        }

        // Check if player has required coins
        if (recipe.required_coins > 0 && progress.royal_coins < recipe.required_coins) {
          return respond({ error: `Insufficient coins. Need ${recipe.required_coins}, have ${progress.royal_coins}` }, 400);
        }

        // Deduct resources
        let updateData = {
          royal_coins: progress.royal_coins - (recipe.required_coins || 0)
        };

        // Deduct basic resources
        for (const [resource, amount] of Object.entries(requiredBasic)) {
          updateData[resource] = progress[resource] - amount;
        }

        // Deduct rare resources
        if (Object.keys(requiredRare).length > 0) {
          const newRareResources = { ...progress.rare_resources };
          for (const [resource, amount] of Object.entries(requiredRare)) {
            newRareResources[resource] = (newRareResources[resource] || 0) - amount;
          }
          updateData.rare_resources = newRareResources;
        }

        // Add output
        if (recipe.output_type === 'basic') {
          updateData[recipe.output_item] = (progress[recipe.output_item] || 0) + recipe.output_quantity;
        } else if (recipe.output_type === 'special') {
          const newSpecialItems = { ...(progress.special_items || {}) };
          newSpecialItems[recipe.output_item] = (newSpecialItems[recipe.output_item] || 0) + recipe.output_quantity;
          updateData.special_items = newSpecialItems;
        }

        // Update player progress
        const { error: updateError } = await supabase
          .from('pbc_game_progress')
          .update(updateData)
          .eq('user_id', user.id);

        if (updateError) {
          return respond({ error: `Failed to craft: ${updateError.message}` }, 400);
        }

        return respond({ data: { success: true, crafted: recipe.name, output_item: recipe.output_item, output_quantity: recipe.output_quantity } });
      }

      case 'getRaidTargets': {
        if (!user) return respond({ error: 'Not authenticated' }, 401);

        // Get list of players with their defense info
        const { data: targets, error } = await supabase
          .from('pbc_game_progress')
          .select('user_id, bananas, peanuts, bread, sandwiches, royal_coins, knights, castle_level')
          .neq('user_id', user.id)
          .limit(50);

        if (error) return respond({ error: error.message }, 400);

        // Get profiles for display names
        const userIds = targets.map(t => t.user_id);
        const { data: profiles } = await supabase
          .from('profiles')
          .select('id, display_name, flagged, banned')
          .in('id', userIds);

        // Get raid stats
        const { data: raidStats } = await supabase
          .from('pbc_raid_stats')
          .select('*')
          .in('user_id', userIds);

        // CRITICAL: Define MAX_RAID_PARTY here for consistency
        const MAX_RAID_PARTY = 15;

        // Helper function to calculate knight power
        const calculateKnightPower = (knight) => {
          const basePower = (knight.valor || 0) + (knight.wit || 0);
          const tier = knight.tier || 1;
          const multipliers = { 1: 1, 2: 3, 3: 5, 4: 10 };
          return basePower * (multipliers[tier] || 1);
        };

        // Combine data and filter out flagged/banned users
        const enrichedTargets = targets
          .filter(target => {
            // Exclude flagged or banned users from raid targets
            const profile = profiles?.find(p => p.id === target.user_id);
            return profile && !profile.flagged && !profile.banned;
          })
          .map(target => {
            const profile = profiles?.find(p => p.id === target.user_id);
            const stats = raidStats?.find(s => s.user_id === target.user_id);

            // Calculate defense power based on knights with tier multipliers
            // CRITICAL: Apply same MAX_RAID_PARTY limit to defenders
            const allKnights = Array.isArray(target.knights) ? target.knights : [];
            // Sort by power (descending) and take top MAX_RAID_PARTY knights
            const topKnights = allKnights
              .map(k => ({
                knight: k,
                power: calculateKnightPower(k)
              }))
              .sort((a, b) => b.power - a.power)
              .slice(0, MAX_RAID_PARTY)
              .map(item => item.knight);

            const defensePower = topKnights.reduce((sum, k) => {
              const basePower = (k.valor || 0) + (k.wit || 0);
              const tier = k.tier || 1;
              const multipliers = { 1: 1, 2: 3, 3: 5, 4: 10 };
              return sum + (basePower * (multipliers[tier] || 1));
            }, 0);

            return {
              user_id: target.user_id,
              name: profile?.display_name || 'Anonymous',
              defense_rating: stats?.defense_rating || 100,
              defense_power: defensePower,
              total_resources: target.bananas + target.peanuts + target.bread + target.sandwiches,
              royal_coins: target.royal_coins,
              last_raided: stats?.last_raided_at,
              knight_count: topKnights.length,
              castle_level: target.castle_level || 1
            };
          });

        return respond({ data: enrichedTargets });
      }

      case 'launchRaid': {
        if (!user) return respond({ error: 'Not authenticated' }, 401);

        const { defender_id, knight_ids } = payload || {};

        if (!defender_id || !knight_ids || !Array.isArray(knight_ids) || knight_ids.length === 0) {
          return respond({ error: 'Missing defender_id or knight_ids' }, 400);
        }

        // Get attacker stats and check cooldown
        let { data: attackerStats } = await supabase
          .from('pbc_raid_stats')
          .select('*')
          .eq('user_id', user.id)
          .maybeSingle();

        // Create stats if don't exist
        if (!attackerStats) {
          const { data: newStats } = await supabase
            .from('pbc_raid_stats')
            .insert([{ user_id: user.id }])
            .select()
            .single();
          attackerStats = newStats;
        }

        // Check attack cooldown (6 hours)
        if (attackerStats.last_attack_at) {
          const cooldownMs = 6 * 60 * 60 * 1000; // 6 hours
          const timeSinceLastAttack = Date.now() - new Date(attackerStats.last_attack_at).getTime();
          if (timeSinceLastAttack < cooldownMs) {
            const minutesLeft = Math.ceil((cooldownMs - timeSinceLastAttack) / 60000);
            return respond({ error: `Attack cooldown active. ${minutesLeft} minutes remaining.` }, 400);
          }
        }

        // Get attacker progress
        const { data: attackerProgress } = await supabase
          .from('pbc_game_progress')
          .select('*')
          .eq('user_id', user.id)
          .single();

        if (!attackerProgress) {
          return respond({ error: 'No game progress found' }, 400);
        }

        // Get attacker name
        const { data: attackerProfile } = await supabase
          .from('profiles')
          .select('display_name')
          .eq('id', user.id)
          .single();
        const attacker_name = attackerProfile?.display_name || 'Anonymous';

        // Verify selected knights exist and belong to attacker
        const attackerKnights = Array.isArray(attackerProgress.knights) ? attackerProgress.knights : [];
        const selectedKnights = knight_ids.map(id => attackerKnights.find(k => k.id === id)).filter(Boolean);

        if (selectedKnights.length !== knight_ids.length) {
          return respond({ error: 'Invalid knight selection' }, 400);
        }

        // Validate raid party size (max 15 knights)
        const MAX_RAID_PARTY = 15;
        if (selectedKnights.length > MAX_RAID_PARTY) {
          return respond({ error: `Maximum raid party size is ${MAX_RAID_PARTY} knights` }, 400);
        }

        // Calculate attack power with tier multipliers
        const calculateKnightPower = (knight) => {
          const basePower = (knight.valor || 0) + (knight.stickiness || 0);
          const tier = knight.tier || 1;
          const multipliers = { 1: 1, 2: 3, 3: 5, 4: 10 };
          return basePower * (multipliers[tier] || 1);
        };

        const attackPower = selectedKnights.reduce((sum, k) =>
          sum + calculateKnightPower(k), 0
        );

        // Get defender stats and check immunity
        let { data: defenderStats } = await supabase
          .from('pbc_raid_stats')
          .select('*')
          .eq('user_id', defender_id)
          .maybeSingle();

        if (!defenderStats) {
          const { data: newStats } = await supabase
            .from('pbc_raid_stats')
            .insert([{ user_id: defender_id }])
            .select()
            .single();
          defenderStats = newStats;
        }

        // Check defender immunity (1 hour after being raided)
        if (defenderStats.last_raided_at) {
          const immunityMs = 60 * 60 * 1000; // 1 hour
          const timeSinceLastRaid = Date.now() - new Date(defenderStats.last_raided_at).getTime();
          if (timeSinceLastRaid < immunityMs) {
            const minutesLeft = Math.ceil((immunityMs - timeSinceLastRaid) / 60000);
            return respond({ error: `Target has raid immunity for ${minutesLeft} more minutes.` }, 400);
          }
        }

        // Get defender progress
        const { data: defenderProgress } = await supabase
          .from('pbc_game_progress')
          .select('*')
          .eq('user_id', defender_id)
          .single();

        if (!defenderProgress) {
          return respond({ error: 'Defender not found' }, 400);
        }

        // Validate castle level restriction (±1 level only)
        const attackerCastleLevel = attackerProgress.castle_level || 1;
        const defenderCastleLevel = defenderProgress.castle_level || 1;
        const levelDifference = Math.abs(attackerCastleLevel - defenderCastleLevel);

        if (levelDifference > 1) {
          return respond({
            error: `You can only raid castles within ±1 level of yours. Your castle: Level ${attackerCastleLevel}, Target: Level ${defenderCastleLevel}`
          }, 400);
        }

        // Get defender name
        const { data: defenderProfile } = await supabase
          .from('profiles')
          .select('display_name')
          .eq('id', defender_id)
          .single();
        const defender_name = defenderProfile?.display_name || 'Anonymous';

        // Calculate defense power with tier multipliers
        // CRITICAL: Apply same MAX_RAID_PARTY limit to defenders as attackers
        const allDefenderKnights = Array.isArray(defenderProgress.knights) ? defenderProgress.knights : [];
        // Sort by power (descending) and take top MAX_RAID_PARTY knights
        const sortedDefenderKnights = allDefenderKnights
          .map(k => ({
            knight: k,
            power: calculateKnightPower(k)
          }))
          .sort((a, b) => b.power - a.power)
          .slice(0, MAX_RAID_PARTY)
          .map(item => item.knight);

        const defenderKnights = sortedDefenderKnights;
        const defensePower = defenderKnights.reduce((sum, k) => {
          const basePower = (k.valor || 0) + (k.wit || 0);
          const tier = k.tier || 1;
          const multipliers = { 1: 1, 2: 3, 3: 5, 4: 10 };
          return sum + (basePower * (multipliers[tier] || 1));
        }, 0);

        // Determine success with small randomness (±5% instead of ±20%)
        const attackRoll = attackPower * (0.95 + Math.random() * 0.10); // 95-105% of attack power
        const defenseRoll = defensePower * (0.95 + Math.random() * 0.10); // 95-105% of defense power
        const success = attackRoll > defenseRoll;

        let resourcesStolen = {};
        let coinsStolen = 0;

        if (success) {
          // Calculate stolen resources (5-15% of defender's resources)
          const stealPercentage = 0.05 + Math.random() * 0.10; // 5-15%

          const stolenBananas = Math.floor(defenderProgress.bananas * stealPercentage);
          const stolenPeanuts = Math.floor(defenderProgress.peanuts * stealPercentage);
          const stolenBread = Math.floor(defenderProgress.bread * stealPercentage);
          const stolenSandwiches = Math.floor(defenderProgress.sandwiches * stealPercentage);
          coinsStolen = Math.floor(defenderProgress.royal_coins * stealPercentage);

          resourcesStolen = {
            bananas: stolenBananas,
            peanuts: stolenPeanuts,
            bread: stolenBread,
            sandwiches: stolenSandwiches
          };

          // Update attacker resources
          await supabase
            .from('pbc_game_progress')
            .update({
              bananas: attackerProgress.bananas + stolenBananas,
              peanuts: attackerProgress.peanuts + stolenPeanuts,
              bread: attackerProgress.bread + stolenBread,
              sandwiches: attackerProgress.sandwiches + stolenSandwiches,
              royal_coins: attackerProgress.royal_coins + coinsStolen
            })
            .eq('user_id', user.id);

          // Update defender resources
          await supabase
            .from('pbc_game_progress')
            .update({
              bananas: defenderProgress.bananas - stolenBananas,
              peanuts: defenderProgress.peanuts - stolenPeanuts,
              bread: defenderProgress.bread - stolenBread,
              sandwiches: defenderProgress.sandwiches - stolenSandwiches,
              royal_coins: defenderProgress.royal_coins - coinsStolen
            })
            .eq('user_id', defender_id);

          // Update defender stats
          await supabase
            .from('pbc_raid_stats')
            .update({
              total_defenses: defenderStats.total_defenses + 1,
              last_raided_at: new Date().toISOString(),
              defense_rating: Math.max(50, defenderStats.defense_rating - 10),
              updated_at: new Date().toISOString()
            })
            .eq('user_id', defender_id);
        } else {
          // Failed raid - update defender stats
          await supabase
            .from('pbc_raid_stats')
            .update({
              total_defenses: defenderStats.total_defenses + 1,
              successful_defenses: defenderStats.successful_defenses + 1,
              defense_rating: Math.min(300, defenderStats.defense_rating + 10),
              updated_at: new Date().toISOString()
            })
            .eq('user_id', defender_id);
        }

        // Update attacker stats
        await supabase
          .from('pbc_raid_stats')
          .update({
            total_attacks: attackerStats.total_attacks + 1,
            successful_attacks: success ? attackerStats.successful_attacks + 1 : attackerStats.successful_attacks,
            attack_rating: success ? Math.min(300, attackerStats.attack_rating + 10) : Math.max(50, attackerStats.attack_rating - 5),
            last_attack_at: new Date().toISOString(),
            updated_at: new Date().toISOString()
          })
          .eq('user_id', user.id);

        // Record raid history
        await supabase
          .from('pbc_raid_history')
          .insert([{
            attacker_id: user.id,
            defender_id,
            attacker_name,
            defender_name,
            attacker_knights: knight_ids,
            defender_knights: defenderKnights.map(k => k.id),
            attack_power: Math.floor(attackRoll),
            defense_power: Math.floor(defenseRoll),
            success,
            resources_stolen: resourcesStolen,
            coins_stolen: coinsStolen
          }]);

        return respond({
          data: {
            success,
            attack_power: Math.floor(attackRoll),
            defense_power: Math.floor(defenseRoll),
            resources_stolen: resourcesStolen,
            coins_stolen: coinsStolen
          }
        });
      }

      case 'getRaidHistory': {
        if (!user) return respond({ error: 'Not authenticated' }, 401);

        const { data, error } = await supabase
          .from('pbc_raid_history')
          .select('*')
          .or(`attacker_id.eq.${user.id},defender_id.eq.${user.id}`)
          .order('created_at', { ascending: false })
          .limit(50);

        if (error) return respond({ error: error.message }, 400);
        return respond({ data });
      }

      case 'getRaidStats': {
        if (!user) return respond({ error: 'Not authenticated' }, 401);

        let { data, error } = await supabase
          .from('pbc_raid_stats')
          .select('*')
          .eq('user_id', user.id)
          .maybeSingle();

        // Create if doesn't exist
        if (!data) {
          const { data: newStats, error: createError } = await supabase
            .from('pbc_raid_stats')
            .insert([{ user_id: user.id }])
            .select()
            .single();

          if (createError) return respond({ error: createError.message }, 400);
          data = newStats;
        }

        if (error) return respond({ error: error.message }, 400);
        return respond({ data });
      }


      /* ==========================
         MEMES / SOCIAL CREDITS (ESC)
      ========================== */

      case 'postMeme': {
        // user submits a meme image URL
        if (!user) return respond({ error: 'Not authenticated' }, 401);

        const image_url = (payload && payload.image_url ? payload.image_url : '').trim();
        if (!isValidImageUrl(image_url)) {
          return respond({ error: 'Invalid or unsafe image_url. Must be http(s) and end in .png .jpg .jpeg .gif .webp .avif' }, 400);
        }

        const { data, error } = await supabase
          .from('haven_memes')
          .insert([{
            user_id: user.id,
            image_url,
            active: true
          }])
          .select('id, user_id, image_url, created_at, active')
          .single();

        if (error) return respond({ error: error.message }, 400);
        return respond({ data });
      }

	  case 'deleteMeme': {
		  // must be logged in
		  if (!user) return respond({ error: 'Not authenticated' }, 401);

		  const meme_id = payload && payload.meme_id;
		  if (!meme_id) return respond({ error: 'Missing meme_id' }, 400);

		  // confirm meme belongs to this user
		  const { data: memeRow, error: memeErr } = await supabase
			.from('haven_memes')
			.select('id, user_id')
			.eq('id', meme_id)
			.single();

		  if (memeErr || !memeRow) {
			return respond({ error: 'Meme not found' }, 404);
		  }
		  if (memeRow.user_id !== user.id) {
			return respond({ error: 'Not allowed' }, 403);
		  }

		  // delete reactions first (cleanup)
		  await supabase
			.from('haven_meme_reactions')
			.delete()
			.eq('meme_id', meme_id);

		  // delete the meme
		  const { error: delErr } = await supabase
			.from('haven_memes')
			.delete()
			.eq('id', meme_id);

		  if (delErr) {
			return respond({ error: delErr.message }, 400);
		  }

		  return respond({ data: { success: true } });
	  }

      case 'adminDeleteMeme': {
        // must be logged in
        if (!user) return respond({ error: 'Not authenticated' }, 401);

        // require MODERATOR+ (you can bump to ADMIN or OWNER if you want)
        const perm = await checkPermission(adminSupabase, user.id, null, 'MODERATOR');
        if (!perm.authorized) {
          return respond({ error: perm.reason || 'Insufficient permissions' }, 403);
        }

        const meme_id = payload && payload.meme_id;
        if (!meme_id) return respond({ error: 'Missing meme_id' }, 400);

        // delete reactions first
        await adminSupabase
          .from('haven_meme_reactions')
          .delete()
          .eq('meme_id', meme_id);

        // delete the meme row
        const { error: delErr } = await adminSupabase
          .from('haven_memes')
          .delete()
          .eq('id', meme_id);

        if (delErr) {
          return respond({ error: delErr.message }, 400);
        }

        return respond({ data: { success: true } });
      }

      case 'adminUpdateMemeUrl': {
        if (!user) return respond({ error: 'Not authenticated' }, 401);

        const perm = await checkPermission(adminSupabase, user.id, null, 'MODERATOR');
        if (!perm.authorized) {
          return respond({ error: perm.reason || 'Insufficient permissions' }, 403);
        }

        const meme_id   = payload && payload.meme_id;
        const image_url = payload && payload.image_url && payload.image_url.trim();
        if (!meme_id || !image_url) {
          return respond({ error: 'Missing meme_id or image_url' }, 400);
        }

        // reuse the same validator you wrote:
        if (!isValidImageUrl(image_url)) {
          return respond({ error: 'Invalid image_url' }, 400);
        }

        const { error: upErr } = await adminSupabase
          .from('haven_memes')
          .update({ image_url })
          .eq('id', meme_id);

        if (upErr) {
          return respond({ error: upErr.message }, 400);
        }

        return respond({ data: { success: true } });
      }


      case 'listMemes': {
        // returns newest memes + reaction counts + my reaction + poster profile
        if (!user) return respond({ error: 'Not authenticated' }, 401);

        // 1. pull memes
        const { data: memes, error: memesErr } = await supabase
          .from('haven_memes')
          .select('id, user_id, image_url, created_at, active')
          .eq('active', true)
          .order('created_at', { ascending: false })
          .limit(25);

        if (memesErr) return respond({ error: memesErr.message }, 400);

        const memeIds = (memes || []).map(m => m.id);
        const posterIds = [...new Set((memes || []).map(m => m.user_id))];

        // 2. pull reactions
        let reactMap = {};
        if (memeIds.length) {
          const { data: rxRows, error: rxErr } = await supabase
            .from('haven_meme_reactions')
            .select('meme_id, user_id, reaction')
            .in('meme_id', memeIds);

          if (rxErr) return respond({ error: rxErr.message }, 400);

          reactMap = {};
          rxRows.forEach(r => {
            if (!reactMap[r.meme_id]) {
              reactMap[r.meme_id] = {
                heart:0, smile:0, cry:0, angry:0, astonished:0, report:0,
                user_reaction:null
              };
            }
            reactMap[r.meme_id][r.reaction] =
              (reactMap[r.meme_id][r.reaction] || 0) + 1;
            if (r.user_id === user.id) {
              reactMap[r.meme_id].user_reaction = r.reaction;
            }
          });
        }

        // 3. pull poster profile basics so front end can show a name
        let profileMap = {};
        if (posterIds.length) {
          const { data: profRows, error: profErr } = await supabase
            .from('profiles')
            .select('id, display_name, email')
            .in('id', posterIds);

          if (!profErr && profRows) {
            profRows.forEach(p => {
              profileMap[p.id] = {
                display_name: p.display_name || null,
                email: p.email || null
              };
            });
          }
        }

        // 4. final shape
        const result = (memes || []).map(m => ({
          id: m.id,
          user_id: m.user_id,
          poster: profileMap[m.user_id] || null, // <- NEW
          image_url: m.image_url,
          created_at: m.created_at,
          reactions: reactMap[m.id] ? {
            heart: reactMap[m.id].heart || 0,
            smile: reactMap[m.id].smile || 0,
            cry: reactMap[m.id].cry || 0,
            angry: reactMap[m.id].angry || 0,
            astonished: reactMap[m.id].astonished || 0,
            report: reactMap[m.id].report || 0
          } : { heart:0, smile:0, cry:0, angry:0, astonished:0, report:0 },
          user_reaction: reactMap[m.id]
            ? (reactMap[m.id].user_reaction || null)
            : null
        }));

        return respond({ data: result });
      }


      case 'reactMeme': {
        // user reacts to a meme, possibly earning ESC
        if (!user) return respond({ error: 'Not authenticated' }, 401);

        const meme_id = payload && payload.meme_id;
        const rawReaction = (payload && payload.reaction || '').toLowerCase().trim();

        const ALLOWED = ['heart','smile','cry','angry','astonished','report'];
        if (!meme_id || !ALLOWED.includes(rawReaction)) {
          return respond({ error: 'Bad payload' }, 400);
        }

        // see if they already reacted
        const { data: existing, error: exErr } = await supabase
          .from('haven_meme_reactions')
          .select('id, reaction')
          .eq('meme_id', meme_id)
          .eq('user_id', user.id)
          .maybeSingle();

        if (exErr) return respond({ error: exErr.message }, 400);

        let createdNew = false;

        if (!existing) {
          // new row
          const { error: insErr } = await supabase
            .from('haven_meme_reactions')
            .insert([{
              meme_id,
              user_id: user.id,
              reaction: rawReaction
            }]);

          if (insErr) return respond({ error: insErr.message }, 400);
          createdNew = true;
        } else {
          // update the reaction if different
          if (existing.reaction !== rawReaction) {
            const { error: upErr } = await supabase
              .from('haven_meme_reactions')
              .update({ reaction: rawReaction })
              .eq('id', existing.id);

            if (upErr) return respond({ error: upErr.message }, 400);
          }
        }

        // award +1 ESC only if first time AND not a "report"
        if (createdNew && rawReaction !== 'report') {
          await awardEscCredit(supabase, user.id);
        }

        // return updated summary for that meme
        const { data: rxRows2, error: rxErr2 } = await supabase
          .from('haven_meme_reactions')
          .select('user_id, reaction')
          .eq('meme_id', meme_id);

        if (rxErr2) return respond({ error: rxErr2.message }, 400);

        const summary = {
          heart:0, smile:0, cry:0, angry:0, astonished:0, report:0,
          user_reaction:null
        };

        rxRows2.forEach(r => {
          summary[r.reaction] = (summary[r.reaction] || 0) + 1;
          if (r.user_id === user.id) {
            summary.user_reaction = r.reaction;
          }
        });

        return respond({ data: { meme_id, reactions: summary } });
      }

	  // ============================================
      // VIDEO CALL INVITES & PRESENCE TRACKING
      // ============================================
      
      case 'updatePresence': {
        if (!user) return respond({ error: 'Not authenticated' }, 401);
        
        const { status } = payload || {};
        const allowedStatuses = ['online', 'away', 'dnd', 'offline'];
        const finalStatus = allowedStatuses.includes(status) ? status : 'online';
        
        // Update last_active_at and status
        const { error } = await supabase
          .from('profiles')
          .update({
            last_active_at: new Date().toISOString(),
            status: finalStatus
          })
          .eq('id', user.id);
        
        if (error) return respond({ error: error.message }, 500);
        return respond({ data: { updated: true } });
      }

	  case 'getOnlineFriends': {
        if (!user) return respond({ error: 'Not authenticated' }, 401);
        
        // Get user's friends from awareness_friendships (bidirectional)
        const { data: friendships, error: friendErr } = await supabase
          .from('awareness_friendships')
          .select('user1_id, user2_id')
          .or(`user1_id.eq.${user.id},user2_id.eq.${user.id}`)
        
        if (friendErr) return respond({ error: friendErr.message }, 500);
        if (!friendships || !friendships.length) {
          return respond({ data: [] });
        }
        
        // Extract friend IDs (the one that's NOT the current user)
        const friendIds = friendships.map(f => 
          f.user1_id === user.id ? f.user2_id : f.user1_id
        );
        
		// Get ALL friends with presence info (show offline too)
        const twoMinutesAgo = new Date(Date.now() - 2 * 60 * 1000).toISOString();
        
        const { data: friends, error: profileErr } = await supabase
          .from('profiles')
          .select('id, display_name, email, last_active_at, status, in_call')
          .in('id', friendIds)
          .order('last_active_at', { ascending: false });
        
        if (profileErr) return respond({ error: profileErr.message }, 500);
        
        // Format response
        const onlineFriends = (friends || []).map(f => ({
          id: f.id,
          name: f.display_name || f.email,
          status: f.status || 'online',
          in_call: f.in_call || false,
          last_active: f.last_active_at
        }));
        
        return respond({ data: onlineFriends });
      }

      case 'sendVideoCallInvite': {
        if (!user) return respond({ error: 'Not authenticated' }, 401);
        
        const { to_user_id } = payload || {};
        if (!to_user_id) return respond({ error: 'Missing to_user_id' }, 400);
        
		// Check if they're friends (one-directional check like getFriends)
        const { data: friendship, error: friendErr } = await supabase
          .from('awareness_friendships')
          .select('id')
          .eq('user1_id', user.id)
          .eq('user2_id', to_user_id)
		  .maybeSingle();
        
        if (friendErr || !friendship) {
          return respond({ error: 'Not friends with this user' }, 403);
        }
        
        // Check if recipient is online and not in call
        const { data: recipient } = await supabase
          .from('profiles')
          .select('in_call, last_active_at')
          .eq('id', to_user_id)
          .single();
        
        if (recipient?.in_call) {
          return respond({ error: 'User is already in a call' }, 400);
        }
        
        const twoMinutesAgo = new Date(Date.now() - 2 * 60 * 1000).toISOString();
        if (!recipient || recipient.last_active_at < twoMinutesAgo) {
          return respond({ error: 'User is not online' }, 400);
        }
        
        // Create video session first
        const { data: session, error: sessionErr } = await supabase
          .from('video_sessions')
          .insert({
            host_id: user.id,
            status: 'waiting',
            tags: ['friend_call']
          })
          .select()
          .single();
        
        if (sessionErr) return respond({ error: sessionErr.message }, 500);
        
        // Create invite (will fail if pending invite already exists due to unique index)
        const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString(); // 5 min
        const { data: invite, error: inviteErr } = await supabase
          .from('video_call_invites')
          .insert({
            from_user_id: user.id,
            to_user_id: to_user_id,
            session_id: session.id,
            expires_at: expiresAt
          })
          .select()
          .single();
        
        if (inviteErr) {
          // Clean up session if invite creation failed
          await supabase.from('video_sessions').delete().eq('id', session.id);
          return respond({ error: 'Invite already pending or failed to create' }, 400);
        }
        
        return respond({ data: { invite_id: invite.id, session_id: session.id } });
      }

      case 'respondToVideoCallInvite': {
        if (!user) return respond({ error: 'Not authenticated' }, 401);
        
        const { invite_id, response } = payload || {}; // response: 'accept' or 'decline'
        if (!invite_id || !response) {
          return respond({ error: 'Missing invite_id or response' }, 400);
        }
        
        if (!['accept', 'decline'].includes(response)) {
          return respond({ error: 'Invalid response (must be accept or decline)' }, 400);
        }
        
        // Get the invite
        const { data: invite, error: inviteErr } = await supabase
          .from('video_call_invites')
          .select('*, video_sessions(id, host_id, status)')
          .eq('id', invite_id)
          .eq('to_user_id', user.id) // ensure it's for this user
          .eq('status', 'pending')
          .single();
        
        if (inviteErr || !invite) {
          return respond({ error: 'Invite not found or already responded' }, 404);
        }
        
        // Check if expired
        if (new Date(invite.expires_at) < new Date()) {
          await supabase
            .from('video_call_invites')
            .update({ status: 'expired' })
            .eq('id', invite_id);
          return respond({ error: 'Invite has expired' }, 400);
        }
        
        const newStatus = response === 'accept' ? 'accepted' : 'declined';
        
        // Update invite status
        const { error: updateErr } = await supabase
          .from('video_call_invites')
          .update({
            status: newStatus,
            responded_at: new Date().toISOString()
          })
          .eq('id', invite_id);
        
        if (updateErr) return respond({ error: updateErr.message }, 500);
        
        if (response === 'accept') {
          // Update video session with guest
          await supabase
            .from('video_sessions')
            .update({
              guest_id: user.id,
              status: 'active'
            })
            .eq('id', invite.session_id);
          
          // Mark both users as in_call
          await supabase.from('profiles')
            .update({ in_call: true })
            .in('id', [invite.from_user_id, user.id]);
          
          return respond({ 
            data: { 
              accepted: true, 
              session_id: invite.session_id 
            } 
          });
        } else {
          // Decline: clean up session
          await supabase
            .from('video_sessions')
            .delete()
            .eq('id', invite.session_id);
          
          return respond({ data: { declined: true } });
        }
      }

      case 'checkPendingVideoInvites': {
        if (!user) return respond({ error: 'Not authenticated' }, 401);

        // Get pending invites TO this user that haven't expired
        const now = new Date().toISOString();
        const { data: invites, error: inviteErr } = await supabase
          .from('video_call_invites')
          .select('*')
          .eq('to_user_id', user.id)
          .eq('status', 'pending')
          .gt('expires_at', now)
          .order('created_at', { ascending: false });

        if (inviteErr) return respond({ error: inviteErr.message }, 500);

        // Fetch sender profiles separately
        const fromUserIds = [...new Set((invites || []).map(i => i.from_user_id).filter(Boolean))];

        let profilesMap = {};
        if (fromUserIds.length > 0) {
          const { data: profiles } = await supabase
            .from('profiles')
            .select('id, display_name, email')
            .in('id', fromUserIds);

          profilesMap = (profiles || []).reduce((acc, p) => {
            acc[p.id] = p;
            return acc;
          }, {});
        }

        // Format response
        const pendingInvites = (invites || []).map(inv => ({
          invite_id: inv.id,
          from_user_id: inv.from_user_id,
          from_user_name: profilesMap[inv.from_user_id]?.display_name || profilesMap[inv.from_user_id]?.email || 'Unknown',
          session_id: inv.session_id,
          created_at: inv.created_at,
          expires_at: inv.expires_at
        }));

        return respond({ data: pendingInvites });
      }

      case 'endVideoCall': {
        if (!user) return respond({ error: 'Not authenticated' }, 401);
        
        const { session_id } = payload || {};
        if (!session_id) return respond({ error: 'Missing session_id' }, 400);
        
        // Get session to find both participants
        const { data: session } = await supabase
          .from('video_sessions')
          .select('host_id, guest_id')
          .eq('id', session_id)
          .single();
        
        if (!session) return respond({ error: 'Session not found' }, 404);
        
        // Update session status to ended
        await supabase
          .from('video_sessions')
          .update({ status: 'ended' })
          .eq('id', session_id);
        
        // Mark both users as NOT in_call
        const participants = [session.host_id, session.guest_id].filter(Boolean);
        if (participants.length > 0) {
          await supabase
            .from('profiles')
            .update({ in_call: false })
            .in('id', participants);
        }
        
        return respond({ data: { ended: true } });
      }

      /* ==========================
         FOODCHAIN HANDLERS
      ========================== */

      case 'getChains': {
        const { category, search } = payload || {};
        let query = supabase
          .from('foodchain_chains')
          .select('*')
          .eq('is_published', true)
          .order('created_at', { ascending: false });

        if (category && category !== 'all') {
          query = query.eq('category', category);
        }

        if (search) {
          query = query.or(`title.ilike.%${search}%,description.ilike.%${search}%`);
        }

        const { data, error } = await query;

        if (error) return respond({ error: error.message }, 500);

        // Fetch author names separately
        const chains = data || [];
        const userIds = [...new Set(chains.map(c => c.user_id).filter(Boolean))];

        let profilesMap = {};
        if (userIds.length > 0) {
          const { data: profiles } = await supabase
            .from('profiles')
            .select('id, display_name')
            .in('id', userIds);

          profilesMap = (profiles || []).reduce((acc, p) => {
            acc[p.id] = p.display_name;
            return acc;
          }, {});
        }

        const chainsWithAuthors = chains.map(chain => ({
          ...chain,
          author_name: profilesMap[chain.user_id] || 'Anonymous'
        }));

        return respond({ data: chainsWithAuthors });
      }

      case 'getMyChains': {
        if (!user) return respond({ error: 'Not authenticated' }, 401);

        const { filter } = payload || {};
        let query = supabase
          .from('foodchain_chains')
          .select('*')
          .eq('user_id', user.id)
          .order('created_at', { ascending: false });

        if (filter === 'published') {
          query = query.eq('is_published', true);
        } else if (filter === 'draft') {
          query = query.eq('is_published', false);
        }

        const { data, error } = await query;
        if (error) return respond({ error: error.message }, 500);

        return respond({ data: data || [] });
      }

      case 'getChainDetail': {
        const { chain_id } = payload || {};
        if (!chain_id) return respond({ error: 'Missing chain_id' }, 400);

        const { data, error } = await supabase
          .from('foodchain_chains')
          .select('*')
          .eq('id', chain_id)
          .single();

        if (error) return respond({ error: error.message }, 500);
        if (!data) return respond({ error: 'Chain not found' }, 404);

        // Fetch author name separately
        let authorName = 'Anonymous';
        if (data.user_id) {
          const { data: profile } = await supabase
            .from('profiles')
            .select('display_name')
            .eq('id', data.user_id)
            .maybeSingle();

          authorName = profile?.display_name || 'Anonymous';
        }

        // Check if user liked this chain
        let userLiked = false;
        if (user) {
          const { data: likeData } = await supabase
            .from('foodchain_likes')
            .select('id')
            .eq('chain_id', chain_id)
            .eq('user_id', user.id)
            .maybeSingle();
          userLiked = !!likeData;
        }

        const result = {
          ...data,
          author_name: authorName,
          user_liked: userLiked
        };

        return respond({ data: result });
      }

      case 'getChainMeals': {
        const { chain_id } = payload || {};
        if (!chain_id) return respond({ error: 'Missing chain_id' }, 400);

        const { data, error } = await supabase
          .from('foodchain_meals')
          .select('*')
          .eq('chain_id', chain_id)
          .order('position', { ascending: true });

        if (error) return respond({ error: error.message }, 500);

        return respond({ data: data || [] });
      }

      case 'getMealIngredients': {
        const { meal_id } = payload || {};
        if (!meal_id) return respond({ error: 'Missing meal_id' }, 400);

        const { data: ingredientsData, error } = await supabase
          .from('foodchain_meal_ingredients')
          .select('*')
          .eq('meal_id', meal_id)
          .order('created_at', { ascending: true });

        if (error) return respond({ error: error.message }, 500);

        // Fetch item names for each ingredient
        // Use adminSupabase to bypass RLS so all ingredients (including user-created ones) are visible
        const ingredients = await Promise.all((ingredientsData || []).map(async (ing) => {
          // Get the item name from foodchain_ingredients using admin client
          const { data: itemData, error: itemError } = await adminSupabase
            .from('foodchain_ingredients')
            .select('name')
            .eq('id', ing.ingredient_id)
            .maybeSingle();

          if (itemError) {
            console.error('Error fetching item:', itemError);
          }

          console.log(`Ingredient ${ing.ingredient_id}: found item name = ${itemData?.name || 'NOT FOUND'}`);

          return {
            ...ing,
            item_name: itemData?.name || 'Unknown',
            consumed: ing.is_leftover || false
          };
        }));

        return respond({ data: ingredients });
      }

      case 'getMealDetail': {
        const { meal_id } = payload || {};
        if (!meal_id) return respond({ error: 'Missing meal_id' }, 400);

        const { data, error } = await supabase
          .from('foodchain_meals')
          .select('*')
          .eq('id', meal_id)
          .single();

        if (error) return respond({ error: error.message }, 500);

        return respond({ data });
      }

      case 'createChain': {
        if (!user) return respond({ error: 'Not authenticated' }, 401);

        const { title, description, category, cover_image, days_count } = payload || {};

        if (!title) return respond({ error: 'Missing title' }, 400);
        if (!category) return respond({ error: 'Missing category' }, 400);

        const { data, error } = await supabase
          .from('foodchain_chains')
          .insert({
            user_id: user.id,
            title,
            description: description || null,
            category,
            cover_image: cover_image || null,
            days_count: days_count || 0,
            is_published: false
          })
          .select()
          .single();

        if (error) return respond({ error: error.message }, 500);

        return respond({ data });
      }

      case 'createMeal': {
        if (!user) return respond({ error: 'Not authenticated' }, 401);

        const { chain_id, position, name, description, image_url, cost, prep_time } = payload || {};

        if (!chain_id) return respond({ error: 'Missing chain_id' }, 400);
        if (!position) return respond({ error: 'Missing position' }, 400);
        if (!name) return respond({ error: 'Missing name' }, 400);

        // Verify user owns the chain
        const { data: chain } = await supabase
          .from('foodchain_chains')
          .select('user_id')
          .eq('id', chain_id)
          .single();

        if (!chain || chain.user_id !== user.id) {
          return respond({ error: 'Unauthorized' }, 403);
        }

        const { data, error } = await supabase
          .from('foodchain_meals')
          .insert({
            chain_id,
            position,
            name,
            description: description || null,
            image_url: image_url || null,
            cost: cost || 0,
            prep_time: prep_time || null
          })
          .select()
          .single();

        if (error) return respond({ error: error.message }, 500);

        return respond({ data });
      }

      case 'addMealIngredient': {
        if (!user) return respond({ error: 'Not authenticated' }, 401);

        const { meal_id, ingredient_id, quantity, unit, cost, consumed } = payload || {};

        if (!meal_id) return respond({ error: 'Missing meal_id' }, 400);
        if (!ingredient_id) return respond({ error: 'Missing ingredient_id' }, 400);

        // Verify user owns the meal's chain
        const { data: meal } = await supabase
          .from('foodchain_meals')
          .select('chain_id, foodchain_chains!inner(user_id)')
          .eq('id', meal_id)
          .single();

        if (!meal || meal.foodchain_chains.user_id !== user.id) {
          return respond({ error: 'Unauthorized' }, 403);
        }

        const { data, error } = await supabase
          .from('foodchain_meal_ingredients')
          .insert({
            meal_id,
            ingredient_id,
            quantity: quantity || 1,
            unit: unit || 'unit',
            cost: cost || 0,
            is_leftover: consumed || false
          })
          .select()
          .single();

        if (error) return respond({ error: error.message }, 500);

        return respond({ data });
      }

      case 'updateMeal': {
        if (!user) return respond({ error: 'Not authenticated' }, 401);

        const { meal_id, name, description, image_url, cost, prep_time } = payload || {};

        if (!meal_id) return respond({ error: 'Missing meal_id' }, 400);

        // Verify user owns the meal's chain
        const { data: meal } = await supabase
          .from('foodchain_meals')
          .select('chain_id, foodchain_chains!inner(user_id)')
          .eq('id', meal_id)
          .single();

        if (!meal || meal.foodchain_chains.user_id !== user.id) {
          return respond({ error: 'Unauthorized' }, 403);
        }

        const { data, error } = await supabase
          .from('foodchain_meals')
          .update({
            name: name || meal.name,
            description,
            image_url,
            cost: cost || 0,
            prep_time
          })
          .eq('id', meal_id)
          .select()
          .single();

        if (error) return respond({ error: error.message }, 500);

        return respond({ data });
      }

      case 'deleteMealIngredients': {
        if (!user) return respond({ error: 'Not authenticated' }, 401);

        const { meal_id } = payload || {};

        if (!meal_id) return respond({ error: 'Missing meal_id' }, 400);

        // Verify user owns the meal's chain
        const { data: meal } = await supabase
          .from('foodchain_meals')
          .select('chain_id, foodchain_chains!inner(user_id)')
          .eq('id', meal_id)
          .single();

        if (!meal || meal.foodchain_chains.user_id !== user.id) {
          return respond({ error: 'Unauthorized' }, 403);
        }

        const { error } = await supabase
          .from('foodchain_meal_ingredients')
          .delete()
          .eq('meal_id', meal_id);

        if (error) return respond({ error: error.message }, 500);

        return respond({ data: { success: true } });
      }

      case 'publishChain': {
        if (!user) return respond({ error: 'Not authenticated' }, 401);

        const { chain_id } = payload || {};
        if (!chain_id) return respond({ error: 'Missing chain_id' }, 400);

        // Verify user owns the chain
        const { data: chain } = await supabase
          .from('foodchain_chains')
          .select('user_id')
          .eq('id', chain_id)
          .single();

        if (!chain || chain.user_id !== user.id) {
          return respond({ error: 'Unauthorized' }, 403);
        }

        const { data, error } = await supabase
          .from('foodchain_chains')
          .update({ is_published: true })
          .eq('id', chain_id)
          .select()
          .single();

        if (error) return respond({ error: error.message }, 500);

        return respond({ data });
      }

      case 'unpublishChain': {
        if (!user) return respond({ error: 'Not authenticated' }, 401);

        const { chain_id } = payload || {};
        if (!chain_id) return respond({ error: 'Missing chain_id' }, 400);

        // Verify user owns the chain
        const { data: chain } = await supabase
          .from('foodchain_chains')
          .select('user_id')
          .eq('id', chain_id)
          .single();

        if (!chain || chain.user_id !== user.id) {
          return respond({ error: 'Unauthorized' }, 403);
        }

        const { data, error } = await supabase
          .from('foodchain_chains')
          .update({ is_published: false })
          .eq('id', chain_id)
          .select()
          .single();

        if (error) return respond({ error: error.message }, 500);

        return respond({ data });
      }

      case 'likeChain': {
        if (!user) return respond({ error: 'Not authenticated' }, 401);

        const { chain_id } = payload || {};
        if (!chain_id) return respond({ error: 'Missing chain_id' }, 400);

        const { data, error } = await supabase
          .from('foodchain_likes')
          .insert({
            user_id: user.id,
            chain_id
          })
          .select()
          .single();

        if (error) {
          // Check if already liked
          if (error.code === '23505') {
            return respond({ error: 'Already liked' }, 400);
          }
          return respond({ error: error.message }, 500);
        }

        return respond({ data });
      }

      case 'unlikeChain': {
        if (!user) return respond({ error: 'Not authenticated' }, 401);

        const { chain_id } = payload || {};
        if (!chain_id) return respond({ error: 'Missing chain_id' }, 400);

        const { error } = await supabase
          .from('foodchain_likes')
          .delete()
          .eq('user_id', user.id)
          .eq('chain_id', chain_id);

        if (error) return respond({ error: error.message }, 500);

        return respond({ data: { success: true } });
      }

      case 'getComments': {
        const { chain_id } = payload || {};
        if (!chain_id) return respond({ error: 'Missing chain_id' }, 400);

        const { data, error } = await supabase
          .from('foodchain_comments')
          .select('*')
          .eq('chain_id', chain_id)
          .order('created_at', { ascending: false });

        if (error) return respond({ error: error.message }, 500);

        // Fetch author names separately
        const comments = data || [];
        const userIds = [...new Set(comments.map(c => c.user_id).filter(Boolean))];

        let profilesMap = {};
        if (userIds.length > 0) {
          const { data: profiles } = await supabase
            .from('profiles')
            .select('id, display_name')
            .in('id', userIds);

          profilesMap = (profiles || []).reduce((acc, p) => {
            acc[p.id] = p.display_name;
            return acc;
          }, {});
        }

        const commentsWithAuthors = comments.map(comment => ({
          ...comment,
          author_name: profilesMap[comment.user_id] || 'Anonymous'
        }));

        return respond({ data: commentsWithAuthors });
      }

      case 'addComment': {
        if (!user) return respond({ error: 'Not authenticated' }, 401);

        const { chain_id, content } = payload || {};

        if (!chain_id) return respond({ error: 'Missing chain_id' }, 400);
        if (!content) return respond({ error: 'Missing content' }, 400);

        const { data, error } = await supabase
          .from('foodchain_comments')
          .insert({
            user_id: user.id,
            chain_id,
            content
          })
          .select()
          .single();

        if (error) return respond({ error: error.message }, 500);

        return respond({ data });
      }

      case 'getUserStats': {
        if (!user) return respond({ error: 'Not authenticated' }, 401);

        const { data, error } = await supabase
          .from('foodchain_user_stats')
          .select('*')
          .eq('user_id', user.id)
          .maybeSingle();

        if (error) return respond({ error: error.message }, 500);

        return respond({ data: data || {
          user_id: user.id,
          chains_created: 0,
          total_meals: 0,
          total_saved: 0,
          longest_chain: 0,
          followers_count: 0,
          following_count: 0,
          badges: []
        }});
      }

      case 'getFollowers': {
        if (!user) return respond({ error: 'Not authenticated' }, 401);

        // Get users who follow the current user
        const { data: follows, error } = await adminSupabase
          .from('foodchain_follows')
          .select('follower_id')
          .eq('following_id', user.id);

        if (error) return respond({ error: error.message }, 500);

        if (!follows || follows.length === 0) {
          return respond({ data: [] });
        }

        const followerIds = follows.map(f => f.follower_id);

        // Get profiles for these users
        const { data: profiles, error: profileError } = await adminSupabase
          .from('profiles')
          .select('id, email, display_name')
          .in('id', followerIds);

        if (profileError) return respond({ error: profileError.message }, 500);

        return respond({ data: profiles || [] });
      }

      case 'getFollowing': {
        if (!user) return respond({ error: 'Not authenticated' }, 401);

        // Get users that the current user follows
        const { data: follows, error } = await adminSupabase
          .from('foodchain_follows')
          .select('following_id')
          .eq('follower_id', user.id);

        if (error) return respond({ error: error.message }, 500);

        if (!follows || follows.length === 0) {
          return respond({ data: [] });
        }

        const followingIds = follows.map(f => f.following_id);

        // Get profiles for these users
        const { data: profiles, error: profileError } = await adminSupabase
          .from('profiles')
          .select('id, email, display_name')
          .in('id', followingIds);

        if (profileError) return respond({ error: profileError.message }, 500);

        return respond({ data: profiles || [] });
      }

      case 'unfollowUser': {
        if (!user) return respond({ error: 'Not authenticated' }, 401);

        const { user_id } = payload || {};

        if (!user_id) return respond({ error: 'Missing user_id' }, 400);

        const { error } = await supabase
          .from('foodchain_follows')
          .delete()
          .eq('follower_id', user.id)
          .eq('following_id', user_id);

        if (error) return respond({ error: error.message }, 500);

        return respond({ data: { success: true } });
      }

      case 'getIngredients': {
        // Get all global/approved ingredients + user's custom ingredients
        // Use adminSupabase to see all ingredients, then filter appropriately
        const { data: allIngredients, error } = await adminSupabase
          .from('foodchain_ingredients')
          .select('*')
          .order('name');

        if (error) return respond({ error: error.message }, 500);

        // Filter based on visibility rules:
        // 1. Global/System ingredients (user_id IS NULL)
        // 2. Approved ingredients (is_approved = TRUE) - these should also have user_id = NULL after approval
        // 3. User's own custom ingredients (user_id = current user)
        const visibleIngredients = (allIngredients || []).filter(ing => {
          // Global/system ingredients (always visible)
          if (ing.user_id === null) return true;

          // User's own custom ingredients (only visible to owner)
          if (user && ing.user_id === user.id) return true;

          // Approved ingredients that are still marked with user_id shouldn't happen,
          // but include them just in case the approval function didn't clear user_id
          if (ing.is_approved === true) return true;

          // Everything else is not visible
          return false;
        });

        return respond({ data: visibleIngredients });
      }

      case 'createCustomIngredient': {
        if (!user) return respond({ error: 'Not authenticated' }, 401);

        const { name, category, default_price, unit, package_size } = payload || {};

        if (!name) return respond({ error: 'Missing ingredient name' }, 400);

        const { data, error } = await supabase
          .from('foodchain_ingredients')
          .insert({
            user_id: user.id,
            name,
            category: category || null,
            default_price: default_price || 0,
            unit: unit || 'unit',
            package_size: package_size || 1,
            price_count: 0,
            submitted_by: user.id
          })
          .select()
          .single();

        if (error) return respond({ error: error.message }, 500);

        return respond({ data });
      }

      case 'updateCustomIngredient': {
        if (!user) return respond({ error: 'Not authenticated' }, 401);

        const { ingredient_id, name, category, default_price, unit, package_size } = payload || {};

        if (!ingredient_id) return respond({ error: 'Missing ingredient_id' }, 400);

        // Verify user owns this ingredient
        const { data: ingredient } = await supabase
          .from('foodchain_ingredients')
          .select('user_id')
          .eq('id', ingredient_id)
          .single();

        if (!ingredient || ingredient.user_id !== user.id) {
          return respond({ error: 'Unauthorized' }, 403);
        }

        const { data, error } = await supabase
          .from('foodchain_ingredients')
          .update({
            name,
            category,
            default_price,
            unit,
            package_size
          })
          .eq('id', ingredient_id)
          .select()
          .single();

        if (error) return respond({ error: error.message }, 500);

        return respond({ data });
      }

      case 'deleteCustomIngredient': {
        if (!user) return respond({ error: 'Not authenticated' }, 401);

        const { ingredient_id } = payload || {};

        if (!ingredient_id) return respond({ error: 'Missing ingredient_id' }, 400);

        // Verify user owns this ingredient
        const { data: ingredient } = await supabase
          .from('foodchain_ingredients')
          .select('user_id')
          .eq('id', ingredient_id)
          .single();

        if (!ingredient || ingredient.user_id !== user.id) {
          return respond({ error: 'Unauthorized' }, 403);
        }

        // Check if ingredient is used in any meals using admin client to bypass RLS
        const { data: usageCheck, error: usageError } = await adminSupabase
          .from('foodchain_meal_ingredients')
          .select('id')
          .eq('ingredient_id', ingredient_id)
          .limit(1);

        if (usageError) {
          return respond({ error: 'Error checking ingredient usage: ' + usageError.message }, 500);
        }

        if (usageCheck && usageCheck.length > 0) {
          return respond({
            error: 'Cannot delete ingredient that is used in meals. This ingredient is being used in one or more food chains.'
          }, 400);
        }

        const { error } = await supabase
          .from('foodchain_ingredients')
          .delete()
          .eq('id', ingredient_id);

        if (error) return respond({ error: error.message }, 500);

        return respond({ data: { success: true } });
      }

      case 'submitIngredientForApproval': {
        if (!user) return respond({ error: 'Not authenticated' }, 401);

        const { ingredient_id } = payload || {};

        if (!ingredient_id) return respond({ error: 'Missing ingredient_id' }, 400);

        // Verify user owns this ingredient
        const { data: ingredient } = await supabase
          .from('foodchain_ingredients')
          .select('user_id, name')
          .eq('id', ingredient_id)
          .single();

        if (!ingredient || ingredient.user_id !== user.id) {
          return respond({ error: 'Unauthorized' }, 403);
        }

        // Check if already submitted
        const { data: existingSubmission } = await supabase
          .from('foodchain_ingredient_submissions')
          .select('id, status')
          .eq('ingredient_id', ingredient_id)
          .maybeSingle();

        if (existingSubmission) {
          return respond({ error: `This ingredient was already submitted and is ${existingSubmission.status}` }, 400);
        }

        // Create submission
        const { data, error } = await supabase
          .from('foodchain_ingredient_submissions')
          .insert({
            ingredient_id,
            submitted_by: user.id,
            status: 'pending'
          })
          .select()
          .single();

        if (error) return respond({ error: error.message }, 500);

        return respond({ data });
      }

      case 'getMyIngredientSubmissions': {
        if (!user) return respond({ error: 'Not authenticated' }, 401);

        const { data, error } = await supabase
          .from('foodchain_ingredient_submissions')
          .select(`
            *,
            ingredient:foodchain_ingredients(id, name, category, unit, default_price)
          `)
          .eq('submitted_by', user.id)
          .order('created_at', { ascending: false });

        if (error) return respond({ error: error.message }, 500);

        return respond({ data: data || [] });
      }

      case 'getPendingIngredientSubmissions': {
        if (!user) return respond({ error: 'Not authenticated' }, 401);

        // Check if user has admin privileges
        const permission = await checkPermission(supabase, user.id, null, 'MODERATOR');
        if (!permission.authorized) {
          return respond({ error: 'Admin access required' }, 403);
        }

        const { data, error } = await adminSupabase
          .from('foodchain_ingredient_submissions')
          .select(`
            *,
            ingredient:foodchain_ingredients(id, name, category, unit, default_price),
            submitter:profiles!foodchain_ingredient_submissions_submitted_by_fkey(id, display_name)
          `)
          .eq('status', 'pending')
          .order('created_at', { ascending: true });

        if (error) return respond({ error: error.message }, 500);

        return respond({ data: data || [] });
      }

      case 'approveIngredientSubmission': {
        if (!user) return respond({ error: 'Not authenticated' }, 401);

        // Check if user has admin privileges
        const permission = await checkPermission(supabase, user.id, null, 'MODERATOR');
        if (!permission.authorized) {
          return respond({ error: 'Admin access required' }, 403);
        }

        const { submission_id, notes } = payload || {};

        if (!submission_id) return respond({ error: 'Missing submission_id' }, 400);

        try {
          // Use the database function to approve
          const { error } = await adminSupabase.rpc('approve_ingredient_submission', {
            submission_id,
            admin_id: user.id,
            notes: notes || null
          });

          if (error) throw error;

          return respond({ data: { success: true } });
        } catch (err) {
          return respond({ error: err.message }, 500);
        }
      }

      case 'rejectIngredientSubmission': {
        if (!user) return respond({ error: 'Not authenticated' }, 401);

        // Check if user has admin privileges
        const permission = await checkPermission(supabase, user.id, null, 'MODERATOR');
        if (!permission.authorized) {
          return respond({ error: 'Admin access required' }, 403);
        }

        const { submission_id, notes } = payload || {};

        if (!submission_id) return respond({ error: 'Missing submission_id' }, 400);

        try {
          // Use the database function to reject
          const { error } = await adminSupabase.rpc('reject_ingredient_submission', {
            submission_id,
            admin_id: user.id,
            notes: notes || null
          });

          if (error) throw error;

          return respond({ data: { success: true } });
        } catch (err) {
          return respond({ error: err.message }, 500);
        }
      }

      case 'uploadImage': {
        if (!user) return respond({ error: 'Not authenticated' }, 401);

        const { fileName, fileData } = payload || {};

        if (!fileName || !fileData) {
          return respond({ error: 'Missing fileName or fileData' }, 400);
        }

        try {
          // Extract base64 data
          const base64Data = fileData.split(',')[1];
          const buffer = Buffer.from(base64Data, 'base64');

          // Determine content type from data URL
          const contentTypeMatch = fileData.match(/^data:([^;]+);/);
          const contentType = contentTypeMatch ? contentTypeMatch[1] : 'image/jpeg';

          const { data: uploadData, error: uploadError } = await adminSupabase.storage
            .from('foodchain-images')
            .upload(fileName, buffer, {
              contentType,
              upsert: false
            });

          if (uploadError) {
            console.error('Upload error:', uploadError);
            return respond({ error: uploadError.message }, 500);
          }

          const { data: { publicUrl } } = adminSupabase.storage
            .from('foodchain-images')
            .getPublicUrl(fileName);

          return respond({ data: { publicUrl } });
        } catch (err) {
          console.error('Image upload error:', err);
          return respond({ error: err.message }, 500);
        }
      }

      /* ==========================
         ADMIN MODERATION
      ========================== */

      case 'admin_getFlaggedUsers': {
        if (!user) return respond({ error: 'Not authenticated' }, 401);

        // Check if user is admin
        const { data: profile } = await supabase
          .from('profiles')
          .select('role')
          .eq('id', user.id)
          .single();

        if (profile?.role !== 'ADMIN') {
          return respond({ error: 'Unauthorized - Admin access required' }, 403);
        }

        const { data, error } = await supabase
          .from('profiles')
          .select('id, display_name, email, flagged, flag_reason, flagged_at, banned, ban_reason, banned_at')
          .or('flagged.eq.true,banned.eq.true')
          .order('flagged_at', { ascending: false, nullsFirst: false });

        if (error) return respond({ error: error.message }, 400);
        return respond({ data });
      }

      case 'admin_searchUser': {
        if (!user) return respond({ error: 'Not authenticated' }, 401);

        // Check if user is admin
        const { data: profile } = await supabase
          .from('profiles')
          .select('role')
          .eq('id', user.id)
          .single();

        if (profile?.role !== 'ADMIN') {
          return respond({ error: 'Unauthorized - Admin access required' }, 403);
        }

        const { searchTerm } = payload || {};
        if (!searchTerm) {
          return respond({ error: 'Missing searchTerm' }, 400);
        }

        const { data, error } = await supabase
          .from('profiles')
          .select('id, display_name, email, flagged, flag_reason, banned, ban_reason, username_approved')
          .or(`email.ilike.%${searchTerm}%,display_name.ilike.%${searchTerm}%`)
          .limit(20);

        if (error) return respond({ error: error.message }, 400);
        return respond({ data });
      }

      case 'admin_getAllUsers': {
        if (!user) return respond({ error: 'Not authenticated' }, 401);

        // Check if user is admin
        const { data: profile } = await supabase
          .from('profiles')
          .select('role')
          .eq('id', user.id)
          .single();

        if (profile?.role !== 'ADMIN') {
          return respond({ error: 'Unauthorized - Admin access required' }, 403);
        }

        // Get all users using adminSupabase to bypass RLS
        const { data, error } = await adminSupabase
          .from('profiles')
          .select('id, display_name, email')
          .order('display_name')
          .limit(1000);

        if (error) return respond({ error: error.message }, 400);
        return respond({ users: data });
      }

      case 'admin_getStats': {
        if (!user) return respond({ error: 'Not authenticated' }, 401);

        // Check if user is admin
        const { data: profile } = await supabase
          .from('profiles')
          .select('role')
          .eq('id', user.id)
          .single();

        if (profile?.role !== 'ADMIN') {
          return respond({ error: 'Unauthorized - Admin access required' }, 403);
        }

        // Get counts
        const { data: flaggedData } = await supabase
          .from('profiles')
          .select('id', { count: 'exact', head: true })
          .eq('flagged', true);

        const { data: bannedData } = await supabase
          .from('profiles')
          .select('id', { count: 'exact', head: true })
          .eq('banned', true);

        const { data: pendingData } = await supabase
          .from('profiles')
          .select('id', { count: 'exact', head: true })
          .eq('username_approved', false);

        const { data: totalData } = await supabase
          .from('profiles')
          .select('id', { count: 'exact', head: true });

        return respond({
          data: {
            flagged: flaggedData || 0,
            banned: bannedData || 0,
            pending_approval: pendingData || 0,
            total: totalData || 0
          }
        });
      }

      case 'admin_flagUser': {
        if (!user) return respond({ error: 'Not authenticated' }, 401);

        // Check if user is admin
        const { data: profile } = await supabase
          .from('profiles')
          .select('role')
          .eq('id', user.id)
          .single();

        if (profile?.role !== 'ADMIN') {
          return respond({ error: 'Unauthorized - Admin access required' }, 403);
        }

        const { email, reason } = payload || {};
        if (!email) {
          return respond({ error: 'Missing email' }, 400);
        }

        const { data, error } = await supabase
          .from('profiles')
          .update({
            flagged: true,
            username_approved: false,
            flag_reason: reason || 'Flagged by admin',
            flagged_at: new Date().toISOString()
          })
          .eq('email', email)
          .select();

        if (error) return respond({ error: error.message }, 400);
        return respond({ data: { success: true, updated: data } });
      }

      case 'admin_approveUser': {
        if (!user) return respond({ error: 'Not authenticated' }, 401);

        // Check if user is admin
        const { data: profile } = await supabase
          .from('profiles')
          .select('role')
          .eq('id', user.id)
          .single();

        if (profile?.role !== 'ADMIN') {
          return respond({ error: 'Unauthorized - Admin access required' }, 403);
        }

        const { email } = payload || {};
        if (!email) {
          return respond({ error: 'Missing email' }, 400);
        }

        const { data, error } = await supabase
          .from('profiles')
          .update({
            flagged: false,
            username_approved: true,
            flag_reason: null
          })
          .eq('email', email)
          .select();

        if (error) return respond({ error: error.message }, 400);
        return respond({ data: { success: true, updated: data } });
      }

      case 'admin_banUser': {
        if (!user) return respond({ error: 'Not authenticated' }, 401);

        // Check if user is admin
        const { data: profile } = await supabase
          .from('profiles')
          .select('role')
          .eq('id', user.id)
          .single();

        if (profile?.role !== 'ADMIN') {
          return respond({ error: 'Unauthorized - Admin access required' }, 403);
        }

        const { email, reason } = payload || {};
        if (!email) {
          return respond({ error: 'Missing email' }, 400);
        }

        const { data, error } = await supabase
          .from('profiles')
          .update({
            banned: true,
            ban_reason: reason || 'Banned by admin',
            banned_at: new Date().toISOString()
          })
          .eq('email', email)
          .select();

        if (error) return respond({ error: error.message }, 400);
        return respond({ data: { success: true, updated: data } });
      }

      case 'admin_unbanUser': {
        if (!user) return respond({ error: 'Not authenticated' }, 401);

        // Check if user is admin
        const { data: profile } = await supabase
          .from('profiles')
          .select('role')
          .eq('id', user.id)
          .single();

        if (profile?.role !== 'ADMIN') {
          return respond({ error: 'Unauthorized - Admin access required' }, 403);
        }

        const { email } = payload || {};
        if (!email) {
          return respond({ error: 'Missing email' }, 400);
        }

        const { data, error } = await supabase
          .from('profiles')
          .update({
            banned: false,
            flagged: false,
            username_approved: true,
            ban_reason: null,
            flag_reason: null
          })
          .eq('email', email)
          .select();

        if (error) return respond({ error: error.message }, 400);
        return respond({ data: { success: true, updated: data } });
      }

      case 'admin_forceRename': {
        if (!user) return respond({ error: 'Not authenticated' }, 401);

        // Check if user is admin
        const { data: profile } = await supabase
          .from('profiles')
          .select('role')
          .eq('id', user.id)
          .single();

        if (profile?.role !== 'ADMIN') {
          return respond({ error: 'Unauthorized - Admin access required' }, 403);
        }

        const { email } = payload || {};
        if (!email) {
          return respond({ error: 'Missing email' }, 400);
        }

        // Get user ID to create temporary name
        const { data: userProfile, error: fetchError } = await supabase
          .from('profiles')
          .select('id')
          .eq('email', email)
          .single();

        if (fetchError) return respond({ error: fetchError.message }, 400);

        const tempName = `User_${userProfile.id.substring(0, 8)}`;

        const { data, error } = await supabase
          .from('profiles')
          .update({
            display_name: tempName,
            flagged: true,
            username_approved: false,
            flag_reason: 'Username change required by admin',
            flagged_at: new Date().toISOString()
          })
          .eq('email', email)
          .select();

        if (error) return respond({ error: error.message }, 400);
        return respond({ data: { success: true, updated: data } });
      }

      case 'admin_giveCompensation': {
        if (!user) return respond({ error: 'Not authenticated' }, 401);

        // Check if user is admin
        const { data: adminProfile } = await supabase
          .from('profiles')
          .select('role, email, display_name')
          .eq('id', user.id)
          .single();

        if (adminProfile?.role !== 'ADMIN') {
          return respond({ error: 'Unauthorized - Admin access required' }, 403);
        }

        const { target_type, player_identifier, resources, reason } = payload || {};

        if (!target_type || !resources || !reason) {
          return respond({ error: 'Missing required fields' }, 400);
        }

        if (target_type === 'single') {
          // Single user compensation
          if (!player_identifier) {
            return respond({ error: 'Missing player identifier' }, 400);
          }

          // Find the target player from profiles
          const { data: targetPlayer, error: findError } = await adminSupabase
            .from('profiles')
            .select('id, email, display_name')
            .eq('id', player_identifier)
            .single();

          if (findError || !targetPlayer) {
            return respond({ error: `Player not found: ${player_identifier}` }, 404);
          }

          // Get their game progress from pbc_game_progress table
          const { data: gameProgress, error: progressError } = await adminSupabase
            .from('pbc_game_progress')
            .select('*')
            .eq('user_id', targetPlayer.id)
            .maybeSingle();

          // Parse current progress
          let progress = gameProgress || {};

          // Add compensation resources
          progress.sandwiches = (progress.sandwiches || 0) + (resources.sandwiches || 0);
          progress.royal_coins = (progress.royal_coins || 0) + (resources.royal_coins || 0);
          progress.peanuts = (progress.peanuts || 0) + (resources.peanuts || 0);
          progress.bananas = (progress.bananas || 0) + (resources.bananas || 0);
          progress.bread = (progress.bread || 0) + (resources.bread || 0);

          // Ensure user_id is set
          progress.user_id = targetPlayer.id;

          // Update or insert game progress
          const { error: updateError } = await adminSupabase
            .from('pbc_game_progress')
            .upsert(progress, { onConflict: 'user_id' });

          if (updateError) {
            return respond({ error: `Failed to update player: ${updateError.message}` }, 400);
          }

          // Log the compensation using adminSupabase
          const { error: logError } = await adminSupabase
            .from('compensation_log')
            .insert({
              admin_id: user.id,
              admin_email: adminProfile.email,
              admin_name: adminProfile.display_name,
              target_type: 'single',
              target_player_id: targetPlayer.id,
              target_player_email: targetPlayer.email,
              target_player_name: targetPlayer.display_name,
              sandwiches: resources.sandwiches || 0,
              royal_coins: resources.royal_coins || 0,
              peanuts: resources.peanuts || 0,
              bananas: resources.bananas || 0,
              bread: resources.bread || 0,
              reason: reason,
              created_at: new Date().toISOString()
            });

          if (logError) {
            console.error('Failed to log compensation:', logError);
            // Don't fail the request if logging fails
          }

          return respond({
            data: {
              success: true,
              player_name: targetPlayer.display_name,
              player_email: targetPlayer.email
            }
          });

        } else if (target_type === 'global') {
          // Global compensation - give to all active users

          // Get all users (exclude flagged/banned) using adminSupabase
          const { data: allPlayers, error: fetchError } = await adminSupabase
            .from('profiles')
            .select('id, email, display_name')
            .eq('flagged', false)
            .eq('banned', false);

          if (fetchError) {
            return respond({ error: `Failed to fetch players: ${fetchError.message}` }, 400);
          }

          // Get all game progress records
          const { data: allProgress, error: progressFetchError } = await adminSupabase
            .from('pbc_game_progress')
            .select('*');

          if (progressFetchError) {
            return respond({ error: `Failed to fetch game progress: ${progressFetchError.message}` }, 400);
          }

          // Create a map of user_id to progress
          const progressMap = {};
          (allProgress || []).forEach(p => {
            progressMap[p.user_id] = p;
          });

          let successCount = 0;
          const updates = [];

          for (const player of allPlayers) {
            let progress = progressMap[player.id] || { user_id: player.id };

            // Add compensation resources
            progress.sandwiches = (progress.sandwiches || 0) + (resources.sandwiches || 0);
            progress.royal_coins = (progress.royal_coins || 0) + (resources.royal_coins || 0);
            progress.peanuts = (progress.peanuts || 0) + (resources.peanuts || 0);
            progress.bananas = (progress.bananas || 0) + (resources.bananas || 0);
            progress.bread = (progress.bread || 0) + (resources.bread || 0);

            updates.push(progress);
          }

          // Batch update all players using adminSupabase
          const { error: batchError } = await adminSupabase
            .from('pbc_game_progress')
            .upsert(updates, { onConflict: 'user_id' });

          if (batchError) {
            return respond({ error: `Failed to update players: ${batchError.message}` }, 400);
          }

          successCount = updates.length;

          // Log the global compensation using adminSupabase
          const { error: logError } = await adminSupabase
            .from('compensation_log')
            .insert({
              admin_id: user.id,
              admin_email: adminProfile.email,
              admin_name: adminProfile.display_name,
              target_type: 'global',
              sandwiches: resources.sandwiches || 0,
              royal_coins: resources.royal_coins || 0,
              peanuts: resources.peanuts || 0,
              bananas: resources.bananas || 0,
              bread: resources.bread || 0,
              reason: reason,
              created_at: new Date().toISOString()
            });

          if (logError) {
            console.error('Failed to log global compensation:', logError);
            // Don't fail the request if logging fails
          }

          return respond({
            data: {
              success: true,
              affected_players: successCount
            }
          });

        } else {
          return respond({ error: 'Invalid target_type. Must be "single" or "global"' }, 400);
        }
      }

      case 'admin_getCompensationLog': {
        if (!user) return respond({ error: 'Not authenticated' }, 401);

        // Check if user is admin
        const { data: profile } = await supabase
          .from('profiles')
          .select('role')
          .eq('id', user.id)
          .single();

        if (profile?.role !== 'ADMIN') {
          return respond({ error: 'Unauthorized - Admin access required' }, 403);
        }

        const { limit } = payload || {};

        const { data, error } = await supabase
          .from('compensation_log')
          .select('*')
          .order('created_at', { ascending: false })
          .limit(limit || 20);

        if (error) return respond({ error: error.message }, 400);
        return respond({ data: { log: data } });
      }

      /* ==========================
         TACTICAL GRID COMBAT (TGC) GAME
      ========================== */

      case 'getTGCProgress': {
        if (!user) return respond({ error: 'Not authenticated' }, 401);

        const { data, error } = await supabase
          .from('tgc_game_progress')
          .select('*')
          .eq('user_id', user.id)
          .maybeSingle();

        if (error) return respond({ error: error.message }, 400);
        return respond({ data });
      }

      case 'saveTGCProgress': {
        if (!user) return respond({ error: 'Not authenticated' }, 401);

        const { progress } = payload || {};
        if (!progress) return respond({ error: 'No progress data provided' }, 400);

        // Check if user already has progress
        const { data: existing } = await supabase
          .from('tgc_game_progress')
          .select('id')
          .eq('user_id', user.id)
          .maybeSingle();

        let result;
        if (existing) {
          // Update existing progress
          const { data, error } = await supabase
            .from('tgc_game_progress')
            .update({
              total_games_played: progress.total_games_played ?? 0,
              total_victories: progress.total_victories ?? 0,
              total_defeats: progress.total_defeats ?? 0,
              total_score: progress.total_score ?? 0,
              highest_score: progress.highest_score ?? 0,
              games_as_survivors: progress.games_as_survivors ?? 0,
              games_as_ai: progress.games_as_ai ?? 0,
              wins_as_survivors: progress.wins_as_survivors ?? 0,
              wins_as_ai: progress.wins_as_ai ?? 0,
              total_hits: progress.total_hits ?? 0,
              total_misses: progress.total_misses ?? 0,
              total_units_destroyed: progress.total_units_destroyed ?? 0,
              total_scans_performed: progress.total_scans_performed ?? 0,
              total_ap_spent: progress.total_ap_spent ?? 0,
              scout_buggy_destroyed: progress.scout_buggy_destroyed ?? 0,
              heavy_tank_destroyed: progress.heavy_tank_destroyed ?? 0,
              artillery_truck_destroyed: progress.artillery_truck_destroyed ?? 0,
              gunship_heli_destroyed: progress.gunship_heli_destroyed ?? 0,
              hunter_drone_destroyed: progress.hunter_drone_destroyed ?? 0,
              war_walker_destroyed: progress.war_walker_destroyed ?? 0,
              assault_tank_destroyed: progress.assault_tank_destroyed ?? 0,
              mobile_fortress_destroyed: progress.mobile_fortress_destroyed ?? 0,
              achievements: progress.achievements ?? [],
              unlocked_content: progress.unlocked_content ?? [],
              current_game_state: progress.current_game_state ?? null,
              current_game_active: progress.current_game_active ?? false,
              current_game_started_at: progress.current_game_started_at ?? null,
              best_game_data: progress.best_game_data ?? null,
              win_streak: progress.win_streak ?? 0,
              current_streak: progress.current_streak ?? 0,
              preferred_faction: progress.preferred_faction ?? 'survivors',
              sound_enabled: progress.sound_enabled ?? true,
              difficulty_level: progress.difficulty_level ?? 'normal',
              last_played_at: progress.last_played_at ?? new Date().toISOString(),
              updated_at: new Date().toISOString()
            })
            .eq('user_id', user.id)
            .select()
            .single();

          if (error) return respond({ error: error.message }, 400);
          result = data;
        } else {
          // Insert new progress
          const { data, error } = await supabase
            .from('tgc_game_progress')
            .insert({
              user_id: user.id,
              total_games_played: progress.total_games_played ?? 0,
              total_victories: progress.total_victories ?? 0,
              total_defeats: progress.total_defeats ?? 0,
              total_score: progress.total_score ?? 0,
              highest_score: progress.highest_score ?? 0,
              games_as_survivors: progress.games_as_survivors ?? 0,
              games_as_ai: progress.games_as_ai ?? 0,
              wins_as_survivors: progress.wins_as_survivors ?? 0,
              wins_as_ai: progress.wins_as_ai ?? 0,
              total_hits: progress.total_hits ?? 0,
              total_misses: progress.total_misses ?? 0,
              total_units_destroyed: progress.total_units_destroyed ?? 0,
              total_scans_performed: progress.total_scans_performed ?? 0,
              total_ap_spent: progress.total_ap_spent ?? 0,
              scout_buggy_destroyed: progress.scout_buggy_destroyed ?? 0,
              heavy_tank_destroyed: progress.heavy_tank_destroyed ?? 0,
              artillery_truck_destroyed: progress.artillery_truck_destroyed ?? 0,
              gunship_heli_destroyed: progress.gunship_heli_destroyed ?? 0,
              hunter_drone_destroyed: progress.hunter_drone_destroyed ?? 0,
              war_walker_destroyed: progress.war_walker_destroyed ?? 0,
              assault_tank_destroyed: progress.assault_tank_destroyed ?? 0,
              mobile_fortress_destroyed: progress.mobile_fortress_destroyed ?? 0,
              achievements: progress.achievements ?? [],
              unlocked_content: progress.unlocked_content ?? [],
              current_game_state: progress.current_game_state ?? null,
              current_game_active: progress.current_game_active ?? false,
              current_game_started_at: progress.current_game_started_at ?? null,
              best_game_data: progress.best_game_data ?? null,
              win_streak: progress.win_streak ?? 0,
              current_streak: progress.current_streak ?? 0,
              preferred_faction: progress.preferred_faction ?? 'survivors',
              sound_enabled: progress.sound_enabled ?? true,
              difficulty_level: progress.difficulty_level ?? 'normal',
              last_played_at: progress.last_played_at ?? new Date().toISOString()
            })
            .select()
            .single();

          if (error) return respond({ error: error.message }, 400);
          result = data;
        }

        return respond({ data: result });
      }

      /* ==========================
         TGC MULTIPLAYER
      ========================== */

      case 'createTGCRoom': {
        if (!user) return respond({ error: 'Not authenticated' }, 401);

        const { room_type, host_faction } = payload || {};
        if (!room_type || !['friend', 'random'].includes(room_type)) {
          return respond({ error: 'Invalid room_type' }, 400);
        }

        const { data, error } = await supabase
          .from('tgc_game_rooms')
          .insert({
            host_user_id: user.id,
            room_type,
            host_faction: host_faction || 'survivors',
            room_status: 'waiting'
          })
          .select()
          .single();

        if (error) return respond({ error: error.message }, 400);
        return respond({ data });
      }

      case 'getTGCFriends': {
        if (!user) return respond({ error: 'Not authenticated' }, 401);

        // Get friends from awareness_friendships
        const { data: friendships, error: friendErr } = await supabase
          .from('awareness_friendships')
          .select('user2_id')
          .eq('user1_id', user.id);

        if (friendErr) return respond({ error: friendErr.message }, 400);

        const friendIds = (friendships || []).map(f => f.user2_id);
        if (friendIds.length === 0) return respond({ data: [] });

        // Get friend profiles
        const { data, error: profErr } = await supabase
          .from('profiles')
          .select('id, display_name, email')
          .in('id', friendIds);

        if (profErr) return respond({ error: profErr.message }, 400);
        return respond({ data: data || [] });
      }

      case 'inviteFriendToTGC': {
        if (!user) return respond({ error: 'Not authenticated' }, 401);

        const { friend_id, room_id } = payload || {};
        if (!friend_id || !room_id) {
          return respond({ error: 'Missing friend_id or room_id' }, 400);
        }

        // Verify room belongs to user
        const { data: room, error: roomErr } = await supabase
          .from('tgc_game_rooms')
          .select('*')
          .eq('id', room_id)
          .eq('host_user_id', user.id)
          .single();

        if (roomErr || !room) return respond({ error: 'Room not found or unauthorized' }, 404);

        // Create invite
        const { data: invite, error: inviteErr } = await supabase
          .from('tgc_room_invites')
          .insert({
            room_id,
            sender_id: user.id,
            recipient_id: friend_id,
            status: 'pending'
          })
          .select()
          .single();

        if (inviteErr) return respond({ error: inviteErr.message }, 400);
        return respond({ data: invite });
      }

      case 'getTGCInvites': {
        if (!user) return respond({ error: 'Not authenticated' }, 401);

        const { data: invites, error } = await supabase
          .from('tgc_room_invites')
          .select(`
            *,
            room:tgc_game_rooms(*),
            sender:profiles!tgc_room_invites_sender_id_fkey(id, display_name)
          `)
          .eq('recipient_id', user.id)
          .eq('status', 'pending')
          .gt('expires_at', new Date().toISOString());

        if (error) return respond({ error: error.message }, 400);
        return respond({ data: invites || [] });
      }

      case 'acceptTGCInvite': {
        if (!user) return respond({ error: 'Not authenticated' }, 401);

        const { invite_id } = payload || {};
        if (!invite_id) return respond({ error: 'Missing invite_id' }, 400);

        // Get invite
        const { data: invite, error: inviteErr } = await supabase
          .from('tgc_room_invites')
          .select('*')
          .eq('id', invite_id)
          .eq('recipient_id', user.id)
          .single();

        if (inviteErr || !invite) return respond({ error: 'Invite not found' }, 404);

        // Update room with guest
        const { data: room, error: roomErr } = await supabase
          .from('tgc_game_rooms')
          .update({
            guest_user_id: user.id,
            room_status: 'active',
            started_at: new Date().toISOString()
          })
          .eq('id', invite.room_id)
          .select()
          .single();

        if (roomErr) return respond({ error: roomErr.message }, 400);

        // Mark invite as accepted
        await supabase
          .from('tgc_room_invites')
          .update({ status: 'accepted' })
          .eq('id', invite_id);

        return respond({ data: room });
      }

      case 'joinRandomTGCGame': {
        if (!user) return respond({ error: 'Not authenticated' }, 401);

        // Look for waiting random rooms
        const { data: rooms, error: roomsErr } = await supabase
          .from('tgc_game_rooms')
          .select('*')
          .eq('room_type', 'random')
          .eq('room_status', 'waiting')
          .is('guest_user_id', null)
          .neq('host_user_id', user.id)
          .limit(1);

        if (roomsErr) return respond({ error: roomsErr.message }, 400);

        if (rooms && rooms.length > 0) {
          // Join existing room
          const { data: room, error: updateErr } = await supabase
            .from('tgc_game_rooms')
            .update({
              guest_user_id: user.id,
              room_status: 'active',
              started_at: new Date().toISOString()
            })
            .eq('id', rooms[0].id)
            .select()
            .single();

          if (updateErr) return respond({ error: updateErr.message }, 400);
          return respond({ data: { ...room, joined: true } });
        } else {
          // No rooms available - create one and wait
          const { data: newRoom, error: createErr } = await supabase
            .from('tgc_game_rooms')
            .insert({
              host_user_id: user.id,
              room_type: 'random',
              room_status: 'waiting'
            })
            .select()
            .single();

          if (createErr) return respond({ error: createErr.message }, 400);
          return respond({ data: { ...newRoom, joined: false, waiting: true } });
        }
      }

      case 'getTGCGameState': {
        if (!user) return respond({ error: 'Not authenticated' }, 401);

        const { room_id } = payload || {};
        if (!room_id) return respond({ error: 'Missing room_id' }, 400);

        const { data: room, error } = await supabase
          .from('tgc_game_rooms')
          .select(`
            *,
            host:profiles!tgc_game_rooms_host_user_id_fkey(id, display_name),
            guest:profiles!tgc_game_rooms_guest_user_id_fkey(id, display_name)
          `)
          .eq('id', room_id)
          .or(`host_user_id.eq.${user.id},guest_user_id.eq.${user.id}`)
          .single();

        if (error || !room) return respond({ error: 'Room not found or unauthorized' }, 404);
        return respond({ data: room });
      }

      case 'submitTGCTurn': {
        if (!user) return respond({ error: 'Not authenticated' }, 401);

        const { room_id, action_type, action_data, result_data, game_state } = payload || {};
        if (!room_id || !action_type) {
          return respond({ error: 'Missing required fields' }, 400);
        }

        // Get room
        const { data: room, error: roomErr } = await supabase
          .from('tgc_game_rooms')
          .select('*')
          .eq('id', room_id)
          .single();

        if (roomErr || !room) return respond({ error: 'Room not found' }, 404);

        // Verify it's player's turn
        if (room.current_turn_user_id && room.current_turn_user_id !== user.id) {
          return respond({ error: 'Not your turn' }, 403);
        }

        // Record turn
        await supabase
          .from('tgc_turn_history')
          .insert({
            room_id,
            user_id: user.id,
            turn_number: room.turn_number + 1,
            action_type,
            action_data,
            result_data
          });

        // Update room
        const nextTurnUserId = user.id === room.host_user_id ? room.guest_user_id : room.host_user_id;
        const { data: updatedRoom, error: updateErr } = await supabase
          .from('tgc_game_rooms')
          .update({
            current_turn_user_id: nextTurnUserId,
            turn_number: room.turn_number + 1,
            game_state: game_state || room.game_state
          })
          .eq('id', room_id)
          .select()
          .single();

        if (updateErr) return respond({ error: updateErr.message }, 400);
        return respond({ data: updatedRoom });
      }

      case 'endTGCGame': {
        if (!user) return respond({ error: 'Not authenticated' }, 401);

        const { room_id, winner_user_id, win_reason, host_score, guest_score } = payload || {};
        if (!room_id) return respond({ error: 'Missing room_id' }, 400);

        const { data: room, error } = await supabase
          .from('tgc_game_rooms')
          .update({
            room_status: 'completed',
            completed_at: new Date().toISOString(),
            winner_user_id,
            win_reason,
            host_score: host_score || 0,
            guest_score: guest_score || 0
          })
          .eq('id', room_id)
          .select()
          .single();

        if (error) return respond({ error: error.message }, 400);
        return respond({ data: room });
      }

      case 'leaveTGCRoom': {
        if (!user) return respond({ error: 'Not authenticated' }, 401);

        const { room_id } = payload || {};
        if (!room_id) return respond({ error: 'Missing room_id' }, 400);

        const { data: room, error } = await supabase
          .from('tgc_game_rooms')
          .update({
            room_status: 'abandoned',
            completed_at: new Date().toISOString()
          })
          .eq('id', room_id)
          .or(`host_user_id.eq.${user.id},guest_user_id.eq.${user.id}`)
          .select()
          .single();

        if (error) return respond({ error: error.message }, 400);
        return respond({ data: room });
      }

      /* ==========================
         ASCENT OF THE KNIGHT (ATK) GAME
      ========================== */
      case 'saveAtkGame': {
        if (!user) return respond({ error: 'Not authenticated' }, 401);

        const { gameState } = payload || {};
        if (!gameState) return respond({ error: 'Missing game state' }, 400);

        // Upsert game state (insert or update if exists)
        const { data, error } = await supabase
          .from('atk_game_state')
          .upsert({
            user_id: user.id,
            game_state: gameState
          }, {
            onConflict: 'user_id'
          })
          .select()
          .single();

        if (error) return respond({ error: error.message }, 400);
        return respond({ data });
      }

      case 'loadAtkGame': {
        if (!user) return respond({ error: 'Not authenticated' }, 401);

        const { data, error } = await supabase
          .from('atk_game_state')
          .select('*')
          .eq('user_id', user.id)
          .single();

        if (error) {
          // If no game state exists, return null instead of error
          if (error.code === 'PGRST116') {
            return respond({ data: null });
          }
          return respond({ error: error.message }, 400);
        }

        return respond({ data });
      }

      /* ==========================
         SUPPORT TICKETS SYSTEM
      ========================== */
      case 'createTicket': {
        if (!user) return respond({ error: 'Not authenticated' }, 401);

        const { title, description, category, source = 'website' } = payload || {};
        if (!title || !description || !category) {
          return respond({ error: 'Missing required fields' }, 400);
        }

        const { data, error } = await supabase
          .from('tickets')
          .insert({
            user_id: user.id,
            title,
            description,
            category,
            source,
            status: 'open'
          })
          .select()
          .single();

        if (error) return respond({ error: error.message }, 400);
        return respond({ data });
      }

      case 'listMyTickets': {
        if (!user) return respond({ error: 'Not authenticated' }, 401);

        const { data, error } = await supabase
          .from('tickets')
          .select('*')
          .eq('user_id', user.id)
          .order('created_at', { ascending: false });

        if (error) return respond({ error: error.message }, 400);
        return respond({ data });
      }

      case 'getTicket': {
        if (!user) return respond({ error: 'Not authenticated' }, 401);

        const { ticketId } = payload || {};
        if (!ticketId) return respond({ error: 'Missing ticketId' }, 400);

        const { data, error } = await supabase
          .from('tickets')
          .select('*')
          .eq('id', ticketId)
          .eq('user_id', user.id)
          .single();

        if (error) return respond({ error: error.message }, 400);
        return respond({ data });
      }

      case 'getTicketReplies': {
        if (!user) return respond({ error: 'Not authenticated' }, 401);

        const { ticketId } = payload || {};
        if (!ticketId) return respond({ error: 'Missing ticketId' }, 400);

        // Verify user owns the ticket or is admin
        const { data: ticket } = await supabase
          .from('tickets')
          .select('user_id')
          .eq('id', ticketId)
          .single();

        if (!ticket) return respond({ error: 'Ticket not found' }, 404);

        // Check if user is admin
        const permCheck = await checkPermission(adminSupabase, user.id, null, 'MODERATOR');
        const isTicketOwner = ticket.user_id === user.id;

        if (!isTicketOwner && !permCheck.authorized) {
          return respond({ error: 'Unauthorized' }, 403);
        }

        const { data, error } = await supabase
          .from('ticket_replies')
          .select('*')
          .eq('ticket_id', ticketId)
          .order('created_at', { ascending: true });

        if (error) return respond({ error: error.message }, 400);
        return respond({ data });
      }

      case 'adminListTickets': {
        if (!user) return respond({ error: 'Not authenticated' }, 401);

        // Check admin permission
        const permCheck = await checkPermission(adminSupabase, user.id, null, 'MODERATOR');
        if (!permCheck.authorized) {
          return respond({ error: 'Unauthorized - Admin access required' }, 403);
        }

        const { data, error } = await adminSupabase
          .from('tickets')
          .select('*')
          .order('created_at', { ascending: false });

        if (error) return respond({ error: error.message }, 400);
        return respond({ data });
      }

      case 'updateTicketStatus': {
        if (!user) return respond({ error: 'Not authenticated' }, 401);

        const { ticketId, status } = payload || {};
        if (!ticketId || !status) {
          return respond({ error: 'Missing required fields' }, 400);
        }

        // Validate status
        const validStatuses = ['open', 'in-progress', 'resolved'];
        if (!validStatuses.includes(status)) {
          return respond({ error: 'Invalid status' }, 400);
        }

        // Check admin permission
        const permCheck = await checkPermission(adminSupabase, user.id, null, 'MODERATOR');
        if (!permCheck.authorized) {
          return respond({ error: 'Unauthorized - Admin access required' }, 403);
        }

        const { data, error } = await adminSupabase
          .from('tickets')
          .update({ status })
          .eq('id', ticketId)
          .select()
          .single();

        if (error) return respond({ error: error.message }, 400);
        return respond({ data });
      }

      case 'addTicketReply': {
        if (!user) return respond({ error: 'Not authenticated' }, 401);

        const { ticketId, content, isAdmin = false } = payload || {};
        if (!ticketId || !content) {
          return respond({ error: 'Missing required fields' }, 400);
        }

        // If isAdmin is true, verify admin permission
        if (isAdmin) {
          const permCheck = await checkPermission(adminSupabase, user.id, null, 'MODERATOR');
          if (!permCheck.authorized) {
            return respond({ error: 'Unauthorized - Admin access required' }, 403);
          }

          const { data, error } = await adminSupabase
            .from('ticket_replies')
            .insert({
              ticket_id: ticketId,
              user_id: user.id,
              content,
              is_admin: true
            })
            .select()
            .single();

          if (error) return respond({ error: error.message }, 400);
          return respond({ data });
        } else {
          // Verify user owns the ticket
          const { data: ticket } = await supabase
            .from('tickets')
            .select('user_id')
            .eq('id', ticketId)
            .single();

          if (!ticket || ticket.user_id !== user.id) {
            return respond({ error: 'Ticket not found or unauthorized' }, 404);
          }

          const { data, error } = await supabase
            .from('ticket_replies')
            .insert({
              ticket_id: ticketId,
              user_id: user.id,
              content,
              is_admin: false
            })
            .select()
            .single();

          if (error) return respond({ error: error.message }, 400);
          return respond({ data });
        }
      }

      /* ==========================
         NEXUS - GENERIC DATABASE OPERATIONS
      ========================== */
      case 'query': {
        // Parse SQL query and convert to Supabase query builder
        // This is a simplified handler - raw SQL should use select/insert/update/delete instead
        const { query, params } = payload || {};
        if (!query) return respond({ error: 'Query is required' }, 400);

        try {
          // Handle UPDATE queries first (for markConversationAsRead, etc.)
          let updateMatch = query.match(/UPDATE\s+(\w+)\s+SET\s+(.+?)\s+WHERE\s+(.+)/i);
          if (updateMatch) {
            const tableName = updateMatch[1];
            const setClause = updateMatch[2];
            const whereClause = updateMatch[3];

            // Protected tables require authentication
            const protectedTables = ['user_tags', 'profiles', 'messages', 'matches', 'user_preferences', 'user_blocks', 'message_requests', 'profile_views', 'connection_patterns'];
            if (protectedTables.includes(tableName) && !user) {
              return respond({ error: 'Authentication required for UPDATE' }, 401);
            }

            // Parse SET clause (e.g., "read_at = NOW()")
            const updateData = {};
            const setParts = setClause.split(',').map(s => s.trim());
            for (const part of setParts) {
              const [column, value] = part.split('=').map(s => s.trim());
              if (value === 'NOW()') {
                updateData[column] = new Date().toISOString();
              } else if (value.startsWith('$')) {
                const paramIndex = parseInt(value.substring(1)) - 1;
                updateData[column] = params[paramIndex];
              } else {
                updateData[column] = value.replace(/^'|'$/g, '');
              }
            }

            // Parse WHERE clause with parameterized values
            let supaQuery = adminSupabase.from(tableName).update(updateData);

            // Handle recipient_id = $1 AND sender_id = $2 pattern
            const conditions = whereClause.split(/\s+AND\s+/i);
            for (const cond of conditions) {
              const match = cond.match(/(\w+)\s*=\s*\$(\d+)/);
              if (match) {
                const column = match[1];
                const paramIndex = parseInt(match[2]) - 1;
                supaQuery = supaQuery.eq(column, params[paramIndex]);
              }
              // Handle IS NULL
              const nullMatch = cond.match(/(\w+)\s+IS\s+NULL/i);
              if (nullMatch) {
                supaQuery = supaQuery.is(nullMatch[1], null);
              }
            }

            const { data, error } = await supaQuery;
            if (error) {
              console.error('UPDATE query error:', error);
              return respond({ error: error.message }, 500);
            }
            return respond({ data, success: true });
          }

          // Parse SELECT queries (handle basic SELECT and JOINs)
          // Use non-greedy match to properly capture fields before FROM
          let selectMatch = query.match(/SELECT\s+([\s\S]+?)\s+FROM\s+(\w+)(?:\s+(\w+))?/i);
          if (!selectMatch) {
            return respond({ error: 'Invalid query format - only SELECT and UPDATE supported' }, 400);
          }

          const selectFields = selectMatch[1].trim();
          const tableName = selectMatch[2];
          const tableAlias = selectMatch[3];

          // Protected tables require authentication
          const protectedTables = ['user_tags', 'profiles', 'messages', 'matches', 'user_preferences', 'user_blocks', 'message_requests', 'profile_views', 'connection_patterns'];
          if (protectedTables.includes(tableName) && !user) {
            return respond({ error: 'Authentication required' }, 401);
          }

          // Handle JOINs (for getUserTags query)
          const joinMatch = query.match(/JOIN\s+(\w+)\s+(\w+)\s+ON\s+([^W]+)WHERE/i);
          let supaQuery;

          if (joinMatch) {
            // This is a JOIN query (getUserTags case)
            const joinTable = joinMatch[1];
            const joinAlias = joinMatch[2];

            if (tableName === 'user_tags' && joinTable === 'tags') {
              // getUserTags specific query
              supaQuery = supabase
                .from('user_tags')
                .select('*, tags!inner(*)');
            } else {
              return respond({ error: 'Unsupported JOIN query' }, 400);
            }
          } else {
            // Simple SELECT without JOIN
            // Use adminSupabase for protected tables to bypass RLS (we've already verified auth above)
            const client = protectedTables.includes(tableName) ? adminSupabase : supabase;
            supaQuery = client.from(tableName).select('*');
          }

          // Parse WHERE clauses
          const whereMatch = query.match(/WHERE\s+(.+?)(\s+ORDER\s+BY|\s*$)/i);
          if (whereMatch) {
            const whereClauses = whereMatch[1];

            // Handle user_id = $1 (parameterized query)
            if (whereClauses.includes('user_id = $1') && params && params[0]) {
              supaQuery = supaQuery.eq('user_id', params[0]);
            }

            // Handle id = $1 (single ID)
            if (whereClauses.includes('id = $1') && params && params[0]) {
              supaQuery = supaQuery.eq('id', params[0]);
            }

            // Handle id = ANY($1) (array of IDs) - critical for getUserTags
            if (whereClauses.includes('id = ANY($1)') && params && params[0]) {
              const ids = Array.isArray(params[0]) ? params[0] : [params[0]];
              supaQuery = supaQuery.in('id', ids);
            }

            // Handle user_id = ANY($1) (array of user IDs) - for connection_patterns, user_tags bulk queries
            if (whereClauses.includes('user_id = ANY($1)') && params && params[0]) {
              const ids = Array.isArray(params[0]) ? params[0] : [params[0]];
              supaQuery = supaQuery.in('user_id', ids);
            }

            // Handle sender_id = $1 OR recipient_id = $1 (messages query)
            if (whereClauses.includes('sender_id = $1') && whereClauses.includes('recipient_id = $1') && params && params[0]) {
              supaQuery = supaQuery.or(`sender_id.eq.${params[0]},recipient_id.eq.${params[0]}`);
            }

            // Handle is_current = true
            if (whereClauses.includes('is_current = true')) {
              supaQuery = supaQuery.eq('is_current', true);
            }

            // Handle category filter
            const categoryMatch = whereClauses.match(/category\s*=\s*'([^']+)'/i);
            if (categoryMatch) {
              supaQuery = supaQuery.eq('category', categoryMatch[1]);
            }

            // Handle ILIKE search
            const ilikeMatch = whereClauses.match(/\(tag_name\s+ILIKE\s+'%([^']+)%'|definition\s+ILIKE\s+'%([^']+)%'\)/i);
            if (ilikeMatch) {
              const searchTerm = ilikeMatch[1] || ilikeMatch[2];
              supaQuery = supaQuery.or(`tag_name.ilike.%${searchTerm}%,definition.ilike.%${searchTerm}%`);
            }
          }

          // Handle ORDER BY
          const orderMatch = query.match(/ORDER\s+BY\s+(\w+)\s+(ASC|DESC)?/i);
          if (orderMatch) {
            const column = orderMatch[1];
            const direction = orderMatch[2]?.toLowerCase() === 'desc' ? { ascending: false } : { ascending: true };
            supaQuery = supaQuery.order(column, direction);
          }

          const { data, error } = await supaQuery;
          if (error) return respond({ error: error.message }, 400);
          return respond({ data });
        } catch (err) {
          console.error('Query error:', err);
          return respond({ error: err.message }, 500);
        }
      }

      case 'select': {
        // SELECT from table (public for tags, protected for user data)
        const { table, select, where, order, limit } = payload || {};
        if (!table) return respond({ error: 'Table is required' }, 400);

        // Protected tables require authentication
        const protectedTables = ['user_tags', 'profiles', 'messages', 'matches', 'user_preferences', 'user_blocks', 'message_requests', 'profile_views', 'connection_patterns'];
        if (protectedTables.includes(table) && !user) {
          return respond({ error: 'Authentication required' }, 401);
        }

        try {
          let query = supabase.from(table).select(select || '*');

          if (where) {
            Object.entries(where).forEach(([key, value]) => {
              query = query.eq(key, value);
            });
          }

          if (order) {
            query = query.order(order);
          }

          if (limit) {
            query = query.limit(limit);
          }

          const { data, error } = await query;
          if (error) return respond({ error: error.message }, 400);
          return respond({ data });
        } catch (err) {
          console.error('Select error:', err);
          return respond({ error: err.message }, 500);
        }
      }

      case 'insert': {
        // INSERT into table (requires auth)
        if (!user) return respond({ error: 'Authentication required' }, 401);

        const { table, data: insertData } = payload || {};
        if (!table || !insertData) {
          return respond({ error: 'Table and data are required' }, 400);
        }

        try {
          // Use adminSupabase to bypass RLS since we've already verified authentication
          // This is necessary because RLS auth.uid() doesn't work reliably with anon key + headers
          const { data, error } = await adminSupabase
            .from(table)
            .insert(insertData)
            .select()
            .single();

          if (error) return respond({ error: error.message }, 400);
          return respond({ data });
        } catch (err) {
          console.error('Insert error:', err);
          return respond({ error: err.message }, 500);
        }
      }

      case 'update': {
        // UPDATE table (requires auth)
        if (!user) return respond({ error: 'Authentication required' }, 401);

        const { table, data: updateData, where } = payload || {};
        if (!table || !updateData || !where) {
          return respond({ error: 'Table, data, and where are required' }, 400);
        }

        try {
          // Use adminSupabase to bypass RLS since we've already verified authentication
          let query = adminSupabase.from(table).update(updateData);

          Object.entries(where).forEach(([key, value]) => {
            query = query.eq(key, value);
          });

          const { data, error } = await query.select();
          if (error) return respond({ error: error.message }, 400);
          return respond({ data });
        } catch (err) {
          console.error('Update error:', err);
          return respond({ error: err.message }, 500);
        }
      }

      case 'delete': {
        // DELETE from table (requires auth)
        if (!user) return respond({ error: 'Authentication required' }, 401);

        const { table, where } = payload || {};
        if (!table || !where) {
          return respond({ error: 'Table and where are required' }, 400);
        }

        try {
          let query = supabase.from(table).delete();

          Object.entries(where).forEach(([key, value]) => {
            query = query.eq(key, value);
          });

          const { data, error } = await query;
          if (error) return respond({ error: error.message }, 400);
          return respond({ data });
        } catch (err) {
          console.error('Delete error:', err);
          return respond({ error: err.message }, 500);
        }
      }

      /* ==========================
         RPG GAME ACTIONS
      ========================== */

      case 'getRPGCharacters': {
        if (!user) return respond({ error: 'Not authenticated' }, 401);

        const { data, error } = await supabase
          .from('rpg_characters')
          .select('*')
          .eq('user_id', user.id)
          .order('character_slot', { ascending: true });

        if (error) return respond({ error: error.message }, 400);
        return respond({ data });
      }

      case 'getRPGCharacter': {
        if (!user) return respond({ error: 'Not authenticated' }, 401);

        const { character_slot } = payload || {};

        let query = supabase
          .from('rpg_characters')
          .select('*')
          .eq('user_id', user.id);

        if (character_slot) {
          query = query.eq('character_slot', character_slot);
        }

        const { data, error } = await query.maybeSingle();

        if (error) return respond({ error: error.message }, 400);

        // Also fetch universal gems from profiles
        if (data) {
          const { data: profile } = await supabase
            .from('profiles')
            .select('gems')
            .eq('id', user.id)
            .single();

          // Use profiles.gems as the authoritative source (fall back to legacy supporter_gems)
          data.universal_gems = profile?.gems || data.supporter_gems || 0;
        }

        return respond({ data });
      }

      case 'createRPGCharacter': {
        if (!user) return respond({ error: 'Not authenticated' }, 401);

        const {
          character_name,
          party_name,
          character_class,
          character_slot,
          strength,
          intelligence,
          dexterity,
          constitution,
          wisdom,
          max_health,
          health,
          max_mana,
          mana
        } = payload || {};

        const { data, error } = await supabase
          .from('rpg_characters')
          .insert({
            user_id: user.id,
            character_name,
            party_name,
            character_class,
            character_slot: character_slot || 1,
            strength,
            intelligence,
            dexterity,
            constitution,
            wisdom,
            max_health,
            health,
            max_mana,
            mana
          })
          .select()
          .single();

        if (error) return respond({ error: error.message }, 400);
        return respond({ data });
      }

      case 'updateRPGCharacter': {
        if (!user) return respond({ error: 'Not authenticated' }, 401);

        const updates = payload || {};
        const { character_slot } = updates;
        const gemUpdate = updates.supporter_gems; // Capture gem update before delete
        delete updates.user_id; // Prevent user_id modification
        delete updates.character_slot; // Don't update slot in the update

        let query = supabase
          .from('rpg_characters')
          .update({ ...updates, updated_at: new Date().toISOString() })
          .eq('user_id', user.id);

        if (character_slot) {
          query = query.eq('character_slot', character_slot);
        }

        const { data, error } = await query.select().single();

        if (error) return respond({ error: error.message }, 400);

        // Sync supporter_gems changes to profiles.gems (universal gems)
        if (gemUpdate !== undefined) {
          // Get current gems to track spending
          const { data: profile } = await supabase
            .from('profiles')
            .select('gems, gems_spent')
            .eq('id', user.id)
            .single();

          const currentGems = profile?.gems || 0;
          const spent = currentGems - gemUpdate;

          const profileUpdate = { gems: gemUpdate };
          if (spent > 0) {
            profileUpdate.gems_spent = (profile?.gems_spent || 0) + spent;
          }

          await supabase
            .from('profiles')
            .update(profileUpdate)
            .eq('id', user.id);
        }

        return respond({ data });
      }

      case 'deleteRPGCharacter': {
        if (!user) return respond({ error: 'Not authenticated' }, 401);

        const { character_slot } = payload || {};

        if (!character_slot) {
          return respond({ error: 'character_slot required' }, 400);
        }

        // Delete character and all associated data
        const { error: charError } = await supabase
          .from('rpg_characters')
          .delete()
          .eq('user_id', user.id)
          .eq('character_slot', character_slot);

        if (charError) return respond({ error: charError.message }, 400);

        // Delete inventory
        await supabase
          .from('rpg_inventory')
          .delete()
          .eq('user_id', user.id)
          .eq('character_slot', character_slot);

        // Delete equipment
        await supabase
          .from('rpg_equipment')
          .delete()
          .eq('user_id', user.id)
          .eq('character_slot', character_slot);

        return respond({ data: { success: true } });
      }

      case 'getRPGInventory': {
        if (!user) return respond({ error: 'Not authenticated' }, 401);

        const { character_slot } = payload || {};

        let query = supabase
          .from('rpg_inventory')
          .select('*')
          .eq('user_id', user.id)
          .gt('quantity', 0);

        if (character_slot) {
          query = query.eq('character_slot', character_slot);
        }

        query = query.order('created_at', { ascending: false });

        const { data, error } = await query;

        if (error) return respond({ error: error.message }, 400);
        return respond({ data });
      }

      case 'addRPGInventoryItem': {
        if (!user) return respond({ error: 'Not authenticated' }, 401);

        const {
          item_name,
          item_type,
          item_rarity,
          quantity,
          stats,
          description,
          can_stack,
          character_slot,
          allowed_classes,
          weapon_hand,
          item_subtype
        } = payload || {};

        const slot = character_slot || 1;

        // Check if item exists and is stackable
        if (can_stack) {
          const { data: existing } = await supabase
            .from('rpg_inventory')
            .select('*')
            .eq('user_id', user.id)
            .eq('item_name', item_name)
            .eq('character_slot', slot)
            .maybeSingle();

          if (existing) {
            // Update existing item
            const { data, error } = await supabase
              .from('rpg_inventory')
              .update({ quantity: existing.quantity + (quantity || 1) })
              .eq('id', existing.id)
              .select()
              .single();

            if (error) return respond({ error: error.message }, 400);
            return respond({ data });
          }
        }

        // Insert new item
        const { data, error } = await supabase
          .from('rpg_inventory')
          .insert({
            user_id: user.id,
            character_slot: slot,
            item_name,
            item_type,
            item_rarity: item_rarity || 'common',
            quantity: quantity || 1,
            stats: stats || {},
            description,
            can_stack: can_stack || false,
            allowed_classes: allowed_classes || null,
            weapon_hand: weapon_hand || null,
            item_subtype: item_subtype || null
          })
          .select()
          .single();

        if (error) return respond({ error: error.message }, 400);
        return respond({ data });
      }

      case 'updateRPGInventoryItem': {
        if (!user) return respond({ error: 'Not authenticated' }, 401);

        const { item_id, updates } = payload || {};
        if (!item_id) return respond({ error: 'item_id required' }, 400);

        const { data, error } = await supabase
          .from('rpg_inventory')
          .update(updates)
          .eq('id', item_id)
          .eq('user_id', user.id)
          .select()
          .single();

        if (error) return respond({ error: error.message }, 400);
        return respond({ data });
      }

      case 'deleteRPGInventoryItem': {
        if (!user) return respond({ error: 'Not authenticated' }, 401);

        const { item_id } = payload || {};
        if (!item_id) return respond({ error: 'item_id required' }, 400);

        const { data, error } = await supabase
          .from('rpg_inventory')
          .delete()
          .eq('id', item_id)
          .eq('user_id', user.id);

        if (error) return respond({ error: error.message }, 400);
        return respond({ data });
      }

      case 'getRPGMonsters': {
        // Public read access - monsters are public data
        const { min_level, max_level, limit } = payload || {};

        let query = supabase
          .from('rpg_monsters')
          .select('*');

        if (min_level) query = query.gte('monster_level', min_level);
        if (max_level) query = query.lte('monster_level', max_level);
        if (limit) query = query.limit(limit);

        query = query.order('monster_level', { ascending: true });

        const { data, error } = await query;

        if (error) return respond({ error: error.message }, 400);
        return respond({ data });
      }

      case 'recordRPGEncounter': {
        if (!user) return respond({ error: 'Not authenticated' }, 401);

        const {
          monster_id,
          monster_name,
          monster_level,
          result,
          gold_earned,
          experience_earned,
          items_earned,
          damage_dealt,
          damage_taken,
          turns_taken
        } = payload || {};

        const { data, error } = await supabase
          .from('rpg_encounters')
          .insert({
            user_id: user.id,
            monster_id,
            monster_name,
            monster_level,
            result,
            gold_earned: gold_earned || 0,
            experience_earned: experience_earned || 0,
            items_earned: items_earned || [],
            damage_dealt: damage_dealt || 0,
            damage_taken: damage_taken || 0,
            turns_taken: turns_taken || 0
          })
          .select()
          .single();

        if (error) return respond({ error: error.message }, 400);
        return respond({ data });
      }

      case 'getRPGEncounters': {
        if (!user) return respond({ error: 'Not authenticated' }, 401);

        const { limit } = payload || {};

        let query = supabase
          .from('rpg_encounters')
          .select('*')
          .eq('user_id', user.id)
          .order('created_at', { ascending: false });

        if (limit) query = query.limit(limit);

        const { data, error } = await query;

        if (error) return respond({ error: error.message }, 400);
        return respond({ data });
      }

      case 'getRPGRecipes': {
        if (!user) return respond({ error: 'Not authenticated' }, 401);

        const { data, error } = await supabase
          .from('rpg_crafting_recipes')
          .select('*')
          .order('requires_level', { ascending: true });

        if (error) return respond({ error: error.message }, 400);
        return respond({ data });
      }

      case 'getRPGUserRecipes': {
        if (!user) return respond({ error: 'Not authenticated' }, 401);

        const { data, error } = await supabase
          .from('rpg_user_recipes')
          .select(`
            *,
            recipe:rpg_crafting_recipes(*)
          `)
          .eq('user_id', user.id);

        if (error) return respond({ error: error.message }, 400);
        return respond({ data });
      }

      case 'discoverRPGRecipe': {
        if (!user) return respond({ error: 'Not authenticated' }, 401);

        const { recipe_id } = payload || {};
        if (!recipe_id) return respond({ error: 'recipe_id required' }, 400);

        // Use upsert to handle duplicates
        const { data, error } = await supabase
          .from('rpg_user_recipes')
          .upsert(
            {
              user_id: user.id,
              recipe_id,
              times_crafted: 1
            },
            {
              onConflict: 'user_id,recipe_id',
              ignoreDuplicates: false
            }
          )
          .select()
          .single();

        if (error) {
          // If it's a duplicate, increment times_crafted
          const { data: updateData, error: updateError } = await supabase
            .from('rpg_user_recipes')
            .update({ times_crafted: supabase.raw('times_crafted + 1') })
            .eq('user_id', user.id)
            .eq('recipe_id', recipe_id)
            .select()
            .single();

          if (updateError) return respond({ error: updateError.message }, 400);
          return respond({ data: updateData });
        }

        return respond({ data });
      }

      case 'getRPGEquipment': {
        if (!user) return respond({ error: 'Not authenticated' }, 401);

        const { character_slot } = payload || {};

        let query = supabase
          .from('rpg_equipment_slots')
          .select('*')
          .eq('user_id', user.id);

        if (character_slot) {
          query = query.eq('character_slot', character_slot);
        }

        const { data, error } = await query.maybeSingle();

        if (error) return respond({ error: error.message }, 400);
        return respond({ data });
      }

      case 'updateRPGEquipment': {
        if (!user) return respond({ error: 'Not authenticated' }, 401);

        const updates = payload || {};
        const { character_slot } = updates;
        const slot = character_slot || 1;

        delete updates.user_id; // Prevent user_id modification
        delete updates.character_slot; // Don't include in updates

        // Check if equipment slots exist
        const { data: existing } = await supabase
          .from('rpg_equipment_slots')
          .select('*')
          .eq('user_id', user.id)
          .eq('character_slot', slot)
          .maybeSingle();

        if (!existing) {
          // Create equipment slots
          const { data, error } = await supabase
            .from('rpg_equipment_slots')
            .insert({
              user_id: user.id,
              character_slot: slot,
              ...updates,
              updated_at: new Date().toISOString()
            })
            .select()
            .single();

          if (error) return respond({ error: error.message }, 400);
          return respond({ data });
        }

        // Update existing equipment slots
        const { data, error } = await supabase
          .from('rpg_equipment_slots')
          .update({ ...updates, updated_at: new Date().toISOString() })
          .eq('user_id', user.id)
          .eq('character_slot', slot)
          .select()
          .single();

        if (error) return respond({ error: error.message }, 400);
        return respond({ data });
      }

      case 'getLeaderboard': {
        const { sort_by } = payload || {};

        // ALWAYS get all characters grouped by user - use adminSupabase to bypass RLS for global leaderboard
        const { data: allCharacters, error } = await adminSupabase
          .from('rpg_characters')
          .select('user_id, party_name, character_class, character_slot, level, gold')
          .order('user_id');

        if (error) return respond({ error: error.message }, 400);

        // Get supporter status for all users
        const { data: profiles, error: profileError } = await adminSupabase
          .from('profiles')
          .select('id, is_supporter, supporter_tier');

        if (profileError) return respond({ error: profileError.message }, 400);

        // Create a map of user_id -> supporter info
        const supporterMap = {};
        profiles.forEach(profile => {
          supporterMap[profile.id] = {
            is_supporter: profile.is_supporter || false,
            supporter_tier: profile.supporter_tier
          };
        });

        // Group by user_id and aggregate
        const grouped = {};
        allCharacters.forEach(char => {
          if (!grouped[char.user_id]) {
            const supporterInfo = supporterMap[char.user_id] || { is_supporter: false, supporter_tier: null };
            grouped[char.user_id] = {
              user_id: char.user_id,
              party_name: char.party_name,
              is_supporter: supporterInfo.is_supporter,
              supporter_tier: supporterInfo.supporter_tier,
              characters: [],
              total_level: 0,
              total_gold: 0
            };
          }
          grouped[char.user_id].characters.push({
            character_slot: char.character_slot,
            character_class: char.character_class,
            level: char.level,
            gold: char.gold
          });
          grouped[char.user_id].total_level += char.level || 0;
          grouped[char.user_id].total_gold += char.gold || 0;
        });

        // Convert to array
        let aggregated = Object.values(grouped);

        // Filter by class if needed
        if (sort_by && sort_by !== 'level' && sort_by !== 'coins') {
          // Class filter - only show users who have this class, sort by that character's level
          aggregated = aggregated.filter(entry => {
            return entry.characters.some(c => c.character_class === sort_by);
          });

          // Calculate sort value based on the specific class
          aggregated.forEach(entry => {
            const classChar = entry.characters.find(c => c.character_class === sort_by);
            entry.class_level = classChar ? classChar.level : 0;
            entry.class_gold = classChar ? classChar.gold : 0;
          });

          // Sort by that class's level
          aggregated.sort((a, b) => b.class_level - a.class_level);
        } else {
          // Sort by total levels or total coins
          if (sort_by === 'coins') {
            aggregated.sort((a, b) => b.total_gold - a.total_gold);
          } else {
            aggregated.sort((a, b) => b.total_level - a.total_level);
          }
        }

        return respond({ data: aggregated });
      }

      /* ==========================
         ACHIEVEMENTS
      ========================== */
      case 'saveAchievement': {
        if (!user) return respond({ error: 'Not authenticated' }, 401);

        const { achievement_id, unlocked_at } = payload || {};

        if (!achievement_id) {
          return respond({ error: 'achievement_id is required' }, 400);
        }

        // Check if achievement already exists
        const { data: existing, error: checkError } = await supabase
          .from('rpg_achievements')
          .select('id')
          .eq('user_id', user.id)
          .eq('achievement_id', achievement_id)
          .maybeSingle();

        if (checkError && checkError.code !== 'PGRST116') {
          return respond({ error: checkError.message }, 400);
        }

        // If already exists, skip
        if (existing) {
          return respond({ data: existing });
        }

        // Insert new achievement
        const { data, error } = await supabase
          .from('rpg_achievements')
          .insert({
            user_id: user.id,
            achievement_id,
            unlocked_at: unlocked_at || new Date().toISOString()
          })
          .select()
          .single();

        if (error) return respond({ error: error.message }, 400);
        return respond({ data });
      }

      case 'getAchievements': {
        if (!user) return respond({ error: 'Not authenticated' }, 401);

        const { data, error } = await supabase
          .from('rpg_achievements')
          .select('achievement_id, unlocked_at')
          .eq('user_id', user.id);

        if (error) return respond({ error: error.message }, 400);

        // Convert to object format { achievementId: { unlocked: timestamp, seen: true } }
        const achievementsObj = {};
        data.forEach(ach => {
          achievementsObj[ach.achievement_id] = {
            unlocked: new Date(ach.unlocked_at).getTime(),
            seen: true
          };
        });

        return respond({ data: achievementsObj });
      }

      /* ==========================
         BUG REPORTS
      ========================== */
      case 'submitBugReport': {
        if (!user) return respond({ error: 'Not authenticated' }, 401);

        const { title, description, priority, category, user_agent, page_url, character_slot, character_level } = payload || {};

        if (!title || !description) {
          return respond({ error: 'Title and description are required' }, 400);
        }

        // Use adminSupabase to bypass RLS (we've already verified user auth)
        const { data, error } = await adminSupabase
          .from('bug_reports')
          .insert({
            user_id: user.id,
            title,
            description,
            priority: priority || 'medium',
            category: category || 'general',
            user_agent,
            page_url,
            character_slot,
            character_level,
            status: 'open'
          })
          .select()
          .single();

        if (error) return respond({ error: error.message }, 400);
        return respond({ data, message: 'Bug report submitted successfully' });
      }

      case 'getBugReports': {
        if (!user) return respond({ error: 'Not authenticated' }, 401);

        // Check if user is admin/moderator
        const { data: profile } = await adminSupabase
          .from('profiles')
          .select('role')
          .eq('id', user.id)
          .single();

        const isAdmin = profile && ['ADMIN', 'OWNER', 'MODERATOR'].includes(profile.role);
        const { status, limit = 50, offset = 0 } = payload || {};

        // Use adminSupabase to bypass RLS (we handle permissions manually)
        let query = adminSupabase
          .from('bug_reports')
          .select('*');

        // Non-admins can only see their own reports
        if (!isAdmin) {
          query = query.eq('user_id', user.id);
        }

        // Filter by status if provided
        if (status) {
          query = query.eq('status', status);
        }

        query = query
          .order('created_at', { ascending: false })
          .range(offset, offset + limit - 1);

        const { data: bugReports, error } = await query;

        if (error) return respond({ error: error.message }, 400);

        // If admin, fetch user profiles for all reports
        if (isAdmin && bugReports && bugReports.length > 0) {
          const userIds = [...new Set(bugReports.map(r => r.user_id))];
          const { data: profiles } = await adminSupabase
            .from('profiles')
            .select('id, username, email')
            .in('id', userIds);

          // Map profiles to bug reports
          const profileMap = {};
          if (profiles) {
            profiles.forEach(p => {
              profileMap[p.id] = p;
            });
          }

          // Add profile data to bug reports
          bugReports.forEach(report => {
            report.user_profile = profileMap[report.user_id] || null;
          });
        }

        return respond({ data: { reports: bugReports, isAdmin } });
      }

      case 'updateBugReportStatus': {
        if (!user) return respond({ error: 'Not authenticated' }, 401);

        // Check if user is admin/moderator
        const perm = await checkPermission(adminSupabase, user.id, null, 'MODERATOR');
        if (!perm.authorized) {
          return respond({ error: perm.reason }, 403);
        }

        const { report_id, status, priority, admin_notes, assigned_to } = payload || {};

        if (!report_id) {
          return respond({ error: 'report_id is required' }, 400);
        }

        const updates = {};
        if (status) updates.status = status;
        if (priority) updates.priority = priority;
        if (admin_notes !== undefined) updates.admin_notes = admin_notes;
        if (assigned_to !== undefined) updates.assigned_to = assigned_to;

        // Use adminSupabase to bypass RLS
        const { data, error } = await adminSupabase
          .from('bug_reports')
          .update(updates)
          .eq('id', report_id)
          .select()
          .single();

        if (error) return respond({ error: error.message }, 400);
        return respond({ data, message: 'Bug report updated successfully' });
      }

      case 'deleteBugReport': {
        if (!user) return respond({ error: 'Not authenticated' }, 401);

        // Check if user is admin/owner
        const perm = await checkPermission(adminSupabase, user.id, null, 'ADMIN');
        if (!perm.authorized) {
          return respond({ error: perm.reason }, 403);
        }

        const { report_id } = payload || {};

        if (!report_id) {
          return respond({ error: 'report_id is required' }, 400);
        }

        // Use adminSupabase to bypass RLS
        const { error } = await adminSupabase
          .from('bug_reports')
          .delete()
          .eq('id', report_id);

        if (error) return respond({ error: error.message }, 400);
        return respond({ message: 'Bug report deleted successfully' });
      }

      /* ==========================
         MTG (MEDIEVAL TRADING GAME) BUG REPORTS
      ========================== */
      case 'mtgRegister': {
        const { email, username, nickname, password } = payload || {};

        if (!email || !username || !password) {
          return respond({ error: 'Email, username, and password are required' }, 400);
        }

        const adminSupabase = createClient(supabaseUrl, supabaseServiceKey);

        // Register with Supabase Auth
        const { data: authData, error: authError } = await adminSupabase.auth.admin.createUser({
          email: email.toLowerCase(),
          password: password,
          email_confirm: true,
          user_metadata: {
            username: username,
            nickname: nickname || username
          }
        });

        if (authError) {
          return respond({ error: authError.message }, 400);
        }

        // mtg_users entry is created automatically by trigger
        // Fetch the created mtg_users entry
        const { data: mtgUser, error: mtgError } = await adminSupabase
          .from('mtg_users')
          .select('*')
          .eq('id', authData.user.id)
          .single();

        if (mtgError) {
          return respond({ error: 'User created but profile fetch failed: ' + mtgError.message }, 400);
        }

        return respond({ data: { user: authData.user, mtgUser }, message: 'Registration successful' });
      }

      case 'mtgLogin': {
        const { email, password } = payload || {};

        if (!email || !password) {
          return respond({ error: 'Email and password are required' }, 400);
        }

        const adminSupabase = createClient(supabaseUrl, supabaseServiceKey);

        // Login with Supabase Auth
        const { data: authData, error: authError } = await adminSupabase.auth.signInWithPassword({
          email: email.toLowerCase(),
          password: password
        });

        if (authError) {
          console.error('MTG Login auth error:', authError);
          return respond({ error: 'Auth failed: ' + authError.message, debug: authError }, 401);
        }

        console.log('MTG Login auth successful for user:', authData.user.id);

        // Get MTG user profile
        let { data: mtgUser, error: mtgError } = await adminSupabase
          .from('mtg_users')
          .select('*')
          .eq('id', authData.user.id)
          .single();

        // If profile doesn't exist, create it
        if (mtgError || !mtgUser) {
          console.log('MTG user profile not found, creating...', mtgError?.message);

          const username = authData.user.user_metadata?.username ||
                          authData.user.user_metadata?.nickname ||
                          authData.user.email.split('@')[0];

          const { data: newProfile, error: createError } = await adminSupabase
            .from('mtg_users')
            .insert({
              id: authData.user.id,
              username: username,
              nickname: authData.user.user_metadata?.nickname || username,
              role: 'USER'
            })
            .select()
            .single();

          if (createError) {
            console.error('Failed to create MTG profile:', createError);
            return respond({ error: 'Failed to create user profile: ' + createError.message }, 400);
          }

          mtgUser = newProfile;
          console.log('MTG user profile created:', mtgUser);
        }

        // Update last login
        await adminSupabase
          .from('mtg_users')
          .update({ last_login: new Date().toISOString() })
          .eq('id', mtgUser.id);

        return respond({ data: { session: authData.session, user: authData.user, mtgUser }, message: 'Login successful' });
      }

      case 'mtgSubmitBugReport': {
        const { mtg_user_id, game_name, title, description, priority, category, user_agent, page_url, game_version } = payload || {};

        if (!mtg_user_id || !title || !description) {
          return respond({ error: 'User ID, title, and description are required' }, 400);
        }

        const adminSupabase = createClient(supabaseUrl, supabaseServiceKey);

        const { data, error } = await adminSupabase
          .from('mtg_bug_reports')
          .insert({
            user_id: mtg_user_id,
            game_name: game_name || 'Medieval Trading Game',
            title,
            description,
            priority: priority || 'medium',
            category: category || 'general',
            user_agent,
            page_url,
            game_version,
            status: 'open'
          })
          .select()
          .single();

        if (error) {
          console.error('MTG Submit Bug Report error:', error);
          return respond({ error: error.message }, 400);
        }
        return respond({ data, message: 'Bug report submitted successfully' });
      }

      case 'submitRPGBugReport': {
        // Submit bug report from RPG game using RPG auth token
        const { title, description, priority, category, character_name, character_class, character_level, game_version } = payload || {};

        if (!title || !description) {
          return respond({ error: 'Title and description are required' }, 400);
        }

        // Get user from authorization header (RPG auth token)
        const authUser = event.headers.authorization?.replace('Bearer ', '');
        if (!authUser) {
          return respond({ error: 'Authentication required' }, 401);
        }

        const adminSupabase = createClient(supabaseUrl, supabaseServiceKey);

        // Verify the token and get user ID
        const { data: { user }, error: authError } = await adminSupabase.auth.getUser(authUser);
        if (authError || !user) {
          console.error('RPG Bug Report auth error:', authError);
          return respond({ error: 'Invalid authentication token' }, 401);
        }

        // Check if user exists in mtg_users, create if not
        let { data: mtgUser } = await adminSupabase
          .from('mtg_users')
          .select('*')
          .eq('id', user.id)
          .single();

        if (!mtgUser) {
          console.log('Creating mtg_users profile for RPG user:', user.id);

          // Get display name from rpg_characters if available
          let username = user.email?.split('@')[0] || 'RPG Player';
          let nickname = username;

          if (character_name) {
            nickname = character_name;
          }

          const { data: newProfile, error: createError } = await adminSupabase
            .from('mtg_users')
            .insert({
              id: user.id,
              username: username,
              nickname: nickname,
              role: 'USER'
            })
            .select()
            .single();

          if (createError) {
            console.error('Failed to create MTG profile for RPG user:', createError);
            return respond({ error: 'Failed to create user profile: ' + createError.message }, 400);
          }

          mtgUser = newProfile;
        }

        // Build full description with character info
        let fullDescription = description;
        if (character_name || character_class || character_level) {
          const charInfo = [];
          if (character_name) charInfo.push(`Character: ${character_name}`);
          if (character_class) charInfo.push(`Class: ${character_class}`);
          if (character_level) charInfo.push(`Level: ${character_level}`);
          fullDescription = `**${charInfo.join(' | ')}**\n\n${description}`;
        }

        // Submit bug report
        const { data, error } = await adminSupabase
          .from('mtg_bug_reports')
          .insert({
            user_id: mtgUser.id,
            game_name: 'Realm of Adventure',
            title,
            description: fullDescription,
            priority: priority || 'medium',
            category: category || 'general',
            user_agent: event.headers['user-agent'],
            page_url: 'https://eztunes.xyz/rpg/',
            game_version: game_version || '1.0.0',
            status: 'open'
          })
          .select()
          .single();

        if (error) {
          console.error('RPG Submit Bug Report error:', error);
          return respond({ error: error.message }, 400);
        }

        return respond({ data, message: 'Bug report submitted successfully! Thank you for your feedback.' });
      }

      case 'getRPGBugReports': {
        // Get bug reports for RPG game using RPG auth token
        const { status } = payload || {};

        // Get user from authorization header (RPG auth token)
        const authUser = event.headers.authorization?.replace('Bearer ', '');
        if (!authUser) {
          return respond({ error: 'Authentication required' }, 401);
        }

        const adminSupabase = createClient(supabaseUrl, supabaseServiceKey);

        // Verify the token and get user ID
        const { data: { user }, error: authError } = await adminSupabase.auth.getUser(authUser);
        if (authError || !user) {
          console.error('RPG Bug Reports auth error:', authError);
          return respond({ error: 'Invalid authentication token' }, 401);
        }

        // Get user's role from mtg_users
        let { data: mtgUser } = await adminSupabase
          .from('mtg_users')
          .select('role')
          .eq('id', user.id)
          .single();

        const isAdmin = mtgUser && ['ADMIN', 'GOD'].includes(mtgUser.role);

        // Build query
        let query = adminSupabase
          .from('mtg_bug_reports')
          .select('*')
          .eq('game_name', 'Realm of Adventure');

        // Non-admins can only see their own reports
        if (!isAdmin) {
          query = query.eq('user_id', user.id);
        }

        // Filter by status if provided
        if (status) {
          query = query.eq('status', status);
        }

        query = query.order('created_at', { ascending: false });

        const { data: reports, error } = await query;

        if (error) {
          console.error('Get RPG Bug Reports error:', error);
          return respond({ error: error.message }, 400);
        }

        return respond({ reports: reports || [], isAdmin });
      }

      /* ==========================
         RPG FRIEND PARTY SYSTEM
      ========================== */

      case 'get_rpg_friends': {
        if (!user) return respond({ error: 'Not authenticated' }, 401);

        const { data, error } = await supabase.rpc('get_rpg_friends');
        if (error) return respond({ error: error.message }, 400);
        return respond({ data });
      }

      case 'invite_friend_to_slot': {
        if (!user) return respond({ error: 'Not authenticated' }, 401);

        const { p_friend_id, p_party_slot, p_message } = payload || {};
        if (!p_friend_id || !p_party_slot) {
          return respond({ error: 'Friend ID and party slot are required' }, 400);
        }

        const { data, error } = await supabase.rpc('invite_friend_to_slot', {
          p_friend_id,
          p_party_slot,
          p_message: p_message || null
        });
        if (error) return respond({ error: error.message }, 400);
        return respond({ data });
      }

      case 'accept_slot_invite': {
        if (!user) return respond({ error: 'Not authenticated' }, 401);

        const { p_invite_id, p_character_slot } = payload || {};
        if (!p_invite_id || !p_character_slot) {
          return respond({ error: 'Invite ID and character slot are required' }, 400);
        }

        const { data, error } = await supabase.rpc('accept_slot_invite', {
          p_invite_id,
          p_character_slot
        });
        if (error) return respond({ error: error.message }, 400);
        return respond({ data });
      }

      case 'get_my_rpg_invites': {
        if (!user) return respond({ error: 'Not authenticated' }, 401);

        const { data, error } = await supabase.rpc('get_my_rpg_invites');
        if (error) return respond({ error: error.message }, 400);
        return respond({ data });
      }

      case 'get_my_party_guests': {
        if (!user) return respond({ error: 'Not authenticated' }, 401);

        const { data, error } = await supabase.rpc('get_my_party_guests');
        if (error) return respond({ error: error.message }, 400);
        return respond({ data });
      }

      case 'remove_party_guest': {
        if (!user) return respond({ error: 'Not authenticated' }, 401);

        const { p_party_slot } = payload || {};
        if (!p_party_slot) {
          return respond({ error: 'Party slot is required' }, 400);
        }

        const { data, error } = await supabase.rpc('remove_party_guest', { p_party_slot });
        if (error) return respond({ error: error.message }, 400);
        return respond({ data });
      }

      case 'leave_rpg_party': {
        if (!user) return respond({ error: 'Not authenticated' }, 401);

        const { p_host_id } = payload || {};
        if (!p_host_id) {
          return respond({ error: 'Host ID is required' }, 400);
        }

        const { data, error } = await supabase.rpc('leave_rpg_party', { p_host_id });
        if (error) return respond({ error: error.message }, 400);
        return respond({ data });
      }

      case 'mtgGetBugReports': {
        const { mtg_user_id, game_name, status, limit = 100, offset = 0 } = payload || {};

        if (!mtg_user_id) {
          return respond({ error: 'User ID is required' }, 400);
        }

        const adminSupabase = createClient(supabaseUrl, supabaseServiceKey);

        // Get user's role
        const { data: mtgUser } = await adminSupabase
          .from('mtg_users')
          .select('role, username, nickname')
          .eq('id', mtg_user_id)
          .single();

        const isAdmin = mtgUser && ['ADMIN', 'GOD'].includes(mtgUser.role);

        let query = adminSupabase
          .from('mtg_bug_reports')
          .select('*');

        // Non-admins can only see their own reports
        if (!isAdmin) {
          query = query.eq('user_id', mtg_user_id);
        }

        // Filter by game if provided
        if (game_name) {
          query = query.eq('game_name', game_name);
        }

        // Filter by status if provided
        if (status) {
          query = query.eq('status', status);
        }

        query = query
          .order('created_at', { ascending: false })
          .range(offset, offset + limit - 1);

        const { data: bugReports, error } = await query;

        if (error) return respond({ error: error.message }, 400);

        // If admin, fetch user info for all reports
        if (isAdmin && bugReports && bugReports.length > 0) {
          const userIds = [...new Set(bugReports.map(r => r.user_id))];
          const { data: users } = await adminSupabase
            .from('mtg_users')
            .select('id, username, nickname')
            .in('id', userIds);

          const userMap = {};
          if (users) {
            users.forEach(u => {
              userMap[u.id] = u;
            });
          }

          bugReports.forEach(report => {
            report.user_info = userMap[report.user_id] || null;
          });
        }

        return respond({ data: bugReports, isAdmin, userRole: mtgUser?.role });
      }

      case 'mtgUpdateBugReport': {
        const { mtg_user_id, report_id, status, priority, admin_notes } = payload || {};

        if (!mtg_user_id || !report_id) {
          return respond({ error: 'User ID and report ID are required' }, 400);
        }

        const adminSupabase = createClient(supabaseUrl, supabaseServiceKey);

        // Check if user is admin
        const { data: mtgUser } = await adminSupabase
          .from('mtg_users')
          .select('role')
          .eq('id', mtg_user_id)
          .single();

        if (!mtgUser || !['ADMIN', 'GOD'].includes(mtgUser.role)) {
          return respond({ error: 'Insufficient permissions' }, 403);
        }

        const updates = {};
        if (status) updates.status = status;
        if (priority) updates.priority = priority;
        if (admin_notes !== undefined) updates.admin_notes = admin_notes;

        const { data, error } = await adminSupabase
          .from('mtg_bug_reports')
          .update(updates)
          .eq('id', report_id)
          .select()
          .single();

        if (error) return respond({ error: error.message }, 400);
        return respond({ data, message: 'Bug report updated successfully' });
      }

      case 'mtgDeleteBugReport': {
        const { mtg_user_id, report_id } = payload || {};

        if (!mtg_user_id || !report_id) {
          return respond({ error: 'User ID and report ID are required' }, 400);
        }

        const adminSupabase = createClient(supabaseUrl, supabaseServiceKey);

        // Check if user is admin
        const { data: mtgUser } = await adminSupabase
          .from('mtg_users')
          .select('role')
          .eq('id', mtg_user_id)
          .single();

        if (!mtgUser || !['ADMIN', 'GOD'].includes(mtgUser.role)) {
          return respond({ error: 'Insufficient permissions' }, 403);
        }

        const { error } = await adminSupabase
          .from('mtg_bug_reports')
          .delete()
          .eq('id', report_id);

        if (error) return respond({ error: error.message }, 400);
        return respond({ message: 'Bug report deleted successfully' });
      }

      case 'mtgGetAllUsers': {
        const { mtg_god_id } = payload || {};

        if (!mtg_god_id) {
          return respond({ error: 'God ID is required' }, 400);
        }

        const adminSupabase = createClient(supabaseUrl, supabaseServiceKey);

        // Verify requester is GOD
        const { data: godUser } = await adminSupabase
          .from('mtg_users')
          .select('role')
          .eq('id', mtg_god_id)
          .single();

        if (!godUser || godUser.role !== 'GOD') {
          return respond({ error: 'Only GOD can view all users' }, 403);
        }

        // Get all users
        const { data: users, error } = await adminSupabase
          .from('mtg_users')
          .select('id, username, nickname, role, created_at, last_login')
          .order('created_at', { ascending: false });

        if (error) return respond({ error: error.message }, 400);

        return respond({ data: users });
      }

      case 'mtgPromoteUser': {
        const { mtg_god_id, target_user_id, new_role } = payload || {};

        if (!mtg_god_id || !target_user_id || !new_role) {
          return respond({ error: 'God ID, target user ID, and new role are required' }, 400);
        }

        const adminSupabase = createClient(supabaseUrl, supabaseServiceKey);

        // Verify requester is GOD
        const { data: godUser } = await adminSupabase
          .from('mtg_users')
          .select('role')
          .eq('id', mtg_god_id)
          .single();

        if (!godUser || godUser.role !== 'GOD') {
          return respond({ error: 'Only GOD can promote users' }, 403);
        }

        // Update target user
        const { data, error } = await adminSupabase
          .from('mtg_users')
          .update({ role: new_role })
          .eq('id', target_user_id)
          .select()
          .single();

        if (error) return respond({ error: error.message }, 400);

        return respond({ data, message: `User promoted to ${new_role}` });
      }

      case 'mtgUpdateProfile': {
        const { mtg_user_id, nickname } = payload || {};

        if (!mtg_user_id || !nickname) {
          return respond({ error: 'User ID and nickname are required' }, 400);
        }

        const adminSupabase = createClient(supabaseUrl, supabaseServiceKey);

        const { data, error } = await adminSupabase
          .from('mtg_users')
          .update({ nickname })
          .eq('id', mtg_user_id)
          .select();

        if (error) {
          console.error('MTG Update Profile error:', error);
          return respond({ error: error.message }, 400);
        }

        if (!data || data.length === 0) {
          return respond({ error: 'User profile not found' }, 404);
        }

        return respond({ data: data[0], message: 'Profile updated successfully' });
      }

      case 'mtgChangePassword': {
        const { mtg_user_id, new_password } = payload || {};

        if (!mtg_user_id || !new_password) {
          return respond({ error: 'User ID and new password are required' }, 400);
        }

        const adminSupabase = createClient(supabaseUrl, supabaseServiceKey);

        // Update password using Supabase Auth
        const { error } = await adminSupabase.auth.admin.updateUserById(mtg_user_id, {
          password: new_password
        });

        if (error) return respond({ error: error.message }, 400);
        return respond({ message: 'Password changed successfully' });
      }

      /* ==========================
         SUPPORTER SYSTEM
      ========================== */
      case 'updateSupporterStatus': {
        // This action is called internally by the Ko-fi webhook
        // Uses service role key for security
        const { user_id, is_supporter, supporter_tier } = payload;

        if (!user_id) {
          return respond({ error: 'user_id required' }, 400);
        }

        const updates = {
          is_supporter: is_supporter === true,
          supporter_tier: supporter_tier || 'standard',
          supporter_since: new Date().toISOString()
        };

        const { data, error } = await adminSupabase
          .from('profiles')
          .update(updates)
          .eq('id', user_id)
          .select()
          .single();

        if (error) return respond({ error: error.message }, 400);
        return respond({ data });
      }

      case 'claimSupporterWelcomePack': {
        // One-time welcome pack for new supporters
        if (!user) return respond({ error: 'Not authenticated' }, 401);

        // Check if user is a supporter
        const { data: profile, error: profileError } = await supabase
          .from('profiles')
          .select('is_supporter, supporter_welcome_claimed')
          .eq('id', user.id)
          .single();

        if (profileError) return respond({ error: profileError.message }, 400);
        if (!profile.is_supporter) return respond({ error: 'Not a supporter' }, 403);
        if (profile.supporter_welcome_claimed) return respond({ error: 'Already claimed' }, 400);

        // Mark as claimed
        await adminSupabase
          .from('profiles')
          .update({ supporter_welcome_claimed: true })
          .eq('id', user.id);

        return respond({
          data: {
            gold: 1000,
            health_potions: 10,
            mana_potions: 5
          }
        });
      }

      case 'getOwnedCosmetics': {
        if (!user) return respond({ error: 'Not authenticated' }, 401);

        const { data, error } = await supabase
          .from('supporter_cosmetics')
          .select('cosmetic_id')
          .eq('user_id', user.id);

        if (error) return respond({ error: error.message }, 400);
        return respond({ data: data || [] });
      }

      case 'purchaseCosmetic': {
        if (!user) return respond({ error: 'Not authenticated' }, 401);
        const { cosmetic_id } = payload;

        if (!cosmetic_id) {
          return respond({ error: 'cosmetic_id required' }, 400);
        }

        // Insert cosmetic purchase
        const { data, error } = await supabase
          .from('supporter_cosmetics')
          .insert({
            user_id: user.id,
            cosmetic_id: cosmetic_id,
            purchased_at: new Date().toISOString()
          })
          .select()
          .single();

        if (error) return respond({ error: error.message }, 400);
        return respond({ data });
      }

      /* ==========================
         DAILY GEMS CLAIM
      ========================== */
      case 'claimDailyGems': {
        if (!user) return respond({ error: 'Not authenticated' }, 401);

        try {
          // Get user profile for supporter info, last claim, and current gems
          const { data: profile, error: profileError } = await supabase
            .from('profiles')
            .select('is_supporter, supporter_tier, last_daily_gem_claim, gems, gems_earned')
            .eq('id', user.id)
            .single();

          if (profileError) {
            return respond({ error: profileError.message }, 400);
          }

          // Check if 24 hours have passed since last claim
          const now = new Date();
          const lastClaim = profile.last_daily_gem_claim ? new Date(profile.last_daily_gem_claim) : null;

          if (lastClaim) {
            const hoursSinceLastClaim = (now - lastClaim) / (1000 * 60 * 60);
            if (hoursSinceLastClaim < 24) {
              const hoursUntilNextClaim = Math.ceil(24 - hoursSinceLastClaim);
              return respond({
                error: 'Daily gems already claimed',
                data: {
                  canClaim: false,
                  hoursUntilNextClaim
                }
              }, 400);
            }
          }

          // Calculate gems based on supporter tier
          let dailyGems = 5; // Base for everyone
          if (profile.is_supporter) {
            const tierLower = (profile.supporter_tier || 'standard').toLowerCase();
            if (tierLower.includes('legend') || tierLower === 'tier3') {
              dailyGems += 15; // Tier 3: 20 total
            } else if (tierLower.includes('champion') || tierLower === 'tier2') {
              dailyGems += 10; // Tier 2: 15 total
            } else {
              dailyGems += 5; // Tier 1: 10 total
            }
          }

          // Get user's profile gems (universal gems source of truth)
          const currentGems = profile.gems || 0;
          const newGemAmount = currentGems + dailyGems;

          // Update profiles.gems (universal gems) and last claim timestamp
          const { error: updateError } = await supabase
            .from('profiles')
            .update({
              gems: newGemAmount,
              gems_earned: (profile.gems_earned || 0) + dailyGems,
              last_daily_gem_claim: now.toISOString()
            })
            .eq('id', user.id);

          if (updateError) {
            return respond({ error: updateError.message }, 500);
          }

          // Also update legacy rpg_characters.supporter_gems for backwards compatibility
          const { data: character } = await supabase
            .from('rpg_characters')
            .select('id, character_name')
            .eq('user_id', user.id)
            .order('created_at', { ascending: true })
            .limit(1)
            .maybeSingle();

          if (character) {
            await supabase
              .from('rpg_characters')
              .update({ supporter_gems: newGemAmount })
              .eq('id', character.id);
          }

          console.log(`✅ ${dailyGems} daily gems claimed (profiles.gems: ${newGemAmount})`);

          return respond({
            data: {
              claimed: true,
              gemsReceived: dailyGems,
              newTotal: newGemAmount,
              characterName: character?.character_name || 'User'
            }
          });

        } catch (error) {
          console.error('claimDailyGems error:', error);
          return respond({ error: error.message }, 500);
        }
      }

      /* ==========================
         CLAUDE GIFT SUBMISSIONS
      ========================== */
      case 'submitClaudeGift': {
        const { gift_link, email } = payload;

        if (!gift_link) {
          return respond({ error: 'Gift link is required' }, 400);
        }

        if (!gift_link.includes('claude.ai') && !gift_link.includes('anthropic')) {
          return respond({ error: 'Invalid gift link format' }, 400);
        }

        const claim_key = 'CG-' + randomUUID().split('-')[0].toUpperCase() + '-' + Date.now().toString(36).toUpperCase();

        const { data, error } = await adminSupabase
          .from('claude_gifts')
          .insert({
            gift_link,
            email: email || null,
            claim_key,
            user_id: user ? user.id : null,
            source: 'claude_gift'
          })
          .select()
          .single();

        if (error) {
          console.error('submitClaudeGift error:', error);
          return respond({ error: error.message }, 400);
        }

        return respond({
          data: {
            success: true,
            claim_key,
            message: 'Gift submitted! Save your claim key to check status and claim rewards later.'
          }
        });
      }

      case 'checkClaudeGiftStatus': {
        const { claim_key } = payload;

        if (!claim_key) {
          return respond({ error: 'Claim key is required' }, 400);
        }

        const { data, error } = await adminSupabase
          .from('claude_gifts')
          .select('claim_key, submitted_at, verified, gift_tier, gift_months, reward_claimed')
          .eq('claim_key', claim_key)
          .single();

        if (error || !data) {
          return respond({ error: 'Gift not found' }, 404);
        }

        return respond({ data });
      }

      /* ==========================
         DEFAULT
      ========================== */
      default:
        return respond({ error: 'Unknown action' }, 400);

    }

  } catch (error) {
    console.error('Proxy error:', error);
    return respond({ error: error.message }, 500);
  }
};
  