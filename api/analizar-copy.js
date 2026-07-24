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

    // 3. Prompt estricto basado en marcos teóricos (Ekman, Zajonc, ToM)
   const promptMaestro = `Eres un Auditor Cognitivo de alto nivel, experto en psicología del consumidor, growth marketing y optimización de campañas de alto impacto. Tu objetivo es medir la fricción cognitiva y la resonancia emocional de los copys.
    Analiza este texto publicitario basándote estrictamente en los marcos teóricos de Paul Ekman (emociones universales), Robert Zajonc (primacía del afecto/reacción visceral) y la Teoría de la Mente.
    Tu respuesta DEBE ser ÚNICAMENTE un objeto JSON válido. Completa los valores siguiendo este formato exacto:
    {
      "puntaje": 85,
      "grafico_cartesiano": { "inicio": 7, "desarrollo": 6, "cierre": 8 },
      "grafico_radial": { "emociones_universales": 7, "reaccion_afectiva": 8, "motivacion_intrinseca": 6, "teoria_de_la_mente": 7, "claridad": 9 },
      "diagnostico_general": "Redacta un DIAGNÓSTICO CLÍNICO exhaustivo (2 a 3 párrafos). Analiza la jerarquía de procesamiento afectivo, si la reacción visceral se dispara en los primeros segundos, la carga cognitiva requerida para decodificar la promesa y la calidad del anclaje emocional. Usa un tono riguroso, científico y directo.",
      "test_ab": { 
          "opcion_a": "REDISEÑO ÓPTIMO A: Redacta un copy real, directo y de alta conversión (estilo FMCG/Retail). Frases cortas, anclaje emocional fuerte e inmediatez. Debajo, agrega una breve justificación de por qué funciona cognitivamente.", 
          "opcion_b": "REDISEÑO ÓPTIMO B: Redacta una variante enfocada en la motivación intrínseca y la reducción absoluta de fricción cognitiva. Incluye justificación." 
      }
    }
    Texto a analizar: "${texto}"`;

    // 4. LA CLAVE ACTUALIZADA: Modelos de las familias 3.x y 2.5 con capa gratuita en 2026
    const modelosGratuitos = [
        "gemini-3.5-flash",
        "gemini-3.1-flash-lite",
        "gemini-2.5-flash-lite",
        "gemini-2.5-flash"
    ];

    let successData = null;
    let lastError = null;

    // 5. Bucle de supervivencia ultra-rápido
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

            // Si el modelo responde con éxito, guardamos y cortamos el bucle
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
        throw new Error(JSON.stringify(lastError || "Todos los modelos de la generación 3.x y 2.5 fallaron."));
    }

    // 6. Extracción quirúrgica del JSON
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
