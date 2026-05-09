// ============================================================
//  KraftyBI Rentals Cebu — Facebook Messenger Webhook Server
//  Powered by Groq (FREE & FAST)
//  Deploy this to Render.com (free tier)
// ============================================================

const express = require("express");
const axios = require("axios");
const app = express();
app.use(express.json());

// ── ENV VARIABLES (set these in Render dashboard) ────────────
const PAGE_ACCESS_TOKEN = process.env.PAGE_ACCESS_TOKEN;
const VERIFY_TOKEN      = process.env.VERIFY_TOKEN;
const GROQ_API_KEY      = process.env.GROQ_API_KEY;

// ── Conversation memory (per user) ──────────────────────────
const conversations = {};

// ── System prompt for KraftyBI ───────────────────────────────
const SYSTEM_PROMPT = `You are a friendly customer service chatbot for KraftyBI Rentals Cebu, located in Lower Pakigne, Minglanilla. You help customers inquire about rentals and take orders.

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

YOUR JOB:
1. At the very start, ask language preference: "Hello! Unsang language ang gusto nimo? / What language do you prefer? 1) Cebuano 2) English"
2. After language is chosen, greet warmly and ask: "Pila ka buok ang imong mga bisita?" (How many guests?)
3. Based on guest count, ALWAYS recommend the best package and show savings:

   PACKAGE COMPARISON (use this to calculate savings):
   - Set A (20 pax) = P780
     * If bought individually: 20 chairs (P300) + 2x6ft tables (P360) + 1x5ft table (P150) = P810
     * SAVINGS: P30
   - Set B (30 pax) = P1,120
     * If bought individually: 30 chairs (P450) + 4x6ft tables (P720) = P1,170
     * SAVINGS: P50
   - Set C (50 pax) = P2,000
     * If bought individually: 50 chairs (P750) + 4x6ft tables (P720) + 4x5ft tables (P600) = P2,070
     * SAVINGS: P70

   RECOMMENDATION LOGIC:
   - 1-19 guests: Suggest individual items, but mention Set A is available if they expect more guests
   - 20 guests: Recommend Set A — saves P30 vs individual
   - 21-29 guests: Recommend Set A + extra individual items
   - 30 guests: Recommend Set B — saves P50 vs individual
   - 31-49 guests: Recommend Set B + extra individual items
   - 50+ guests: Recommend Set C — saves P70 vs individual

4. Always show the math clearly so the customer sees the savings.
UPSELLING (do this naturally and friendly, never pushy):
After recommending a package, ALWAYS suggest covers as an upgrade:

Cebuano example:
"Gusto sad nimo nga mas maganda ang imong event? Pwede ta mag-add og covers!
- Chair cover: P10 ra kada usa — perfect para mas elegant ang tan-aw sa mga lingkuranan
- Table cover: P25 ra kada mesa — mas presentable ang imong setup, siguradong ma-impress ang imong mga bisita!
Para sa Set A (20 chairs + 3 tables): P10x20 + P25x3 = P200 ra para mas gandang event!"

English example:
"Want to make your event look extra beautiful? We offer covers too!
- Chair covers: only P10 each — makes your chairs look elegant and classy
- Table covers: only P25 each — gives your setup a clean, polished look your guests will love!
For Set A (20 chairs + 3 tables): just P200 more for a much prettier setup!"

UPSELLING RULES:
- Always mention covers AFTER recommending the package
- Show the total cost of covers so it feels affordable
- Emphasize how it improves the event look
- Never force it — if they say no, respect it and move on
- If they say yes, add covers to the order summary
- Make it sound exciting, not salesy
6. Collect: event date, delivery address, name, contact number.
7. Summarize the full order with itemized total (excluding delivery).
8. Remind them delivery fee is based on Lalamove rate from Minglanilla.

LANGUAGE RULES (very strict):
- At the very start of EVERY new conversation, ask: "Hello! Unsang language ang gusto nimo? / What language do you prefer? 1) Cebuano 2) English"
- Once the customer picks a language, ALWAYS reply in that language ONLY. Never mix.
- If they pick Cebuano: reply in pure natural Cebuano/Bisaya as spoken in Cebu. No English translations in parentheses. No mixing.
- If they pick English: reply in pure English only. No Bisaya mixing.
- If customer doesn't pick and just types in Cebuano, reply in pure Cebuano only.
- If customer types in English without picking, reply in pure English only.
- NEVER add translations in parentheses like "(Do we have tables? Yes, we do!)"
- NEVER mix two languages in one reply.
- Use natural, simple, everyday Cebuano — not formal. Example: "Oo, naa ra tay table. Unsa imong event? Pila ka buok ang kelangan?" NOT "Oo, may kita na tay table! (Yes, we do have tables!)"`;

// ── 1. Webhook Verification ──────────────────────────────────
app.get("/webhook", (req, res) => {
  const mode      = req.query["hub.mode"];
  const token     = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    console.log("Webhook verified!");
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

      console.log(`Message from ${senderId}: ${userText}`);

      await sendTyping(senderId);

      if (!conversations[senderId]) conversations[senderId] = [];
      conversations[senderId].push({ role: "user", content: userText });

      // Keep last 20 messages
      if (conversations[senderId].length > 20) {
        conversations[senderId] = conversations[senderId].slice(-20);
      }

      try {
        const reply = await callGroq(conversations[senderId]);
        conversations[senderId].push({ role: "assistant", content: reply });
        await sendMessage(senderId, reply);
        console.log(`Reply sent to ${senderId}`);
      } catch (err) {
        console.error("Groq API error:", err.message);
        await sendMessage(senderId, "Pasensya, may technical issue. Try again later!");
      }
    }
  }

  res.sendStatus(200);
});

// ── 3. Call Groq API (Free & Fast) ──────────────────────────
async function callGroq(messages) {
  const response = await axios.post(
    "https://api.groq.com/openai/v1/chat/completions",
    {
      model: "llama-3.1-8b-instant",
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        ...messages
      ],
      max_tokens: 800,
      temperature: 0.7
    },
    {
      headers: {
        "Authorization": `Bearer ${GROQ_API_KEY}`,
        "Content-Type": "application/json"
      }
    }
  );
  return response.data.choices[0].message.content;
}

// ── 4. Send Message to Facebook Messenger ───────────────────
async function sendMessage(recipientId, text) {
  const chunks = splitMessage(text, 1900);
  for (const chunk of chunks) {
    await axios.post(
      `https://graph.facebook.com/v19.0/me/messages?access_token=${PAGE_ACCESS_TOKEN}`,
      { recipient: { id: recipientId }, message: { text: chunk } }
    );
  }
}

// ── 5. Typing Indicator ──────────────────────────────────────
async function sendTyping(recipientId) {
  await axios.post(
    `https://graph.facebook.com/v19.0/me/messages?access_token=${PAGE_ACCESS_TOKEN}`,
    { recipient: { id: recipientId }, sender_action: "typing_on" }
  ).catch(() => {});
}

// ── 6. Split long messages ───────────────────────────────────
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

// ── 7. Health Check ─────────────────────────────────────────
app.get("/", (req, res) => res.send("KraftyBI Bot is running!"));

// ── Start Server ─────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
