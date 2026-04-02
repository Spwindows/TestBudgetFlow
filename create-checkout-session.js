const Stripe = require("stripe");
const { createClient } = require("@supabase/supabase-js");

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

const PRICE_MAP = {
  "solo_monthly": process.env.STRIPE_PRICE_SOLO_MONTHLY,
  "solo_yearly": process.env.STRIPE_PRICE_SOLO_YEARLY,
  "shared_monthly": process.env.STRIPE_PRICE_SHARED_MONTHLY,
  "shared_yearly": process.env.STRIPE_PRICE_SHARED_YEARLY,
};

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method not allowed" };
  }

  try {
    const body = JSON.parse(event.body || "{}");
    const { user_id, email, plan, billing_cycle } = body;

    if (!user_id || !email || !plan || !billing_cycle) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: "Missing required fields" }),
      };
    }

    const key = `${plan}_${billing_cycle}`;
    const price = PRICE_MAP[key];

    if (!price) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: "Invalid plan or billing cycle" }),
      };
    }

    const siteUrl = process.env.SITE_URL || "http://localhost:8888";

    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      customer_email: email,
      line_items: [
        {
          price,
          quantity: 1,
        },
      ],
      success_url: `${siteUrl}/?checkout=success`,
      cancel_url: `${siteUrl}/?checkout=cancelled`,
      metadata: {
        user_id,
        plan,
        billing_cycle,
      },
      subscription_data: {
        metadata: {
          user_id,
          plan,
          billing_cycle,
        },
      },
      allow_promotion_codes: true,
    });

    return {
      statusCode: 200,
      body: JSON.stringify({ url: session.url }),
    };
  } catch (err) {
    console.error("create-checkout-session error", err);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: err.message || "Server error" }),
    };
  }
};
