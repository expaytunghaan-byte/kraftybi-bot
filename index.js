// ============================================================
//  KraftyBI Rentals Cebu — Facebook Messenger Webhook Server
//  Deploy this to Render.com (free tier)
// ============================================================

const express = require("express");
const axios = require("axios");
const app = express();
app.use(express.json());

// ── ENV VARIABLES (set these in Render dashboard) ────────────
const PAGE_ACCESS_TOKEN = process.env.PAGE_ACCESS_TOKEN;   // From Meta Developer App
const VERIFY_TOKEN      = process.env.VERIFY_TOKEN;        // Any secret word you choose
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;   // From console.anthropic.com

// ── Conversation memory (per user session) ───────────────────
const conversations = {};

// ── System prompt for KraftyBI ───────────────────────────────
const SYSTEM_PROMPT = `You are a friendly customer service chatbot for KraftyBI Rentals Cebu, located in Lower Pakigne, Minglanilla. You help customers inquire about rentals and take orders.

PRODUCTS & PRICING (all rentals max 12 hours unless noted):

KIDDIE SET:
- Kiddie Set (4ft table + 6 kiddie chairs): ₱180/set (12 hrs); extend to 24 hrs for +₱1
- Kiddie Chair only: ₱15/pc
- Kiddie Table only (4ft): ₱120/pc

ADULT PACKAGE – INDIVIDUAL ITEMS:
- Monoblock Chair: ₱15/pc | Add-on: Chair cover ₱10/pc
- 5-Foot Table: ₱150/pc | Add-on: Table cover ₱25/pc
- 6-Foot Table: ₱180/pc | Add-on: Table cover ₱25/pc

ADULT PACKAGE – PACKAGE SETS (covers NOT included):
- Set A (20 pax): 20 monoblock chairs + 2×6ft tables + 1×5ft table = ₱780
- Set B (30 pax): 30 monoblock chairs + 4×6ft tables = ₱1,120
- Set C (50 pax): 50 monoblock chairs + 4×6ft tables + 4×5ft tables = ₱2,000

DELIVERY: Based on Lalamove rates. Drop-off and pick-up only, no setup provided.

YOUR JOB:
1. Greet customers warmly.
2. Help them choose the right items for their event.
3. Collect: items, quantities, add-ons, event date, delivery address, name, contact number.
4. Summarize the order with itemized total (excluding delivery).
5. Remind them delivery fee is based on Lalamove rate from Minglanilla.

LANGUAGE DETECTION (very important):
- Default to Cebuano/Bisaya since the business is in Cebu.
- If customer writes in Cebuano, reply in Cebuano.
- If customer writes in Tagalog/Taglish, reply in Tagalog/Taglish.
- If customer writes in English, reply in English.
- Use warm, natural everyday Bisaya (e.g. "Salamat!", "Unsa imong event?", "Pila ka buok?", "Naa mi ana!").`;

// ── 1. Webhook Verification (Meta requires this) ─────────────
app.get("/webhook", (req, res) => {
  const mode      = req.query["hub.mode"];
  const token     = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    console.log("✅ Webhook verified!");
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

// ── 2. Receive Messages from Facebook ───────────────────────
app.post("/webhook", async (req, res) => {
  const body = req.body;

  if (body.object !== "page") return res.sendStatus(404);

  for (const entry of body.entry) {
    for (const event of entry.messaging) {
      if (!event.message || event.message.is_echo) continue;

      const senderId = event.sender.id;
      const userText = event.message.text;

      if (!userText) continue;

      console.log(`📩 Message from ${senderId}: ${userText}`);

      // Show typing indicator
      await sendTyping(senderId);

      // Get or create conversation history
      if (!conversations[senderId]) {
        conversations[senderId] = [];
      }

      // Add user message to history
      conversations[senderId].push({ role: "user", content: userText });

      // Keep last 20 messages to avoid token limits
      if (conversations[senderId].length > 20) {
        conversations[senderId] = conversations[senderId].slice(-20);
      }

      try {
        // Call Claude API
        const reply = await callClaude(conversations[senderId]);

        // Add assistant reply to history
        conversations[senderId].push({ role: "assistant", content: reply });

        // Send reply to Facebook
        await sendMessage(senderId, reply);
      } catch (err) {
        console.error("Claude API error:", err.message);
        await sendMessage(senderId, "Pasensya, may technical issue. Try again later! 😅");
      }
    }
  }

  res.sendStatus(200);
});

// ── 3. Call Claude (Anthropic API) ──────────────────────────
async function callClaude(messages) {
  const response = await axios.post(
    "https://api.anthropic.com/v1/messages",
    {
      model: "claude-sonnet-4-20250514",
      max_tokens: 1000,
      system: SYSTEM_PROMPT,
      messages,
    },
    {
      headers: {
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json",
      },
    }
  );
  return response.data.content[0].text;
}

// ── 4. Send Message to Facebook Messenger ───────────────────
async function sendMessage(recipientId, text) {
  // Facebook has a 2000 char limit per message — split if needed
  const chunks = splitMessage(text, 1900);

  for (const chunk of chunks) {
    await axios.post(
      `https://graph.facebook.com/v19.0/me/messages?access_token=${PAGE_ACCESS_TOKEN}`,
      {
        recipient: { id: recipientId },
        message: { text: chunk },
      }
    );
  }
}

// ── 5. Typing Indicator ──────────────────────────────────────
async function sendTyping(recipientId) {
  await axios.post(
    `https://graph.facebook.com/v19.0/me/messages?access_token=${PAGE_ACCESS_TOKEN}`,
    {
      recipient: { id: recipientId },
      sender_action: "typing_on",
    }
  ).catch(() => {}); // Ignore typing errors
}

// ── 6. Split long messages ───────────────────────────────────
function splitMessage(text, maxLen) {
  if (text.length <= maxLen) return [text];
  const chunks = [];
  let start = 0;
  while (start < text.length) {
    let end = start + maxLen;
    if (end < text.length) {
      // Try to break at a newline or space
      const breakAt = text.lastIndexOf("\n", end) || text.lastIndexOf(" ", end);
      if (breakAt > start) end = breakAt;
    }
    chunks.push(text.slice(start, end).trim());
    start = end;
  }
  return chunks;
}

// ── 7. Health Check ─────────────────────────────────────────
app.get("/", (req, res) => res.send("KraftyBI Bot is running! 🎉"));

// ── Start Server ─────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
