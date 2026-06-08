const { createClient } = require('@supabase/supabase-js');
const { withSentry } = require('./_sentry');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

module.exports = withSentry(async (req, res) => {
  const { error } = await supabase.from('waitlist').select('count').limit(1).single();
  if (error && error.code !== 'PGRST116') {
    return res.status(500).json({ ok: false, error: error.message });
  }
  res.status(200).json({ ok: true, ts: new Date().toISOString() });
});
