// api/stripe/status.js
// Devuelve el estado de suscripción del usuario autenticado
// Usado por el frontend para saber si mostrar features Pro

const { createClient } = require('@supabase/supabase-js');

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const authHeader = req.headers.authorization || '';
  const token = authHeader.replace('Bearer ', '');
  if (!token) {
    return res.status(200).json({ is_pro: false, status: 'free' });
  }

  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_ANON_KEY
  );

  const { data: { user }, error } = await supabase.auth.getUser(token);
  if (error || !user) {
    return res.status(200).json({ is_pro: false, status: 'free' });
  }

  const supabaseAdmin = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  );

  const { data: sub } = await supabaseAdmin
    .from('user_subscriptions')
    .select('status, trial_end, current_period_end')
    .eq('user_id', user.id)
    .single();

  if (!sub) {
    return res.status(200).json({ is_pro: false, status: 'free' });
  }

  const isPro = sub.status === 'active' || sub.status === 'trialing';

  return res.status(200).json({
    is_pro: isPro,
    status: sub.status,
    trial_end: sub.trial_end,
    current_period_end: sub.current_period_end,
  });
};
