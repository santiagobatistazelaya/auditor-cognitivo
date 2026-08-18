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
    const promptMaestro = `Eres un Auditor Cognitivo experto en growth marketing y psicología del consumidor. 
    Analiza este texto publicitario basándote en Ekman, Zajonc y la Teoría de la Mente.
    Tu respuesta DEBE ser un único objeto JSON válido, sin formato markdown. Usa este formato exacto:
    +   IMPORTANTE: "diagnostico_general" debe ser un array de exactamente 3 strings (no un solo string largo).
    {
      "puntaje": 85,
      "grafico_cartesiano": { "inicio": 7, "desarrollo": 6, "cierre": 8 },
      "grafico_radial": { "emociones_universales": 7, "reaccion_afectiva": 8, "motivacion_intrinseca": 6, "teoria_de_la_mente": 7, "claridad": 9 },
+ "diagnostico_general": ["Fricción principal detectada: (una viñeta contundente y clínica)", "Reacción afectiva real del usuario: (otra viñeta)", "Oportunidad de conversión: (otra viñeta)"],      "test_ab": { 
          "opcion_a": "REDISEÑO A (Anclaje Emocional): Redacta un anuncio COMPLETO y EXTENSO. Debe incluir: [TÍTULO MAGNÉTICO], [CUERPO DEL TEXTO] desarrollando el dolor y la solución, y un [CTA] claro. Debajo, añade un párrafo detallado justificando clínicamente por qué esta estructura mejora la conversión según Zajonc y Ekman.", 
          "opcion_b": "REDISEÑO B (Fricción Cero): Redacta una segunda variante COMPLETA. Incluye [TÍTULO], [CUERPO] y [CTA] enfocados en la simplicidad extrema y carga cognitiva mínima. Debajo, añade una justificación técnica de 3 o 4 líneas explicando cómo la Teoría de la Mente aplica a esta optimización." 
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
