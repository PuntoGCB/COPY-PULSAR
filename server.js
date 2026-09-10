// ── Extraer texto legible de un HTML crudo ──
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

// ── Descargar y extraer contenido de una URL ──
async function fetchUrlContent(url) {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; PulsarCopyEngine/1.0)' },
      timeout: 10000,
    });
    if (!res.ok) return `[No se pudo acceder a ${url} — status ${res.status}]`;
    const html = await res.text();
    const text = extractTextFromHTML(html);
    return text.slice(0, 4000);
  } catch (err) {
    return `[Error al descargar ${url}: ${String(err.message || err)}]`;
  }
}

// ── Endpoint dedicado: boletín desde URLs reales ──
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

  try {
    const contents = await Promise.all(urls.map(fetchUrlContent));
    const combined = urls
      .map((u, i) => `FUENTE ${i + 1} (${u}):\n${contents[i]}`)
      .join('\n\n---\n\n');

    const geminiRes = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${process.env.GEMINI_API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          system_instruction: { parts: [{ text: systemPrompt }] },
          contents: [{ parts: [{ text: combined }] }],
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
    res.status(500).json({ error: 'Error interno del servidor', detail: String(err.message || err) });
  }
});

// Fallback: cualquier ruta no reconocida sirve el index (SPA-friendly)
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log('Pulsar Copy Engine corriendo en puerto ' + PORT);
});
