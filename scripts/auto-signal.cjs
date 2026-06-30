const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));

// All keys come from GitHub Secrets — no hardcoded values
const SUPABASE_URL  = process.env.SUPABASE_URL;
const SERVICE_KEY   = process.env.SERVICE_KEY;
const ANTHROPIC_KEY = process.env.ANTHROPIC_KEY;
const METALS_KEY    = process.env.METALS_KEY;
const ONESIGNAL_APP = process.env.ONESIGNAL_APP;
const ONESIGNAL_KEY = process.env.ONESIGNAL_KEY;
const CLAUDE_MODEL  = "claude-sonnet-4-6";

async function fetchGoldPrice() {
  try {
    const res  = await fetch(`https://api.metals.dev/v1/latest?api_key=${METALS_KEY}&currency=USD&unit=toz`);
    const data = await res.json();
    if (data.metals?.gold)  return data.metals.gold;
    if (data.gold)          return data.gold;
    if (data.rates?.XAU)   return 1 / data.rates.XAU;
  } catch(e) { console.log("metals.dev failed:", e.message); }
  try {
    const res  = await fetch("https://api.coingecko.com/api/v3/simple/price?ids=pax-gold&vs_currencies=usd");
    const data = await res.json();
    if (data["pax-gold"]?.usd) return data["pax-gold"].usd;
  } catch(e) { console.log("CoinGecko failed:", e.message); }
  return 4088.00;
}

async function generateSignal(goldPrice) {
  const priceStr = goldPrice.toFixed(2);
  const prompt = `You are an elite Gold trading analyst. Current XAU/USD spot price: $${priceStr}.
Generate ONE high-probability trade signal. Consider key support/resistance near this price.
Respond ONLY with valid JSON:
{"direction":"BUY","entry":${priceStr},"tp1":0.00,"tp2":0.00,"sl":0.00,"confidence":78,"timeframe":"1H","analysis":"2-3 sentence professional analysis.","tags":["EMA support","NY session","Gold"]}`;

  const res  = await fetch("https://api.anthropic.com/v1/messages", {
    method:  "POST",
    headers: { "Content-Type":"application/json","x-api-key":ANTHROPIC_KEY,"anthropic-version":"2023-06-01" },
    body:    JSON.stringify({ model:CLAUDE_MODEL, max_tokens:350, messages:[{role:"user",content:prompt}] })
  });
  const data  = await res.json();
  const text  = data.content?.[0]?.text || "";
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error("No JSON in AI response: " + text.substring(0,200));
  const sig = JSON.parse(match[0]);

  const near = (p) => p > 0 && p > goldPrice * 0.98 && p < goldPrice * 1.02;
  if (!near(sig.entry)) sig.entry = goldPrice;
  if (!near(sig.sl))    sig.sl    = sig.direction==="BUY" ? +(goldPrice*0.995).toFixed(2) : +(goldPrice*1.005).toFixed(2);
  if (!near(sig.tp1))   sig.tp1   = sig.direction==="BUY" ? +(goldPrice*1.005).toFixed(2) : +(goldPrice*0.995).toFixed(2);
  if (!near(sig.tp2))   sig.tp2   = sig.direction==="BUY" ? +(goldPrice*1.010).toFixed(2) : +(goldPrice*0.990).toFixed(2);

  const slD = Math.abs(sig.entry - sig.sl);
  const tpD = Math.abs(sig.tp2  - sig.entry);
  sig.rr    = slD > 0 ? Math.round((tpD/slD)*100)/100 : 2.00;
  return sig;
}

async function postToSupabase(signal) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/signals`, {
    method:  "POST",
    headers: { "Content-Type":"application/json","apikey":SERVICE_KEY,"Authorization":`Bearer ${SERVICE_KEY}`,"Prefer":"return=representation" },
    body: JSON.stringify({
      symbol:"XAU/USD", market:"Gold", exchange:"COMEX",
      timeframe:  signal.timeframe || "1H",
      direction:  signal.direction,
      entry:      signal.entry,
      tp1:        signal.tp1,
      tp2:        signal.tp2,
      sl:         signal.sl,
      rr:         signal.rr,
      confidence: signal.confidence,
      status:     "ACTIVE",
      analysis:   signal.analysis,
      tags:       signal.tags || ["Auto Signal", "XAU/USD"],
      issued_at:  new Date().toISOString(),
      updated_at: new Date().toISOString()
    })
  });
  if (!res.ok) throw new Error(`Supabase ${res.status}: ${await res.text()}`);
  return (await res.json())[0];
}

async function sendPush(signal) {
  const emoji = signal.direction === "BUY" ? "📈" : "📉";
  const entry = parseFloat(signal.entry).toFixed(2);
  const tp1   = parseFloat(signal.tp1).toFixed(2);
  const sl    = parseFloat(signal.sl).toFixed(2);
  const rr    = parseFloat(signal.rr).toFixed(2);

  const res = await fetch("https://onesignal.com/api/v1/notifications", {
    method:  "POST",
    headers: { "Content-Type":"application/json","Authorization":`Bearer ${ONESIGNAL_KEY}` },
    body: JSON.stringify({
      app_id:            ONESIGNAL_APP,
      included_segments: ["All"],
      headings:          { en: `${emoji} XAU/USD ${signal.direction} Signal` },
      contents:          { en: `Entry $${entry} · TP1 $${tp1} · SL $${sl} · R:R 1:${rr} · ${signal.confidence}% confidence` },
      data:              { type: "new_signal", direction: signal.direction },
      ios_sound:         "default",
      android_sound:     "default",
      priority:          10
    })
  });
  const data = await res.json();
  console.log("🔔 Push sent:", data.id || JSON.stringify(data).substring(0,100));
}

async function main() {
  console.log(`\n🚀 Liquid Guide Auto Signal — ${new Date().toISOString()}`);
  console.log("─".repeat(50));
  const gold   = await fetchGoldPrice();
  console.log(`💰 Live Gold Price: $${gold.toFixed(2)}`);
  const signal = await generateSignal(gold);
  console.log(`🤖 ${signal.direction} Entry:$${signal.entry} TP1:$${signal.tp1} SL:$${signal.sl} RR:${signal.rr} Conf:${signal.confidence}%`);
  const posted = await postToSupabase(signal);
  console.log(`✅ Posted to Supabase: ${posted.id}`);
  await sendPush(signal);
  console.log(`✅ Complete!`);
}

main().catch(e => { console.error("❌ Error:", e.message); process.exit(1); });
