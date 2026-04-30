// api/_auth.js
// Helpers de autenticación compartidos entre endpoints

const { createClient } = require('@supabase/supabase-js');

async function isProUser(req) {
  try {
    const token = (req.headers.authorization || '').replace('Bearer ', '');
    if (!token) return false;
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);
    const { data: { user } } = await supabase.auth.getUser(token);
    if (!user) return false;
    const admin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
    const { data: sub } = await admin
      .from('user_subscriptions')
      .select('status')
      .eq('user_id', user.id)
      .single();
    return sub?.status === 'active' || sub?.status === 'trialing';
  } catch {
    return false;
  }
}

module.exports = { isProUser };
