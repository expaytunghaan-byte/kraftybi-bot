// ============================================================
//  KraftyBI Rentals Cebu — Facebook Messenger Webhook Server
//  Powered by Groq (FREE) + Smart Learning Memory
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
const MEMORY_FILE   = "/tmp/customers.json";
const ANALYTICS_FILE = "/tmp/analytics.json";

function loadJSON(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); }
  catch { return fallback; }
}
function saveJSON(file, data) {
  try { fs.writeFileSync(file, JSON.stringify(data, null, 2)); } catch {}
}

// ── Conversation memory (per session) ───────────────────────
const conversations = {};

// ── System prompt ────────────────────────────────────────────
function buildSystemPrompt(customerId) {
  const customers = loadJSON(MEMORY_FILE, {});
  const customer  = customers[customerId] || null;
  const analytics = loadJSON(ANALYTICS_FILE, { popular: {}, questions: {} });

  const popularItems = Object.entries(analytics.popular)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([k, v]) => `${k} (${v}x)`).join(", ") || "none yet";

  const returningInfo = customer ? `
RETURNING CUSTOMER INFO:
- Name: ${customer.name || "unknown"}
- Preferred Language: ${customer.language || "unknown"}
- Past Orders: ${JSON.stringify(customer.orders || [])}
- Total Orders: ${(customer.orders || []).length}
- Greet them by name and mention their last order if available.
- If they ordered before, ask if they want the same setup or something different.
` : `NEW CUSTOMER — no previous data.`;

  return `You are a smart, friendly customer service chatbot for KraftyBI Rentals Cebu, located in Lower Pakigne, Minglanilla. You help customers inquire about rentals and take orders.

${returningInfo}

POPULAR ITEMS THIS WEEK: ${popularItems}
(Mention popular items naturally during conversation to help guide customers.)

PRODUCTS & PRICING (all rentals max 12 hours unless noted):

KIDDIE SET:
- Kiddie Set (4ft table + 6 kiddie chairs): P180/set (12 hrs); extend to 24 hrs for +P1
- Kiddie Chair only: P15/pc
- Kiddie Table only (4ft): P120/pc

ADULT PACKAGE - INDIVIDUAL ITEMS:
- Monoblock Chair: P15/pc | Add-on: Chair cover P10/pc
- 5-Foot Table: P150/pc | Add-on: Table cover P25/pc
- 6-Foot Table: P180/pc | Add-on: Table cover P25/pc

ADULT PACKAGE - PACKAGE SETS (covers NOT included):
- Set A (20 pax): 20 monoblock chairs + 2x6ft tables + 1x5ft table = P780
- Set B (30 pax): 30 monoblock chairs + 4x6ft tables = P1,120
- Set C (50 pax): 50 monoblock chairs + 4x6ft tables + 4x5ft tables = P2,000

DELIVERY: Based on Lalamove rates. Drop-off and pick-up only, no setup provided.

LANGUAGE RULES (very strict):
- At the very start of a NEW conversation, ask: "Hello! Unsang language ang gusto nimo? / What language do you prefer? 1) Cebuano 2) English"
- For RETURNING customers, use their preferred language automatically — do NOT ask again.
- Once language is chosen, ALWAYS reply in that language ONLY. Never mix.
- NEVER add translations in parentheses.
- Use natural simple Cebuano: "Oo, naa ray table. Unsa imong event? Pila ka buok ang kelangan?"

YOUR JOB:
1. Greet customer (by name if returning). Ask language if new.
2. Ask how many guests they expect.
3. Use SMART RECOMMENDATION LOGIC below to suggest best package.
4. Do friendly upselling for covers.
5. Collect: event date, delivery address, name, contact number.
6. Summarize order with itemized total (excluding delivery).
7. Remind about Lalamove delivery fee from Minglanilla.

SMART RECOMMENDATION LOGIC:
- Find closest lower package, calculate missing items needed, then compare vs upgrading.
- Set A (20 pax) = P780 | Set B (30 pax) = P1,120 | Set C (50 pax) = P2,000
- Calculate: (package + missing items cost) vs next package price
- If difference to upgrade is P300 or less: recommend upgrading
- If difference is more than P300: recommend current package + missing items
- Always show the math so customer sees the value clearly
- For 50+ guests: Set C + extra chairs (P15/pc) and tables (P180/6ft) as needed
- For under 20 guests: individual items, mention Set A if close to 20

UPSELLING (friendly, never pushy):
After recommending package, suggest covers:
- Chair covers: P10/pc — makes chairs look elegant
- Table covers: P25/pc — gives a clean polished look
- Show total cover cost for their specific order
- If they say no, respect it and move on

MEMORY INSTRUCTIONS:
When you learn the customer's name, save it mentally and use it.
When order is confirmed, end your message with this exact tag:
ORDER_SAVED:{"name":"...","language":"...","items":[{"item":"...","qty":1,"price":0}],"subtotal":0,"date":"...","address":"...","contact":"..."}`;
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

      // Track analytics
      trackAnalytics(userText);

      await sendTyping(senderId);

      if (!conversations[senderId]) conversations[senderId] = [];
      conversations[senderId].push({ role: "user", content: userText });
      if (conversations[senderId].length > 20)
        conversations[senderId] = conversations[senderId].slice(-20);

      try {
        const systemPrompt = buildSystemPrompt(senderId);
        const reply = await callGroq(conversations[senderId], systemPrompt);

        // Check for completed order
        const orderMatch = reply.match(/ORDER_SAVED:(\{[\s\S]*?\})/);
        if (orderMatch) {
          try {
            const orderData = JSON.parse(orderMatch[1]);
            saveCustomerData(senderId, orderData);
            console.log(`Order saved for ${senderId}`);
          } catch {}
        }

        const cleanReply = reply.replace(/ORDER_SAVED:[\s\S]*/, "").trim();
        conversations[senderId].push({ role: "assistant", content: cleanReply });
        await sendMessage(senderId, cleanReply);

      } catch (err) {
        console.error("Groq API error:", err.message);
        await sendMessage(senderId, "Pasensya, may technical issue. Try again later!");
      }
    }
  }
  res.sendStatus(200);
});

// ── 3. Save Customer Data ────────────────────────────────────
function saveCustomerData(senderId, orderData) {
  const customers = loadJSON(MEMORY_FILE, {});
  if (!customers[senderId]) {
    customers[senderId] = { name: orderData.name, language: orderData.language, orders: [] };
  } else {
    if (orderData.name) customers[senderId].name = orderData.name;
    if (orderData.language) customers[senderId].language = orderData.language;
  }
  customers[senderId].orders.push({
    date: orderData.date || new Date().toISOString(),
    items: orderData.items,
    subtotal: orderData.subtotal,
    address: orderData.address,
    contact: orderData.contact
  });
  // Keep last 5 orders only
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

// ── 4. Track Analytics ───────────────────────────────────────
function trackAnalytics(text) {
  const analytics = loadJSON(ANALYTICS_FILE, { popular: {}, questions: {} });
  const keywords = ["table", "chair", "set a", "set b", "set c", "kiddie", "cover", "delivery", "price", "pila", "magkano", "naa", "available"];
  keywords.forEach(kw => {
    if (text.toLowerCase().includes(kw)) {
      analytics.questions[kw] = (analytics.questions[kw] || 0) + 1;
    }
  });
  saveJSON(ANALYTICS_FILE, analytics);
}

// ── 5. Analytics Dashboard ───────────────────────────────────
app.get("/analytics", (req, res) => {
  const analytics = loadJSON(ANALYTICS_FILE, { popular: {}, questions: {} });
  const customers = loadJSON(MEMORY_FILE, {});
  const totalCustomers = Object.keys(customers).length;
  const totalOrders = Object.values(customers).reduce((sum, c) => sum + (c.orders || []).length, 0);

  const popular = Object.entries(analytics.popular).sort((a, b) => b[1] - a[1]);
  const questions = Object.entries(analytics.questions).sort((a, b) => b[1] - a[1]);

  res.send(`
    <html><head><title>KraftyBI Analytics</title>
    <style>body{font-family:sans-serif;padding:20px;background:#f0e6ff} h1{color:#9b59b6} .card{background:#fff;border-radius:10px;padding:15px;margin:10px 0;box-shadow:0 2px 8px rgba(0,0,0,0.1)} table{width:100%;border-collapse:collapse} td,th{padding:8px;border-bottom:1px solid #eee;text-align:left} th{color:#9b59b6}</style>
    </head><body>
    <h1>KraftyBI Rentals - Bot Analytics</h1>
    <div class="card"><h3>Overview</h3>
      <p>Total Customers: <b>${totalCustomers}</b></p>
      <p>Total Orders: <b>${totalOrders}</b></p>
    </div>
    <div class="card"><h3>Popular Items Ordered</h3>
      <table><tr><th>Item</th><th>Times Ordered</th></tr>
      ${popular.map(([k,v]) => `<tr><td>${k}</td><td>${v}</td></tr>`).join("")}
      </table>
    </div>
    <div class="card"><h3>Most Asked Keywords</h3>
      <table><tr><th>Keyword</th><th>Times Asked</th></tr>
      ${questions.map(([k,v]) => `<tr><td>${k}</td><td>${v}</td></tr>`).join("")}
      </table>
    </div>
    <div class="card"><h3>Customer List</h3>
      <table><tr><th>Name</th><th>Language</th><th>Orders</th></tr>
      ${Object.values(customers).map(c => `<tr><td>${c.name||"Unknown"}</td><td>${c.language||"-"}</td><td>${(c.orders||[]).length}</td></tr>`).join("")}
      </table>
    </div>
    </body></html>
  `);
});

// ── 6. Call Groq ─────────────────────────────────────────────
async function callGroq(messages, systemPrompt) {
  const response = await axios.post(
    "https://api.groq.com/openai/v1/chat/completions",
    {
      model: "llama-3.1-8b-instant",
      messages: [{ role: "system", content: systemPrompt }, ...messages],
      max_tokens: 800,
      temperature: 0.7
    },
    { headers: { "Authorization": `Bearer ${GROQ_API_KEY}`, "Content-Type": "application/json" } }
  );
  return response.data.choices[0].message.content;
}

// ── 7. Send Message ──────────────────────────────────────────
async function sendMessage(recipientId, text) {
  const chunks = splitMessage(text, 1900);
  for (const chunk of chunks) {
    await axios.post(
      `https://graph.facebook.com/v19.0/me/messages?access_token=${PAGE_ACCESS_TOKEN}`,
      { recipient: { id: recipientId }, message: { text: chunk } }
    );
  }
}

// ── 8. Typing Indicator ──────────────────────────────────────
async function sendTyping(recipientId) {
  await axios.post(
    `https://graph.facebook.com/v19.0/me/messages?access_token=${PAGE_ACCESS_TOKEN}`,
    { recipient: { id: recipientId }, sender_action: "typing_on" }
  ).catch(() => {});
}

// ── 9. Split long messages ───────────────────────────────────
function splitMessage(text, maxLen) {
  if (text.length <= maxLen) return [text];
  const chunks = [];
  let start = 0;
  while (start < text.length) {
    let end = start + maxLen;
    if (end < text.length) {
      const breakAt = text.lastIndexOf("\n", end) || text.lastIndexOf(" ", end);
      if (breakAt > start) end = breakAt;
    }
    chunks.push(text.slice(start, end).trim());
    start = end;
  }
  return chunks;
}

// ── 10. Health Check ─────────────────────────────────────────
app.get("/", (req, res) => res.send("KraftyBI Bot is running!"));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
