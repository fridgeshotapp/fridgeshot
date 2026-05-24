// api/stripe/checkout.js
// Crea una sesión de Stripe Checkout para el plan Pro
// El usuario debe estar autenticado (token de Supabase en el header)

const Stripe = require('stripe');
const { createClient } = require('@supabase/supabase-js');
const { withSentry } = require('../_sentry');

module.exports = withSentry(async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

  // Verificar que el usuario está autenticado
  const authHeader = req.headers.authorization || '';
  const token = authHeader.replace('Bearer ', '');
  if (!token) {
    return res.status(401).json({ error: 'No autenticado. Inicia sesión para suscribirte a Pro.' });
  }

  // Verificar el token con Supabase
  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_ANON_KEY
  );
  const { data: { user }, error: authError } = await supabase.auth.getUser(token);
  if (authError || !user) {
    return res.status(401).json({ error: 'Sesión inválida. Vuelve a iniciar sesión.' });
  }

  try {
    // Ver si ya tiene un customer_id de Stripe
    const supabaseAdmin = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY
    );
    const { data: sub } = await supabaseAdmin
      .from('user_subscriptions')
      .select('stripe_customer_id, status')
      .eq('user_id', user.id)
      .single();

    // Si ya es Pro activo, no crear nueva sesión
    if (sub && (sub.status === 'active' || sub.status === 'trialing')) {
      return res.status(400).json({ error: 'Ya tienes una suscripción Pro activa.' });
    }

    // Crear sesión de Checkout
    const sessionParams = {
      mode: 'subscription',
      payment_method_types: ['card'],
      line_items: [{ price: process.env.STRIPE_PRICE_ID, quantity: 1 }],
      subscription_data: {
        trial_period_days: 7,
        metadata: { user_id: user.id }
      },
      metadata: { user_id: user.id },
      customer_email: sub?.stripe_customer_id ? undefined : user.email,
      success_url: `${req.headers.origin || 'https://fridgeshot.app'}/app?pro=success`,
      cancel_url: `${req.headers.origin || 'https://fridgeshot.app'}/app?pro=cancelled`,
    };

    // Reutilizar customer de Stripe si existe
    if (sub?.stripe_customer_id) {
      sessionParams.customer = sub.stripe_customer_id;
      delete sessionParams.customer_email;
    }

    const session = await stripe.checkout.sessions.create(sessionParams);
    return res.status(200).json({ url: session.url });

  } catch (err) {
    console.error('Stripe checkout error:', err);
    return res.status(500).json({ error: 'Error al crear la sesión de pago. Inténtalo de nuevo.' });
  }
});
