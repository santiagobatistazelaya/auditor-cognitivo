// /api/analizar-copy.js
//
// Función serverless de Vercel (Node.js runtime).
// Recibe el copy del anuncio desde el frontend, llama a la API de Claude
// usando la API key guardada en las variables de entorno, y devuelve
// el JSON estructurado al cliente.
//
// La API key NUNCA se expone al navegador: este código corre en el
// servidor de Vercel, no en el HTML del usuario.

export default async function handler(req, res) {
  // Solo aceptamos POST
  if (req.method !== 'POST') {
    res.setHeader('Allow', ['POST']);
    return res.status(405).json({ error: 'Método no permitido. Usá POST.' });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'Falta configurar ANTHROPIC_API_KEY en las variables de entorno.' });
  }

  try {
    const { model, max_tokens, system, messages } = req.body || {};

    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: 'Falta el campo "messages" en el body.' });
    }

    const anthropicResponse = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: model || 'claude-sonnet-4-6',
        max_tokens: max_tokens || 1000,
        system: system || undefined,
        messages,
      }),
    });

    const data = await anthropicResponse.json();

    if (!anthropicResponse.ok) {
      // Reenviamos el error de la API de Anthropic para poder debuggear desde el frontend
      return res.status(anthropicResponse.status).json({
        error: 'Error desde la API de Anthropic',
        details: data,
      });
    }

    // Devolvemos la respuesta tal cual la espera el frontend (data.content)
    return res.status(200).json(data);
  } catch (err) {
    console.error('Error en /api/analizar-copy:', err);
    return res.status(500).json({ error: 'Error interno del servidor', details: err.message });
  }
}
