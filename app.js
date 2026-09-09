// ═══════════════════════════════════════════════════════════
// server.js — App Node.js para Hostinger (Business Web Hosting)
// Versión CommonJS (require) — formato que el detector
// automático de frameworks de Hostinger reconoce como Express.
// ═══════════════════════════════════════════════════════════
// Esta única app hace dos cosas:
//   1) Sirve el HTML de la landing (carpeta /public)
//   2) Expone POST /api/generate como proxy seguro hacia Gemini
//      (la API key vive acá, nunca en el navegador del usuario)
//
// ─── ESTRUCTURA DE CARPETAS QUE VAS A SUBIR ───
// Comprimí estos 3 elementos JUNTOS (sin carpeta madre alrededor):
//   server.js          ← este archivo, en la raíz del ZIP
//   package.json        ← en la raíz del ZIP
//   public/
//     └── index.html    ← tu landing, dentro de la carpeta public
//
// ─── PASOS EN hPanel ───
// 1. hPanel → Sitios web → Añadir sitio web → Despliegá app web
// 2. Subí el ZIP con la estructura de arriba (sin carpeta madre)
// 3. Elegí el subdominio: copy.pulsaria.io
// 4. Archivo de inicio: server.js
// 5. Una vez creada la app, buscá "Variables de entorno" dentro
//    de su panel y agregá:
//    Nombre: GEMINI_API_KEY
//    Valor: tu-key-de-aistudio.google.com
// 6. "Ejecutar NPM Install"
// 7. Reiniciar la app
// 8. Entrá a https://copy.pulsaria.io
// ═══════════════════════════════════════════════════════════

const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000; // Hostinger inyecta el puerto real

app.use(express.json({ limit: '200kb' }));
app.use(express.static(path.join(__dirname, 'public')));

const GEMINI_MODEL = 'gemini-2.0-flash';

// ── Rate limiting simple en memoria (por IP) ──
// Para producción seria conviene Redis o KV, pero esto alcanza
// para frenar abuso básico en un MVP de agencia.
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

  try {
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
      return res.status(502).json({ error: 'Error de Gemini', detail: errText });
    }

    const data = await geminiRes.json();
    const text = (data.candidates && data.candidates[0] && data.candidates[0].content &&
      data.candidates[0].content.parts && data.candidates[0].content.parts[0] &&
      data.candidates[0].content.parts[0].text) || '';
    const clean = text.replace(/```json|```/g, '').trim();

    let parsed;
    try {
      parsed = JSON.parse(clean);
    } catch (e) {
      return res.status(502).json({ error: 'La IA no devolvió JSON válido', raw: clean });
    }

    res.json(parsed);
  } catch (err) {
    res.status(500).json({ error: 'Error interno del servidor', detail: String(err) });
  }
});

// Fallback: cualquier ruta no reconocida sirve el index (SPA-friendly)
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log('Pulsar Copy Engine corriendo en puerto ' + PORT);
});
