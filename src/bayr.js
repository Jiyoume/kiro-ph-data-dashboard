/**
 * BAYR — BIR Analytics Your Reporter
 * In-browser chatbot powered by DuckDB-WASM queries against PSCG data.
 */
import { queryRows } from './loader.js';

// ── Helpers ───────────────────────────────────────────────────
function fmtM(v) {
  const n = Number(v);
  if (n >= 1_000_000) return `${(n/1_000_000).toFixed(2)} Trillion`;
  if (n >= 1_000) return `${(n/1_000).toFixed(1)} Billion`;
  return `${n.toFixed(1)} Million`;
}
function shortRegion(r) { return r?.replace(/^Region\s+\S+\s+\((.+)\)$/, '$1') || r; }
function extractYear(m) { const match = m.match(/\b(200[5-9]|201\d|202[0-4])\b/); return match ? Number(match[1]) : null; }
function extractRegion(m) {
  const regions = ['ncr','car','barmm','ilocos','cagayan','central luzon','calabarzon','mimaropa','bicol','western visayas','central visayas','eastern visayas','zamboanga','northern mindanao','davao','soccsksargen','caraga'];
  const lower = m.toLowerCase();
  return regions.find(r => lower.includes(r)) || null;
}
function noData() { return `I couldn't find data for that query. Try specifying a year (2005–2024) or region.`; }

// ── FAQs ──────────────────────────────────────────────────────
const FAQS = {
  'what is bir': 'BIR (Bureau of Internal Revenue) is the Philippines\' primary tax collection agency under the Department of Finance.',
  'what is pscg': 'PSCG (Philippine Standard Geographic Code) is the PSA classification for administrative divisions. This dataset maps BIR collections to 17 regions across 2005–2024.',
  'what is yoy': 'YoY (Year-over-Year) measures % change vs the prior year. Positive = growth, negative = decline.',
  'what is ncr': 'NCR (National Capital Region / Metro Manila) contributes 38–45% of all BIR collections nationally.',
  'what is lts': 'Large Taxpayers Service handles the biggest corporate clients (multinationals, publicly-listed companies) under NCR.',
  'covid impact': 'COVID caused a revenue dip in 2020. Regional drops ranged -15% to -19%. All regions recovered by 2022.',
  'how many regions': 'The dataset covers 17 regions + LTS, with 101 provinces/cities, across CY 2005–2024 (20 years).',
  'tax refund': 'Tax Refund is overpaid tax returned to taxpayers, deducted from Gross to get Net Collection. Only recorded from 2015+.',
};

const QUICK_REPLIES = [
  'Top region in 2024?',
  'National total 2024',
  'Top 5 provinces',
  'COVID impact',
  'What is BIR?',
  'Compare 2019 vs 2024',
];

// ── Intent handler ────────────────────────────────────────────
async function handleMessage(conn, message, filters) {
  const m = message.trim();
  const lower = m.toLowerCase();

  // Greetings
  if (/^(hi|hello|hey|good\s+(morning|afternoon|evening))/.test(lower)) {
    return `Hello! I'm **BAYR** 👋 Ask me about BIR tax collections 2005–2024. Try:\n• "Top region in 2024"\n• "How much did NCR collect?"\n• "Compare 2019 vs 2024"`;
  }
  if (/^(help|what can you|capabilities)/.test(lower)) {
    return `I answer **data questions** about BIR collections:\n📊 Revenue totals & rankings\n📈 YoY growth & trends\n🗺️ Regional comparisons\n🏙️ Province detail\n📖 FAQs (BIR, PSCG, NCR, LTS)`;
  }

  // FAQ match
  for (const [key, answer] of Object.entries(FAQS)) {
    if (lower.includes(key)) return answer;
  }

  const yr = extractYear(m) || (filters?.yearMax || 2024);
  const region = extractRegion(m);

  // Top region
  if (/top\s+region|best\s+region|highest\s+region|#1\s+region/i.test(m)) {
    const rows = await queryRows(conn, `SELECT particulars, amount_millions FROM collections WHERE row_type='region' AND year=${yr} AND particulars!='Large Taxpayers Service' ORDER BY amount_millions DESC LIMIT 1`);
    if (!rows.length) return noData();
    return `📍 **Top region ${yr}:** ${rows[0].particulars}\n💰 ₱${fmtM(rows[0].amount_millions)}`;
  }

  // National total
  if (/national|total collection|net collection|overall|how much.*philippines/i.test(m)) {
    const rows = await queryRows(conn, `SELECT amount_millions FROM collections WHERE particulars='Total Collection - Net of Tax Refund' AND year=${yr}`);
    if (!rows.length) return noData();
    return `🇵🇭 **National Net Collection ${yr}:** ₱${fmtM(rows[0].amount_millions)}`;
  }

  // Specific region
  if (region && /how much|collection|revenue|collected/i.test(m)) {
    const rows = await queryRows(conn, `SELECT particulars, amount_millions, yoy_pct FROM collections WHERE row_type='region' AND year=${yr} AND LOWER(particulars) LIKE '%${region}%' LIMIT 1`);
    if (!rows.length) return `No data for "${region}" in ${yr}.`;
    const r = rows[0];
    const yoy = r.yoy_pct != null ? ` (${Number(r.yoy_pct)>0?'+':''}${Number(r.yoy_pct).toFixed(1)}% YoY)` : '';
    return `📍 **${r.particulars} — ${yr}**\n💰 ₱${fmtM(r.amount_millions)}${yoy}`;
  }

  // Top provinces
  if (/top\s+\d*\s*(province|city|cities|provinces)/i.test(m)) {
    const n = Math.min(parseInt(m.match(/\d+/)?.[0] || '5'), 10);
    const rows = await queryRows(conn, `SELECT particulars, region, amount_millions FROM collections WHERE row_type='province_city' AND year=${yr} ORDER BY amount_millions DESC LIMIT ${n}`);
    if (!rows.length) return noData();
    const list = rows.map((r,i) => `${i+1}. **${r.particulars}** (${shortRegion(r.region)}) — ₱${fmtM(r.amount_millions)}`).join('\n');
    return `🏙️ **Top ${n} Provinces — ${yr}**\n\n${list}`;
  }

  // YoY / growth
  if (/yoy|growth|grew|decline|increase|dropped/i.test(m)) {
    if (region) {
      const rows = await queryRows(conn, `SELECT particulars, yoy_pct, amount_millions FROM collections WHERE row_type='region' AND year=${yr} AND LOWER(particulars) LIKE '%${region}%' LIMIT 1`);
      if (!rows.length) return noData();
      const r = rows[0]; const pct = r.yoy_pct!=null ? `${Number(r.yoy_pct)>0?'+':''}${Number(r.yoy_pct).toFixed(2)}%` : 'N/A';
      return `📈 **${r.particulars} YoY ${yr}:** ${pct}\n💰 ₱${fmtM(r.amount_millions)}`;
    }
    const rows = await queryRows(conn, `SELECT yoy_pct, amount_millions FROM collections WHERE particulars='Total Collection - Net of Tax Refund' AND year=${yr}`);
    if (!rows.length) return noData();
    const r = rows[0]; const pct = r.yoy_pct!=null ? `${Number(r.yoy_pct)>0?'+':''}${Number(r.yoy_pct).toFixed(2)}%` : 'N/A';
    return `📈 **National YoY ${yr}:** ${pct}\n💰 ₱${fmtM(r.amount_millions)}`;
  }

  // Compare years
  if (/compare|vs|versus/i.test(m)) {
    const years = m.match(/\b(200[5-9]|201\d|202[0-4])\b/g)?.map(Number);
    if (!years || years.length < 2) return `Please mention two years to compare (e.g., "compare 2019 vs 2024").`;
    const [y1, y2] = [Math.min(...years), Math.max(...years)];
    const rows = await queryRows(conn, `SELECT year, amount_millions FROM collections WHERE particulars='Total Collection - Net of Tax Refund' AND year IN (${y1},${y2}) ORDER BY year`);
    if (rows.length < 2) return noData();
    const diff = Number(rows[1].amount_millions) - Number(rows[0].amount_millions);
    const pct = ((diff / Number(rows[0].amount_millions)) * 100).toFixed(1);
    return `⚖️ **${y1} vs ${y2}**\n• ${y1}: ₱${fmtM(rows[0].amount_millions)}\n• ${y2}: ₱${fmtM(rows[1].amount_millions)}\n• Change: ${diff>0?'+':''}₱${fmtM(Math.abs(diff))} (${pct}%)`;
  }

  // Fastest growing
  if (/fastest|best growth|most improved/i.test(m)) {
    const rows = await queryRows(conn, `SELECT particulars, region, MAX(CASE WHEN year=2005 THEN amount_millions END) v05, MAX(CASE WHEN year=2024 THEN amount_millions END) v24 FROM collections WHERE row_type='province_city' GROUP BY particulars, region HAVING v05>0 AND v24>0 ORDER BY (v24/v05) DESC LIMIT 5`);
    if (!rows.length) return noData();
    const list = rows.map((r,i) => { const cagr=((Math.pow(Number(r.v24)/Number(r.v05),1/19)-1)*100).toFixed(1); return `${i+1}. **${r.particulars}** — ${cagr}% CAGR`; }).join('\n');
    return `🚀 **Fastest-Growing (CAGR 2005–2024)**\n\n${list}`;
  }

  // Lowest
  if (/lowest|worst|bottom|least/i.test(m) && /region|collection/i.test(m)) {
    const rows = await queryRows(conn, `SELECT particulars, amount_millions FROM collections WHERE row_type='region' AND year=${yr} AND particulars!='Large Taxpayers Service' AND amount_millions>0 ORDER BY amount_millions ASC LIMIT 3`);
    if (!rows.length) return noData();
    const list = rows.map((r,i) => `${i+1}. **${r.particulars}** — ₱${fmtM(r.amount_millions)}`).join('\n');
    return `📉 **Lowest Regions — ${yr}**\n\n${list}`;
  }

  // Fallback
  return `I'm not sure how to answer that. Try asking:\n• "Top region in 2024"\n• "National total 2023"\n• "Compare 2019 vs 2024"\n• "What is BIR?"`;
}

// ── Chat UI ───────────────────────────────────────────────────
export function initBAYR(conn, filters) {
  // Inject HTML
  const chatHTML = `
    <div class="bayr-fab" id="bayrFab" title="Ask BAYR">
      <svg viewBox="0 0 40 40" fill="none" xmlns="http://www.w3.org/2000/svg">
        <circle cx="20" cy="20" r="18" fill="var(--accent)"/>
        <text x="20" y="26" text-anchor="middle" font-size="13" font-weight="bold" fill="#fff" font-family="sans-serif">B</text>
      </svg>
    </div>
    <div class="bayr-panel" id="bayrPanel">
      <div class="bayr-header">
        <div class="bayr-avatar">
          <svg viewBox="0 0 32 32" fill="none"><circle cx="16" cy="16" r="14" fill="var(--accent)"/><text x="16" y="21" text-anchor="middle" font-size="11" font-weight="bold" fill="#fff" font-family="sans-serif">B</text></svg>
        </div>
        <div><div class="bayr-name">BAYR</div><div class="bayr-subtitle">BIR Analytics Reporter</div></div>
        <button class="bayr-close" id="bayrClose">×</button>
      </div>
      <div class="bayr-messages" id="bayrMessages">
        <div class="bayr-msg bot"><div class="bayr-bubble">Hello! I'm <b>BAYR</b> 👋<br>Ask me about BIR collections 2005–2024.</div></div>
      </div>
      <div class="bayr-quick" id="bayrQuick"></div>
      <div class="bayr-input-row">
        <input type="text" id="bayrInput" placeholder="Ask about BIR data…" autocomplete="off" />
        <button class="bayr-send" id="bayrSend">➤</button>
      </div>
    </div>
  `;
  document.body.insertAdjacentHTML('beforeend', chatHTML);

  // Refs
  const fab = document.getElementById('bayrFab');
  const panel = document.getElementById('bayrPanel');
  const close = document.getElementById('bayrClose');
  const messages = document.getElementById('bayrMessages');
  const input = document.getElementById('bayrInput');
  const send = document.getElementById('bayrSend');
  const quick = document.getElementById('bayrQuick');

  // Quick replies
  QUICK_REPLIES.forEach(q => {
    const btn = document.createElement('button');
    btn.className = 'bayr-quick-btn';
    btn.textContent = q;
    btn.addEventListener('click', () => sendMessage(q));
    quick.appendChild(btn);
  });

  // Toggle
  fab.addEventListener('click', () => { panel.classList.toggle('open'); fab.classList.toggle('hidden'); input.focus(); });
  close.addEventListener('click', () => { panel.classList.remove('open'); fab.classList.remove('hidden'); });

  // Send
  function addMessage(text, isBot) {
    const div = document.createElement('div');
    div.className = `bayr-msg ${isBot ? 'bot' : 'user'}`;
    div.innerHTML = `<div class="bayr-bubble">${formatMarkdown(text)}</div>`;
    messages.appendChild(div);
    messages.scrollTop = messages.scrollHeight;
  }

  function formatMarkdown(text) {
    return text
      .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
      .replace(/\*(.+?)\*/g, '<i>$1</i>')
      .replace(/_(.+?)_/g, '<i>$1</i>')
      .replace(/\n/g, '<br>');
  }

  function showTyping() {
    const div = document.createElement('div');
    div.className = 'bayr-msg bot typing';
    div.id = 'bayrTyping';
    div.innerHTML = '<div class="bayr-bubble"><span class="dot-1">.</span><span class="dot-2">.</span><span class="dot-3">.</span></div>';
    messages.appendChild(div);
    messages.scrollTop = messages.scrollHeight;
  }

  function removeTyping() {
    document.getElementById('bayrTyping')?.remove();
  }

  async function sendMessage(text) {
    const msg = text || input.value.trim();
    if (!msg) return;
    input.value = '';
    addMessage(msg, false);
    showTyping();

    try {
      const response = await handleMessage(conn, msg, filters);
      removeTyping();
      addMessage(response, true);
    } catch (err) {
      removeTyping();
      addMessage(`⚠️ Error: ${err.message}`, true);
    }
  }

  send.addEventListener('click', () => sendMessage());
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') sendMessage(); });

  return { sendMessage };
}
