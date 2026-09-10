// ═══════════════════════════════════════════════════════════
// server.js — Pulsar Copy Engine — versión completa y final
// ═══════════════════════════════════════════════════════════

const express = require('express');
const path = require('path');
const fetch = require('node-fetch');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '200kb' }));
app.use(express.static(path.join(__dirname, 'public')));

const GEMINI_MODEL = 'gemini-2.0-flash';

const hits = new Map();
const LIMIT_PER_MIN = 20;

function isRateLimited(ip) {
  const now = Date.now();
  const entry = hits.get(ip) || { count: 0, ts: now };
  if (now - entry.ts > 60000) { entry.count = 0; entry.ts = now; }
  entry.count++;
  hits.set(ip, entry);
  return entry.count > LIMIT_PER_MIN;
}

async function callGemini(systemPrompt, userMessage) {
  const geminiRes = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${process.env.GEMINI_API_KEY}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: systemPrompt }] },
        contents: [{ parts: [{ text: userMessage }] }],
      }),
    }
  );

  if (!geminiRes.ok) {
    const errText = await geminiRes.text();
    throw { status: 502, payload: { error: 'Error de Gemini', detail: errText } };
  }

  const data = await geminiRes.json();
  const text = (data.candidates && data.candidates[0] && data.candidates[0].content &&
    data.candidates[0].content.parts && data.candidates[0].content.parts[0] &&
    data.candidates[0].content.parts[0].text) || '';
  const clean = text.replace(/```json|```/g, '').trim();

  try {
    return JSON.parse(clean);
  } catch (e) {
    throw { status: 502, payload: { error: 'La IA no devolvió JSON válido', raw: clean } };
  }
}

function extractTextFromHTML(html) {
  return html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

async function fetchUrlContent(url) {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; PulsarCopyEngine/1.0)' },
      timeout: 10000,
    });
    if (!res.ok) return `[No se pudo acceder a ${url} — status ${res.status}]`;
    const html = await res.text();
    return extractTextFromHTML(html).slice(0, 4000);
  } catch (err) {
    return `[Error al descargar ${url}: ${String(err.message || err)}]`;
  }
}

app.post('/api/generate', async (req, res) => {
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
  if (isRateLimited(ip)) {
    return res.status(429).json({ error: 'Demasiadas solicitudes, esperá un minuto' });
  }

  const { systemPrompt, userMessage } = req.body || {};
  if (!systemPrompt || !userMessage) {
    return res.status(400).json({ error: 'Faltan systemPrompt o userMessage' });
  }
  if (userMessage.length > 8000) {
    return res.status(400).json({ error: 'Texto demasiado largo (máx 8000 caracteres)' });
  }
  if (!process.env.GEMINI_API_KEY) {
    return res.status(500).json({ error: 'GEMINI_API_KEY no configurada en el servidor' });
  }

  try {
    const parsed = await callGemini(systemPrompt, userMessage);
    res.json(parsed);
  } catch (err) {
    console.error('Error en /api/generate:', err);
    if (err && err.status) return res.status(err.status).json(err.payload);
    res.status(500).json({ error: 'Error interno del servidor', detail: String(err.message || err) });
  }
});

app.post('/api/newsletter', async (req, res) => {
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
  if (isRateLimited(ip)) {
    return res.status(429).json({ error: 'Demasiadas solicitudes, esperá un minuto' });
  }

  const { urls, systemPrompt } = req.body || {};
  if (!Array.isArray(urls) || urls.length === 0) {
    return res.status(400).json({ error: 'Falta un array de URLs' });
  }
  if (urls.length > 5) {
    return res.status(400).json({ error: 'Máximo 5 URLs por boletín' });
  }
  if (!process.env.GEMINI_API_KEY) {
    return res.status(500).json({ error: 'GEMINI_API_KEY no configurada en el servidor' });
  }

  try {
    const contents = await Promise.all(urls.map(fetchUrlContent));
    const combined = urls
      .map((u, i) => `FUENTE ${i + 1} (${u}):\n${contents[i]}`)
      .join('\n\n---\n\n');

    const parsed = await callGemini(systemPrompt, combined);
    res.json(parsed);
  } catch (err) {
    console.error('Error en /api/newsletter:', err);
    if (err && err.status) return res.status(err.status).json(err.payload);
    res.status(500).json({ error: 'Error interno del servidor', detail: String(err.message || err) });
  }
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log('Pulsar Copy Engine corriendo en puerto ' + PORT);
});
