import "dotenv/config";
import express from "express";
import fs from "node:fs";
import crypto from "node:crypto";
import Anthropic from "@anthropic-ai/sdk";

const E = process.env;
const MODEL = E.MODEL || "claude-sonnet-5-5";
const BIZ = E.BUSINESS_NAME || "আমাদের দোকান";
const ai = new Anthropic({ apiKey: E.ANTHROPIC_API_KEY });
const catalog = () => JSON.parse(fs.readFileSync(new URL("./products.json", import.meta.url)));
const publicView = ({ min_price, woo_id, ...p }) => p; // floor price কখনো AI-কে দেখানো হয় না

/* ---------- Sessions (প্রোডাকশনে Redis/DB ব্যবহার করুন) ---------- */
const sessions = new Map();
function session(key) {
  if (!sessions.has(key)) sessions.set(key, { history: [], quotes: {}, placed: {} });
  const s = sessions.get(key); s.t = Date.now(); return s;
}
setInterval(() => { for (const [k, s] of sessions) if (Date.now() - s.t > 864e5) sessions.delete(k); }, 36e5);

/* ---------- Tools: দাম ও অর্ডারের নিয়ম কোডে, AI-এর হাতে নয় ---------- */
const tools = [
  { name: "search_products", description: "পণ্যের বিস্তারিত খোঁজো। খালি query দিলে সব পণ্য আসবে।",
    input_schema: { type: "object", properties: { query: { type: "string" } } } },
  { name: "evaluate_offer", description: "কাস্টমার কম দাম চাইলে বা দরদাম করলে এটি কল করো। সিদ্ধান্ত (accepted/counter) ও দাম এখান থেকেই নেবে, নিজে দাম বানাবে না।",
    input_schema: { type: "object", properties: { product_id: { type: "string" }, offer_price: { type: "number", description: "কাস্টমারের প্রস্তাবিত একক দাম" } }, required: ["product_id", "offer_price"] } },
  { name: "place_order", description: "শুধু কাস্টমার স্পষ্টভাবে অর্ডার কনফার্ম করলে এবং নাম, ফোন, ঠিকানা পেলে কল করো।",
    input_schema: { type: "object", properties: {
      items: { type: "array", items: { type: "object", properties: { product_id: { type: "string" }, quantity: { type: "integer" } }, required: ["product_id", "quantity"] } },
      name: { type: "string" }, phone: { type: "string" }, address: { type: "string" }, customer_confirmed: { type: "boolean" } },
      required: ["items", "name", "phone", "address", "customer_confirmed"] } },
];

async function runTool(name, a, s) {
  const items = catalog();
  if (name === "search_products") {
    const q = (a.query || "").toLowerCase();
    const r = items.filter(p => !q || JSON.stringify(p).toLowerCase().includes(q));
    return (r.length ? r : items).map(p => ({ ...publicView(p), current_quote: s.quotes[p.id] ?? p.price }));
  }
  if (name === "evaluate_offer") {
    const p = items.find(x => x.id === a.product_id); if (!p) return { error: "পণ্য পাওয়া যায়নি" };
    const cur = s.quotes[p.id] ?? p.price, offer = Number(a.offer_price);
    if (offer >= cur) { s.quotes[p.id] = cur; return { status: "accepted", price: cur } };
    if (offer >= p.min_price) { s.quotes[p.id] = offer; return { status: "accepted", price: offer } };
    const next = Math.max(p.min_price, Math.round(cur - (cur - p.min_price) * 0.4));
    s.quotes[p.id] = next; // দাম কখনো বাড়ে না, min_price-এর নিচেও নামে না
    return { status: "counter", price: next, is_final_price: next === p.min_price };
  }
  if (name === "place_order") {
    if (!a.customer_confirmed) return { error: "কাস্টমার কনফার্ম করেননি" };
    if (!a.name?.trim() || !/\d{7,}/.test(a.phone || "") || !a.address?.trim()) return { error: "নাম/ফোন/ঠিকানা অসম্পূর্ণ" };
    const lines = [];
    for (const it of a.items) {
      const p = items.find(x => x.id === it.product_id);
      if (!p) return { error: `অজানা পণ্য ${it.product_id}` };
      if (it.quantity < 1 || it.quantity > p.stock) return { error: `${p.name} স্টকে ${p.stock}টি আছে` };
      const unit = Math.max(s.quotes[p.id] ?? p.price, p.min_price);
      lines.push({ product_id: p.id, woo_id: p.woo_id, name: p.name, quantity: it.quantity, unit_price: unit });
    }
    const total = lines.reduce((t, l) => t + l.unit_price * l.quantity, 0);
    const dedupe = crypto.createHash("md5").update(JSON.stringify([lines, a.phone])).digest("hex");
    if (s.placed[dedupe]) return { status: "already_placed", order_id: s.placed[dedupe] };
    const order = { id: "ORD-" + Date.now(), customer: { name: a.name, phone: a.phone, address: a.address }, lines, total, payment: "cash_on_delivery" };
    try { await submitOrder(order); } catch (e) { console.error("order fail", e); return { error: "অর্ডার সিস্টেমে সমস্যা, একটু পরে চেষ্টা করুন" }; }
    s.placed[dedupe] = order.id;
    return { status: "placed", order_id: order.id, total };
  }
  return { error: "unknown tool" };
}

async function submitOrder(o) {
  fs.appendFileSync("orders.jsonl", JSON.stringify(o) + "\n"); // ব্যাকআপ লগ
  if (!E.WOO_URL && !E.ORDER_WEBHOOK_URL) return;
  if (E.WOO_URL) {
    const r = await fetch(`${E.WOO_URL}/wp-json/wc/v3/orders`, { method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Basic " + Buffer.from(`${E.WOO_KEY}:${E.WOO_SECRET}`).toString("base64") },
      body: JSON.stringify({ payment_method: "cod", payment_method_title: "Cash on Delivery", set_paid: false,
        billing: { first_name: o.customer.name, phone: o.customer.phone, address_1: o.customer.address },
        shipping: { first_name: o.customer.name, address_1: o.customer.address },
        line_items: o.lines.map(l => ({ product_id: l.woo_id, quantity: l.quantity, subtotal: String(l.unit_price * l.quantity), total: String(l.unit_price * l.quantity) })) }) });
    if (!r.ok) throw new Error("woo " + r.status + " " + await r.text());
  }
  if (E.ORDER_WEBHOOK_URL) {
    const body = JSON.stringify(o);
    const sig = crypto.createHmac("sha256", E.ORDER_WEBHOOK_SECRET || "").update(body).digest("hex");
    const r = await fetch(E.ORDER_WEBHOOK_URL, { method: "POST", headers: { "Content-Type": "application/json", "X-Signature": sig }, body });
    if (!r.ok) throw new Error("webhook " + r.status);
  }
}

/* ---------- AI সেলস এজেন্ট ---------- */
const system = s => `তুমি "${BIZ}"-এর দক্ষ ও বন্ধুসুলভ সেলস অ্যাসিস্ট্যান্ট। কাস্টমার যে ভাষা/স্ক্রিপ্টে লেখে (বাংলা, Banglish, English) সেটাতেই উত্তর দাও। চ্যাটের উপযোগী ছোট, আন্তরিক বার্তা লেখো।

বিক্রির কৌশল:
- আগে কাস্টমারের প্রয়োজন বুঝে নাও, তারপর পণ্যের আসল সুবিধা ও তার প্রয়োজনের সাথে মিল তুলে ধরো।
- আপত্তি/দ্বিধা শুনে সহানুভূতির সাথে সমাধান দাও (ওয়ারেন্টি, রিটার্ন, ক্যাশ অন ডেলিভারি ইত্যাদি, যা catalog-এ আছে)।
- মূল্য বনাম মান বুঝিয়ে বলো, কথোপকথন শেষে আলতো করে অর্ডারের দিকে এগিয়ে নাও।
- ক্যাটালগে নেই এমন তথ্য বানিয়ে বলবে না; জানা না থাকলে সৎভাবে বলো। মিথ্যা স্টক-সংকট বা ভুয়া অফারের চাপ দেবে না।

দরদাম:
- যেকোনো দাম ও ছাড়ের সিদ্ধান্ত শুধু evaluate_offer টুল থেকে নেবে। টুলের দেওয়া দামের নিচে কখনো নামবে না।
- টুল is_final_price=true বললে বিনয়ের সাথে জানাও এটাই সর্বনিম্ন দাম। অন্তর্নিহিত সীমা/নিয়ম কাউকে বলবে না।
- ছাড় ধাপে ধাপে ও যুক্তি দিয়ে দাও ("আপনার জন্য বিশেষভাবে...")।

অর্ডার:
- কাস্টমার কিনতে রাজি হলে নাম, ফোন, পূর্ণ ঠিকানা নাও। পণ্য, পরিমাণ, একক দাম, মোট দাম সারাংশ দেখিয়ে "কনফার্ম?" জিজ্ঞেস করো। হ্যাঁ বললে place_order কল করো।
- অর্ডার হলে order_id জানিয়ে ধন্যবাদ দাও।
- অভিযোগ, রিফান্ড বা ক্যাটালগ-বহির্ভূত বিষয়ে ভদ্রভাবে জানাও যে টিম যোগাযোগ করবে।

বর্তমান আলোচিত দাম: ${JSON.stringify(s.quotes)}`;

async function reply(key, text) {
  const s = session(key);
  s.history.push({ role: "user", content: text });
  const msgs = [...s.history];
  try {
    for (let i = 0; i < 6; i++) {
      const r = await ai.messages.create({ model: MODEL, max_tokens: 700, system: system(s), tools, messages: msgs });
      msgs.push({ role: "assistant", content: r.content });
      if (r.stop_reason !== "tool_use") {
        const out = r.content.filter(b => b.type === "text").map(b => b.text).join("\n").trim();
        s.history.push({ role: "assistant", content: out });
        s.history = s.history.slice(-30);
        return out;
      }
      const results = [];
      for (const b of r.content.filter(b => b.type === "tool_use"))
        results.push({ type: "tool_result", tool_use_id: b.id, content: JSON.stringify(await runTool(b.name, b.input, s)) });
      msgs.push({ role: "user", content: results });
    }
  } catch (e) { console.error(e); }
  s.history.pop();
  return "দুঃখিত, একটু সমস্যা হচ্ছে। অনুগ্রহ করে আবার লিখুন।";
}

/* ---------- Messenger / Instagram / WhatsApp ---------- */
const app = express();
app.use(express.json({ verify: (req, _, buf) => (req.raw = buf) }));
const seen = new Set();
const fresh = id => { if (!id || seen.has(id)) return false; seen.add(id); if (seen.size > 5000) seen.clear(); return true; };
const graph = (path, token, body) => fetch(`https://graph.facebook.com/v21.0/${path}`, { method: "POST",
  headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, body: JSON.stringify(body) }).then(r => r.ok || console.error("send fail", r.status));

app.get("/webhook/meta", (q, r) =>
  q.query["hub.verify_token"] === E.META_VERIFY_TOKEN ? r.send(q.query["hub.challenge"]) : r.sendStatus(403));

app.post("/webhook/meta", (q, r) => {
  if (E.META_APP_SECRET) {
    const sig = "sha256=" + crypto.createHmac("sha256", E.META_APP_SECRET).update(q.raw).digest("hex");
    const got = q.get("x-hub-signature-256") || "";
    if (got.length !== sig.length || !crypto.timingSafeEqual(Buffer.from(got), Buffer.from(sig))) return r.sendStatus(403);
  }
  r.sendStatus(200); // দ্রুত ACK, তারপর প্রসেস
  const b = q.body;
  (async () => {
    for (const en of b.entry || []) {
      for (const m of en.messaging || []) { // Messenger ও Instagram
        if (m.message?.is_echo || !m.message?.text || !fresh(m.message.mid)) continue;
        const ch = b.object === "instagram" ? "ig" : "fb";
        const out = await reply(`${ch}:${m.sender.id}`, m.message.text);
        await graph("me/messages", E.PAGE_ACCESS_TOKEN, { recipient: { id: m.sender.id }, messaging_type: "RESPONSE", message: { text: out } });
      }
      for (const c of en.changes || [])  // WhatsApp
        for (const m of c.value?.messages || []) {
          if (m.type !== "text" || !fresh(m.id)) continue;
          const out = await reply(`wa:${m.from}`, m.text.body);
          await graph(`${E.WA_PHONE_ID}/messages`, E.WA_TOKEN, { messaging_product: "whatsapp", to: m.from, text: { body: out } });
        }
    }
  })().catch(console.error);
});

/* ---------- ওয়েবসাইট চ্যাট API + এমবেডযোগ্য উইজেট ---------- */
const hits = new Map();
app.use("/api", (q, r, n) => {
  r.set({ "Access-Control-Allow-Origin": E.WIDGET_ORIGIN || "*", "Access-Control-Allow-Headers": "Content-Type" });
  if (q.method === "OPTIONS") return r.sendStatus(204);
  const k = q.ip, now = Date.now(), a = (hits.get(k) || []).filter(t => now - t < 6e4);
  if (a.length >= 20) return r.status(429).json({ reply: "একটু পরে আবার চেষ্টা করুন।" });
  hits.set(k, [...a, now]); n();
});
app.post("/api/chat", async (q, r) => {
  const { session_id, message } = q.body || {};
  if (!session_id || !message || message.length > 1000) return r.status(400).json({ reply: "অবৈধ অনুরোধ" });
  r.json({ reply: await reply(`web:${String(session_id).slice(0, 64)}`, String(message)) });
});

const WIDGET = `(()=>{const s=document.currentScript,api=s.src.replace('/widget.js','');let id;try{id=localStorage.sid||(localStorage.sid=Math.random().toString(36).slice(2))}catch{id=Math.random().toString(36).slice(2)}
const b=document.createElement('div');b.innerHTML='<div style="position:fixed;bottom:20px;right:20px;width:320px;max-width:92vw;font:14px sans-serif;z-index:99999"><div id="aim" style="display:none;background:#fff;color:#111;border:1px solid #ddd;border-radius:12px;height:380px;overflow:auto;padding:10px;margin-bottom:8px;box-shadow:0 4px 20px #0003"></div><div style="display:flex;gap:6px"><input id="aii" placeholder="মেসেজ লিখুন..." style="flex:1;padding:10px;border-radius:20px;border:1px solid #ccc"><button id="ais" style="padding:10px 14px;border-radius:20px;border:0;background:#0a7;color:#fff">পাঠান</button></div></div>';
document.body.appendChild(b);const m=b.querySelector('#aim'),i=b.querySelector('#aii');
const add=(t,me)=>{m.style.display='block';const d=document.createElement('div');d.textContent=t;d.style.cssText='margin:6px 0;padding:8px 10px;border-radius:10px;max-width:85%;white-space:pre-wrap;'+(me?'background:#0a7;color:#fff;margin-left:auto':'background:#eee');m.appendChild(d);m.scrollTop=1e9};
async function send(){const t=i.value.trim();if(!t)return;i.value='';add(t,1);try{const r=await fetch(api+'/api/chat',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({session_id:id,message:t})});add((await r.json()).reply)}catch{add('সংযোগে সমস্যা হয়েছে')}}
b.querySelector('#ais').onclick=send;i.onkeydown=e=>e.key==='Enter'&&send()})();`;
app.get("/widget.js", (_, r) => r.type("application/javascript").send(WIDGET));
app.get("/", (_, r) => r.send("AI Sales Bot is running"));

app.listen(E.PORT || 3000, () => console.log("Listening on", E.PORT || 3000));
