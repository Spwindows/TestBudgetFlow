const Stripe = require("stripe");
const { createClient } = require("@supabase/supabase-js");

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

function getSupabaseAdmin() {
  return createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { persistSession: false } }
  );
}

async function upsertPaidSubscription({ userId, plan, billingCycle, customerId, subscriptionId, status, currentPeriodEnd, provider = "stripe" }) {
  const sb = getSupabaseAdmin();

  const mappedStatus =
    status === "trialing" ? "trial" :
    status === "active" ? "active" :
    status === "canceled" ? "cancelled" :
    status === "unpaid" || status === "incomplete_expired" ? "expired" :
    status === "past_due" ? "active" :
    "expired";

  const { error } = await sb.rpc("set_paid_subscription", {
    p_user_id: userId,
    p_plan: plan,
    p_billing_cycle: billingCycle,
    p_provider: provider,
    p_provider_customer_id: customerId || null,
    p_provider_subscription_id: subscriptionId || null
  });

  if (error) throw error;

  const updates = {
    status: mappedStatus,
    provider: provider,
    provider_customer_id: customerId || null,
    provider_subscription_id: subscriptionId || null,
    current_period_ends_at: currentPeriodEnd ? new Date(currentPeriodEnd * 1000).toISOString() : null,
    trial_ends_at: null,
    updated_at: new Date().toISOString(),
  };

  const { error: updateError } = await sb
    .from("user_subscriptions")
    .update(updates)
    .eq("user_id", userId);

  if (updateError) throw updateError;
}

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method not allowed" };
  }

  const sig = event.headers["stripe-signature"] || event.headers["Stripe-Signature"];
  let stripeEvent;

  try {
    stripeEvent = stripe.webhooks.constructEvent(
      event.body,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error("Webhook signature verification failed.", err.message);
    return { statusCode: 400, body: `Webhook Error: ${err.message}` };
  }

  try {
    switch (stripeEvent.type) {
      case "checkout.session.completed": {
        const session = stripeEvent.data.object;

        if (session.mode === "subscription" && session.subscription) {
          const subscription = await stripe.subscriptions.retrieve(session.subscription);
          const meta = subscription.metadata || session.metadata || {};

          await upsertPaidSubscription({
            userId: meta.user_id,
            plan: meta.plan,
            billingCycle: meta.billing_cycle,
            customerId: session.customer,
            subscriptionId: subscription.id,
            status: subscription.status,
            currentPeriodEnd: subscription.current_period_end,
            provider: "stripe",
          });
        }
        break;
      }

      case "customer.subscription.updated":
      case "customer.subscription.created": {
        const subscription = stripeEvent.data.object;
        const meta = subscription.metadata || {};

        if (meta.user_id && meta.plan && meta.billing_cycle) {
          await upsertPaidSubscription({
            userId: meta.user_id,
            plan: meta.plan,
            billingCycle: meta.billing_cycle,
            customerId: subscription.customer,
            subscriptionId: subscription.id,
            status: subscription.status,
            currentPeriodEnd: subscription.current_period_end,
            provider: "stripe",
          });
        }
        break;
      }

      case "customer.subscription.deleted": {
        const subscription = stripeEvent.data.object;
        const meta = subscription.metadata || {};

        if (meta.user_id) {
          const sb = getSupabaseAdmin();
          const { error } = await sb
            .from("user_subscriptions")
            .update({
              status: "expired",
              updated_at: new Date().toISOString(),
            })
            .eq("user_id", meta.user_id);

          if (error) throw error;
        }
        break;
      }

      case "invoice.payment_failed": {
        const invoice = stripeEvent.data.object;
        const subscriptionId = invoice.subscription;
        if (subscriptionId) {
          const subscription = await stripe.subscriptions.retrieve(subscriptionId);
          const meta = subscription.metadata || {};
          if (meta.user_id) {
            const sb = getSupabaseAdmin();
            const { error } = await sb
              .from("user_subscriptions")
              .update({
                status: "expired",
                updated_at: new Date().toISOString(),
              })
              .eq("user_id", meta.user_id);

            if (error) throw error;
          }
        }
        break;
      }

      default:
        break;
    }

    return { statusCode: 200, body: JSON.stringify({ received: true }) };
  } catch (err) {
    console.error("Webhook handler error", err);
    return { statusCode: 500, body: JSON.stringify({ error: err.message || "Webhook failed" }) };
  }
};
