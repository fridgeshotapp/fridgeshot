// api/stripe/webhook.js
// Recibe eventos de Stripe y actualiza el estado de suscripción en Supabase
// IMPORTANTE: Stripe envía el body como raw buffer — no como JSON parseado

const Stripe = require('stripe');
const { createClient } = require('@supabase/supabase-js');
const { withSentry } = require('../_sentry');

// Desactivar el body parser de Vercel para este endpoint (necesitamos el raw body)

function getRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

  if (!webhookSecret) {
    console.error('STRIPE_WEBHOOK_SECRET no configurado');
    return res.status(500).json({ error: 'Webhook no configurado' });
  }

  let event;
  try {
    const rawBody = await getRawBody(req);
    const signature = req.headers['stripe-signature'];
    event = stripe.webhooks.constructEvent(rawBody, signature, webhookSecret);
  } catch (err) {
    console.error('Webhook signature verification failed:', err.message);
    return res.status(400).json({ error: `Webhook error: ${err.message}` });
  }

  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  );

  const subscription = event.data.object;

  // Extraer user_id de los metadatos
  const getUserId = (obj) =>
    obj?.metadata?.user_id ||
    obj?.subscription_details?.metadata?.user_id ||
    null;

  try {
    switch (event.type) {

      case 'customer.subscription.created':
      case 'customer.subscription.updated': {
        const userId = getUserId(subscription);
        if (!userId) break;

        await supabase.from('user_subscriptions').upsert({
          user_id: userId,
          stripe_customer_id: subscription.customer,
          stripe_subscription_id: subscription.id,
          status: subscription.status, // 'trialing', 'active', 'past_due', 'canceled'
          trial_end: subscription.trial_end
            ? new Date(subscription.trial_end * 1000).toISOString()
            : null,
          current_period_end: new Date(subscription.current_period_end * 1000).toISOString(),
          updated_at: new Date().toISOString(),
        }, { onConflict: 'user_id' });
        break;
      }

      case 'customer.subscription.deleted': {
        const userId = getUserId(subscription);
        if (!userId) break;

        await supabase.from('user_subscriptions').upsert({
          user_id: userId,
          stripe_customer_id: subscription.customer,
          stripe_subscription_id: subscription.id,
          status: 'cancelled',
          current_period_end: new Date(subscription.current_period_end * 1000).toISOString(),
          updated_at: new Date().toISOString(),
        }, { onConflict: 'user_id' });
        break;
      }

      case 'invoice.payment_failed': {
        // El pago falló — Stripe reintentará, pero podemos notificar
        console.warn('Payment failed for customer:', subscription.customer);
        break;
      }

      default:
        // Evento no gestionado — ignorar
        break;
    }

    return res.status(200).json({ received: true });

  } catch (err) {
    console.error('Error processing webhook:', err);
    return res.status(500).json({ error: 'Error interno procesando el webhook' });
  }
}

const wrappedHandler = withSentry(handler);
wrappedHandler.config = { api: { bodyParser: false } };
module.exports = wrappedHandler;
