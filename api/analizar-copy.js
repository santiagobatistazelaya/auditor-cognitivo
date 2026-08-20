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

    // 2. Lectura blindada del texto y el modo (Ads / Soporte)
    let texto = "";
    let modo = "ads";
    if (req.body) {
      if (typeof req.body === 'string') {
        try {
          const parsed = JSON.parse(req.body);
          texto = parsed.texto;
          modo = parsed.modo || "ads";
        } catch (e) { texto = req.body; }
      } else {
        texto = req.body.texto;
        modo = req.body.modo || "ads";
      }
    }
    if (!texto) return res.status(400).json({ error: 'El texto es requerido' });

    // 3. Prompts estrictos basados en marcos teóricos (Ekman, Zajonc, ToM)
    const promptAds = `Eres un Auditor Cognitivo experto en growth marketing y psicología del consumidor. 
    Analiza este texto publicitario basándote en Ekman, Zajonc y la Teoría de la Mente.
    Tu respuesta DEBE ser un único objeto JSON válido, sin formato markdown. Usa este formato exacto:
    IMPORTANTE: "diagnostico_general" debe ser un array de exactamente 3 strings (no un solo string largo). "curva_emocional" usa una escala de -5 (rechazo/frustración) a +5 (entusiasmo/confianza).
    {
      "puntaje": 85,
      "grafico_cartesiano": { "inicio": 7, "desarrollo": 6, "cierre": 8 },
      "grafico_radial": { "emociones_universales": 7, "reaccion_afectiva": 8, "motivacion_intrinseca": 6, "teoria_de_la_mente": 7, "claridad": 9 },
      "curva_emocional": { "inicio": -2, "desarrollo": 1, "cierre": 4 },
      "diagnostico_general": ["Fricción principal detectada: (una viñeta contundente y clínica)", "Reacción afectiva real del usuario: (otra viñeta)", "Oportunidad de conversión: (otra viñeta)"],
      "test_ab": { 
          "opcion_a": "REDISEÑO A (Anclaje Emocional): Redacta un anuncio COMPLETO y EXTENSO. Debe incluir: [TÍTULO MAGNÉTICO], [CUERPO DEL TEXTO] desarrollando el dolor y la solución, y un [CTA] claro. Debajo, añade un párrafo detallado justificando clínicamente por qué esta estructura mejora la conversión según Zajonc y Ekman.", 
          "opcion_b": "REDISEÑO B (Fricción Cero): Redacta una segunda variante COMPLETA. Incluye [TÍTULO], [CUERPO] y [CTA] enfocados en la simplicidad extrema y carga cognitiva mínima. Debajo, añade una justificación técnica de 3 o 4 líneas explicando cómo la Teoría de la Mente aplica a esta optimización." 
      }
    }
    Texto a analizar: "${texto}"`;

    const promptSoporte = `Eres un Auditor Cognitivo experto en Experiencia de Cliente (CX) y psicología del consumidor.
    Analiza este mensaje de atención al cliente/soporte (bot, email o respuesta a un reclamo) basándote en Ekman, Zajonc y la Teoría de la Mente, evaluando si el mensaje reduce o aumenta la carga emocional y la carga de prueba que recae sobre un usuario alterado.
    Tu respuesta DEBE ser un único objeto JSON válido, sin formato markdown. Usa este formato exacto:
    IMPORTANTE: "diagnostico_general" debe ser un array de exactamente 3 strings (no un solo string largo). "curva_emocional" usa una escala de -5 (rechazo/frustración) a +5 (confianza/alivio).
    {
      "puntaje": 85,
      "grafico_cartesiano": { "inicio": 7, "desarrollo": 6, "cierre": 8 },
      "grafico_radial": { "emociones_universales": 7, "reaccion_afectiva": 8, "motivacion_intrinseca": 6, "teoria_de_la_mente": 7, "claridad": 9 },
      "curva_emocional": { "inicio": -2, "desarrollo": 1, "cierre": 4 },
      "diagnostico_general": ["Fricción operativa detectada: (¿el mensaje traslada la carga de prueba al usuario o la asume el sistema?)", "Falla o acierto de Teoría de la Mente: (¿valida la urgencia/frustración real del usuario?)", "Oportunidad de Válvula de Escape: (cómo bajar la carga cognitiva y devolver confianza)"],
      "test_ab": {
          "opcion_a": "REDISEÑO A (Triage con SLA claro): Redacta una respuesta COMPLETA de soporte/bot que valide la frustración, fije un plazo concreto y traslade la responsabilidad al sistema (no al usuario). Debajo, justifica clínicamente por qué reduce la ansiedad según la Teoría de la Mente.",
          "opcion_b": "REDISEÑO B (Resolución Inmediata): Redacta una segunda variante COMPLETA que ofrezca una salida automática (reembolso/reemplazo) sin pedirle más esfuerzo al usuario. Debajo, justifica en 3-4 líneas la 'Paradoja de Recuperación del Servicio'."
      }
    }
    Mensaje a analizar: "${texto}"`;

    const promptMaestro = modo === "soporte" ? promptSoporte : promptAds;

    // 4. Modelos de las familias 3.x y 2.5 con capa gratuita en 2026
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
