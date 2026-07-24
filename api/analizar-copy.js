module.exports = async function handler(req, res) {
  // 1. Cabeceras anti-bloqueo (CORS)
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Método no permitido' });

  try {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) return res.status(500).json({ error: "Falta configurar la API Key" });

    // 2. Lectura blindada del texto ingresado
    let texto = "";
    if (req.body) {
      if (typeof req.body === 'string') {
        try { texto = JSON.parse(req.body).texto; } catch (e) { texto = req.body; }
      } else {
        texto = req.body.texto;
      }
    }
    if (!texto) return res.status(400).json({ error: 'El texto es requerido' });

    // 3. Prompt estricto
    const promptMaestro = `Eres un Auditor Cognitivo experto. Analiza este texto publicitario basándote en Ekman, Zajonc y la Teoría de la Mente.
    Tu respuesta DEBE ser un único objeto JSON. Completa los valores de este formato y no escribas nada fuera de las llaves:
    {
      "grafico_cartesiano": { "inicio": 7, "desarrollo": 6, "cierre": 8 },
      "grafico_radial": { "emociones_universales": 7, "reaccion_afectiva": 8, "motivacion_intrinseca": 6, "teoria_de_la_mente": 7, "claridad": 9 },
      "diagnostico_general": "Texto con feedback...",
      "test_ab": { "opcion_a": "Opción A...", "opcion_b": "Opción B..." }
    }
    Texto a analizar: "${texto}"`;

    // 4. Lista estática de modelos SIEMPRE gratuitos y universales
    const modelosGratuitos = [
        "gemini-1.5-flash",
        "gemini-1.5-flash-8b",
        "gemini-1.0-pro",
        "gemini-pro"
    ];

    let successData = null;
    let lastError = null;

    // 5. Bucle de ejecución ultra-rápido (evita la librería conflictiva)
    for (const modelo of modelosGratuitos) {
        try {
            const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${modelo}:generateContent?key=${apiKey}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    contents: [{ parts: [{ text: promptMaestro }] }]
                })
            });

            const data = await response.json();

            // Si el modelo responde correctamente, guardamos los datos y cortamos el bucle
            if (response.ok && data.candidates && data.candidates.length > 0) {
                successData = data;
                break; 
            } else {
                lastError = data;
            }
        } catch (fetchError) {
            lastError = fetchError;
        }
    }

    if (!successData) {
        throw new Error(JSON.stringify(lastError || "Todos los modelos gratuitos fallaron."));
    }

    // 6. Extracción quirúrgica del JSON (Ignora cualquier texto charlatán de la IA)
    const responseText = successData.candidates[0].content.parts[0].text;
    
    let cleanJson = responseText.replace(/```json/gi, '').replace(/```/g, '').trim();
    const firstBrace = cleanJson.indexOf('{');
    const lastBrace = cleanJson.lastIndexOf('}');
    
    if (firstBrace !== -1 && lastBrace !== -1) {
        cleanJson = cleanJson.substring(firstBrace, lastBrace + 1);
    } else {
        throw new Error("La IA no devolvió las llaves del JSON.");
    }

    const jsonResponse = JSON.parse(cleanJson);
    return res.status(200).json(jsonResponse);

  } catch (error) {
    console.error('Error detallado en el motor:', error);
    return res.status(500).json({ error: 'Falla interna del servidor', detalle: error.message });
  }
};
