// ============================================================
//  KraftyBI Rentals Cebu — Facebook Messenger Webhook Server
//  Powered by Groq (FREE) + Smart Learning + Full Dashboard
// ============================================================

const express = require("express");
const axios = require("axios");
const fs = require("fs");
const app = express();
app.use(express.json());

// ── ENV VARIABLES ────────────────────────────────────────────
const PAGE_ACCESS_TOKEN = process.env.PAGE_ACCESS_TOKEN;
const VERIFY_TOKEN      = process.env.VERIFY_TOKEN;
const GROQ_API_KEY      = process.env.GROQ_API_KEY;

// ── Memory Files ─────────────────────────────────────────────
const MEMORY_FILE    = "/tmp/customers.json";
const ANALYTICS_FILE = "/tmp/analytics.json";
const ORDERS_FILE    = "/tmp/orders.json";

function loadJSON(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); }
  catch { return fallback; }
}
function saveJSON(file, data) {
  try { fs.writeFileSync(file, JSON.stringify(data, null, 2)); } catch {}
}

// ── Conversation memory ──────────────────────────────────────
const conversations = {};

// ── System Prompt ────────────────────────────────────────────
function buildSystemPrompt(senderId) {
  const customers = loadJSON(MEMORY_FILE, {});
  const customer  = customers[senderId] || null;
  const analytics = loadJSON(ANALYTICS_FILE, { popular: {}, questions: {} });

  const popularItems = Object.entries(analytics.popular)
    .sort((a, b) => b[1] - a[1]).slice(0, 3)
    .map(([k, v]) => `${k} (${v}x)`).join(", ") || "none yet";

  const returningInfo = customer ? `
RETURNING CUSTOMER:
- Name: ${customer.name || "unknown"}
- Past Orders: ${JSON.stringify(customer.orders || [])}
- Greet by name. Ask if they want the same setup or something new.
` : `NEW CUSTOMER.`;

  return `You are a smart, friendly customer service chatbot for KraftyBI Rentals Cebu, located in Lower Pakigne, Minglanilla.

${returningInfo}
POPULAR ITEMS: ${popularItems}

PRODUCTS & PRICING (max 12 hours rental):

KIDDIE SET:
- Kiddie Set (4ft table + 6 kiddie chairs): P180/set (12hrs, +P1 for 24hrs)
- Kiddie Chair only: P15/pc
- Kiddie Table only (4ft): P120/pc

ADULT PACKAGE - INDIVIDUAL:
- Monoblock Chair: P15/pc | Cover: +P10/pc
- 5-Foot Table: P150/pc | Cover: +P25/pc
- 6-Foot Table: P180/pc | Cover: +P25/pc

ADULT PACKAGE - SETS:
- Set A (20 pax): 20 chairs + 2x6ft + 1x5ft = P780
- Set B (30 pax): 30 chairs + 4x6ft = P1,120
- Set C (50 pax): 50 chairs + 4x6ft + 4x5ft = P2,000

DELIVERY: Lalamove rate. Drop-off & pick-up only. No setup provided.
PRICE LIST WEBSITE: https://kraftybi.my.canva.site/kbrental

LANGUAGE: Always reply in ENGLISH only, no matter what language the customer uses. Keep it simple, warm, and friendly.

REPLY STYLE — VERY IMPORTANT:
- Keep replies SHORT and DIRECT. Customers don't read long messages.
- Use line breaks and emojis to make it easy to read.
- Never write long paragraphs. Use this format for recommendations:

For [X] guests, I recommend:
📦 [Package]: P[price]
🪑 [Extra item] x[qty]: P[price]
💰 Total: P[total]

PRICE LIST RULE:
- If customer asks for price list, ask first: "Is it for Kiddie or Adult setup? 😊"
- Then show ONLY that category prices in short format
- End with: "📋 Full price list: https://kraftybi.my.canva.site/kbrental"

SMART RECOMMENDATION LOGIC:
- Always find closest lower package + calculate missing items
- Compare (package + extras) vs next package price
- If upgrading costs P300 or less more: recommend upgrade and show savings
- If more than P300: recommend package + extras
- Show math in short format always
- For 50+ guests: Set C + extra chairs/tables as needed

UPSELLING (after recommending package):
- Suggest covers briefly: "Want covers to make it look prettier? 🎀 Chair cover P10/pc, Table cover P25/pc"
- Show total cover cost for their order
- If they say no, move on

YOUR FLOW:
1. Greet customer (by name if returning)
2. Ask: how many guests + what event?
3. Recommend best package using short format
4. Upsell covers
5. Collect: name, contact number, event date, event location/address
6. Show short order summary
7. Remind about Lalamove delivery fee

MEMORY: When order is confirmed, end message with this tag (hidden from customer):
ORDER_SAVED:{"name":"...","event":"...","date":"...","location":"...","contact":"...","items":[{"item":"...","qty":1,"price":0}],"subtotal":0}`;
}

// ── 1. Webhook Verification ──────────────────────────────────
app.get("/webhook", (req, res) => {
  const mode      = req.query["hub.mode"];
  const token     = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    console.log("Webhook verified!");
    res.status(200).send(challenge);
  } else res.sendStatus(403);
});

// ── 2. Receive Messages ──────────────────────────────────────
app.post("/webhook", async (req, res) => {
  const body = req.body;
  if (body.object !== "page") return res.sendStatus(404);

  for (const entry of body.entry) {
    for (const event of entry.messaging) {
      if (!event.message || event.message.is_echo) continue;
      const senderId = event.sender.id;
      const userText = event.message.text;
      if (!userText) continue;

      console.log(`Message from ${senderId}: ${userText}`);
      trackAnalytics(userText);
      await sendTyping(senderId);

      if (!conversations[senderId]) conversations[senderId] = [];
      conversations[senderId].push({ role: "user", content: userText });
      if (conversations[senderId].length > 20)
        conversations[senderId] = conversations[senderId].slice(-20);

      try {
        const reply = await callGroq(conversations[senderId], buildSystemPrompt(senderId));

        // Save order if completed
        const orderMatch = reply.match(/ORDER_SAVED:(\{[\s\S]*?\})/);
        if (orderMatch) {
          try {
            const orderData = JSON.parse(orderMatch[1]);
            saveCustomerData(senderId, orderData);
            saveOrder(senderId, orderData);
          } catch {}
        }

        const cleanReply = reply.replace(/ORDER_SAVED:[\s\S]*/, "").trim();
        conversations[senderId].push({ role: "assistant", content: cleanReply });
        await sendMessage(senderId, cleanReply);
      } catch (err) {
        console.error("Groq API error:", err.message);
        await sendMessage(senderId, "Sorry, there was a technical issue. Please try again! 😅");
      }
    }
  }
  res.sendStatus(200);
});

// ── 3. Save Customer ─────────────────────────────────────────
function saveCustomerData(senderId, orderData) {
  const customers = loadJSON(MEMORY_FILE, {});
  if (!customers[senderId]) customers[senderId] = { name: orderData.name, orders: [] };
  else if (orderData.name) customers[senderId].name = orderData.name;
  customers[senderId].orders.push({
    date: orderData.date, event: orderData.event,
    location: orderData.location, contact: orderData.contact,
    items: orderData.items, subtotal: orderData.subtotal,
    createdAt: new Date().toISOString()
  });
  if (customers[senderId].orders.length > 5)
    customers[senderId].orders = customers[senderId].orders.slice(-5);
  saveJSON(MEMORY_FILE, customers);

  // Track popular items
  const analytics = loadJSON(ANALYTICS_FILE, { popular: {}, questions: {} });
  (orderData.items || []).forEach(it => {
    analytics.popular[it.item] = (analytics.popular[it.item] || 0) + (it.qty || 1);
  });
  saveJSON(ANALYTICS_FILE, analytics);
}

// ── 4. Save Order ────────────────────────────────────────────
function saveOrder(senderId, orderData) {
  const orders = loadJSON(ORDERS_FILE, []);
  orders.unshift({
    id: Date.now(),
    senderId,
    name: orderData.name || "Unknown",
    event: orderData.event || "-",
    date: orderData.date || "-",
    location: orderData.location || "-",
    contact: orderData.contact || "-",
    items: orderData.items || [],
    subtotal: orderData.subtotal || 0,
    createdAt: new Date().toLocaleString("en-PH", { timeZone: "Asia/Manila" })
  });
  if (orders.length > 100) orders.pop();
  saveJSON(ORDERS_FILE, orders);
}

// ── 5. Track Analytics ───────────────────────────────────────
function trackAnalytics(text) {
  const analytics = loadJSON(ANALYTICS_FILE, { popular: {}, questions: {} });
  const keywords = ["table","chair","set a","set b","set c","kiddie","cover","delivery","price","pila","magkano","naa","available","how much"];
  keywords.forEach(kw => {
    if (text.toLowerCase().includes(kw))
      analytics.questions[kw] = (analytics.questions[kw] || 0) + 1;
  });
  saveJSON(ANALYTICS_FILE, analytics);
}

// ── 6. Dashboard ─────────────────────────────────────────────
app.get("/dashboard", (req, res) => {
  const orders    = loadJSON(ORDERS_FILE, []);
  const customers = loadJSON(MEMORY_FILE, {});
  const analytics = loadJSON(ANALYTICS_FILE, { popular: {}, questions: {} });

  const totalCustomers = Object.keys(customers).length;
  const totalOrders    = orders.length;
  const totalRevenue   = orders.reduce((s, o) => s + (o.subtotal || 0), 0);

  const popular   = Object.entries(analytics.popular).sort((a, b) => b[1] - a[1]).slice(0, 5);
  const questions = Object.entries(analytics.questions).sort((a, b) => b[1] - a[1]).slice(0, 5);

  const ordersHTML = orders.map((o, i) => `
    <div class="order-card">
      <div class="order-header">
        <span class="order-num">Order #${totalOrders - i}</span>
        <span class="order-date">${o.createdAt}</span>
      </div>
      <div class="order-grid">
        <div><span class="label">👤 Name</span><span>${o.name}</span></div>
        <div><span class="label">📍 Location</span><span>${o.location}</span></div>
        <div><span class="label">📅 Event Date</span><span>${o.date}</span></div>
        <div><span class="label">🎉 Event</span><span>${o.event}</span></div>
        <div><span class="label">📞 Contact</span><span>${o.contact}</span></div>
      </div>
      <table class="breakdown">
        <tr><th>Item</th><th>Qty</th><th>Price</th></tr>
        ${(o.items || []).map(it => `<tr><td>${it.item}</td><td>${it.qty}</td><td>P${(it.price * it.qty).toLocaleString()}</td></tr>`).join("")}
        <tr class="total-row"><td colspan="2"><b>Subtotal</b></td><td><b>P${(o.subtotal || 0).toLocaleString()}</b></td></tr>
        <tr><td colspan="2">Delivery</td><td>Lalamove rate</td></tr>
      </table>
    </div>
  `).join("");

  res.send(`<!DOCTYPE html><html><head><title>KraftyBI Dashboard</title>
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{font-family:sans-serif;background:#f0e6ff;padding:16px}
    h1{color:#9b59b6;margin-bottom:16px;font-size:22px}
    h2{color:#9b59b6;font-size:16px;margin-bottom:10px}
    .overview{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-bottom:16px}
    .stat{background:#fff;border-radius:12px;padding:14px;text-align:center;box-shadow:0 2px 8px rgba(0,0,0,0.08)}
    .stat-num{font-size:28px;font-weight:bold;color:#e91e8c}
    .stat-label{font-size:12px;color:#888;margin-top:4px}
    .section{background:#fff;border-radius:12px;padding:14px;margin-bottom:14px;box-shadow:0 2px 8px rgba(0,0,0,0.08)}
    .order-card{background:#f9f3ff;border-radius:10px;padding:12px;margin-bottom:12px;border-left:4px solid #9b59b6}
    .order-header{display:flex;justify-content:space-between;margin-bottom:10px}
    .order-num{font-weight:bold;color:#9b59b6}
    .order-date{font-size:11px;color:#aaa}
    .order-grid{display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-bottom:10px}
    .order-grid div{font-size:12px}
    .label{font-weight:bold;color:#555;margin-right:4px}
    .breakdown{width:100%;border-collapse:collapse;font-size:12px}
    .breakdown th{background:#e0c8f5;padding:6px;text-align:left}
    .breakdown td{padding:6px;border-bottom:1px solid #eee}
    .total-row td{background:#f0e6ff;font-weight:bold}
    table.small{width:100%;border-collapse:collapse;font-size:13px}
    table.small td,table.small th{padding:7px;border-bottom:1px solid #eee}
    table.small th{color:#9b59b6}
    .badge{background:#e91e8c;color:#fff;border-radius:20px;padding:2px 8px;font-size:11px}
  </style></head><body>
  <h1>🎉 KraftyBI Rentals Dashboard</h1>
  <div class="overview">
    <div class="stat"><div class="stat-num">${totalCustomers}</div><div class="stat-label">Customers</div></div>
    <div class="stat"><div class="stat-num">${totalOrders}</div><div class="stat-label">Orders</div></div>
    <div class="stat"><div class="stat-num">P${totalRevenue.toLocaleString()}</div><div class="stat-label">Total Revenue</div></div>
  </div>
  <div class="section"><h2>📦 Recent Orders</h2>${ordersHTML || "<p style='color:#aaa'>No orders yet</p>"}</div>
  <div class="section"><h2>🏆 Popular Items</h2>
    <table class="small"><tr><th>Item</th><th>Times Ordered</th></tr>
    ${popular.map(([k,v]) => `<tr><td>${k}</td><td><span class="badge">${v}x</span></td></tr>`).join("") || "<tr><td colspan='2' style='color:#aaa'>No data yet</td></tr>"}
    </table>
  </div>
  <div class="section"><h2>❓ Most Asked Keywords</h2>
    <table class="small"><tr><th>Keyword</th><th>Times Asked</th></tr>
    ${questions.map(([k,v]) => `<tr><td>${k}</td><td><span class="badge">${v}x</span></td></tr>`).join("") || "<tr><td colspan='2' style='color:#aaa'>No data yet</td></tr>"}
    </table>
  </div>
  </body></html>`);
});

// ── 7. Call Groq ─────────────────────────────────────────────
async function callGroq(messages, systemPrompt) {
  const res = await axios.post(
    "https://api.groq.com/openai/v1/chat/completions",
    { model: "llama-3.1-8b-instant", messages: [{ role: "system", content: systemPrompt }, ...messages], max_tokens: 500, temperature: 0.7 },
    { headers: { "Authorization": `Bearer ${GROQ_API_KEY}`, "Content-Type": "application/json" } }
  );
  return res.data.choices[0].message.content;
}

// ── 8. Send Message ──────────────────────────────────────────
async function sendMessage(recipientId, text) {
  const chunks = splitMessage(text, 1900);
  for (const chunk of chunks)
    await axios.post(`https://graph.facebook.com/v19.0/me/messages?access_token=${PAGE_ACCESS_TOKEN}`,
      { recipient: { id: recipientId }, message: { text: chunk } });
}

// ── 9. Typing ────────────────────────────────────────────────
async function sendTyping(recipientId) {
  await axios.post(`https://graph.facebook.com/v19.0/me/messages?access_token=${PAGE_ACCESS_TOKEN}`,
    { recipient: { id: recipientId }, sender_action: "typing_on" }).catch(() => {});
}

// ── 10. Split Messages ───────────────────────────────────────
function splitMessage(text, maxLen) {
  if (text.length <= maxLen) return [text];
  const chunks = []; let start = 0;
  while (start < text.length) {
    let end = start + maxLen;
    if (end < text.length) {
      const b = text.lastIndexOf("\n", end) || text.lastIndexOf(" ", end);
      if (b > start) end = b;
    }
    chunks.push(text.slice(start, end).trim());
    start = end;
  }
  return chunks;
}

// ── 11. Send Order Confirmation Follow-up ───────────────────
async function sendOrderConfirmation(senderId, order) {
  const msg =
`✅ Order Confirmed!

👤 Name: ${order.name}
🎉 Event: ${order.event}
📅 Date: ${order.date}
📍 Location: ${order.location}
📞 Contact: ${order.contact}

🧾 Order Summary:
${(order.items || []).map(it => `• ${it.item} x${it.qty} — P${(it.price * it.qty).toLocaleString()}`).join("\n")}
💰 Subtotal: P${(order.subtotal || 0).toLocaleString()}
🚚 Delivery: Lalamove rate (from Minglanilla)

We'll be in touch before your event! Thank you for choosing
