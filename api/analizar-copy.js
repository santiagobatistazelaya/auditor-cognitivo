module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Método no permitido' });

  try {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) return res.status(500).json({ error: "Falta configurar la API Key" });

    // 1. Lectura blindada del texto y el modo (Ads / Soporte / Landing)
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

    // 2. Si el modo es "landing", el texto es una URL: traemos el HTML y extraemos el texto visible
    let contenidoParaAnalizar = texto;
    if (modo === "landing") {
        try {
            const pageResponse = await fetch(texto, {
                headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
            });
            if (!pageResponse.ok) {
                return res.status(400).json({ error: `No pudimos acceder a esa URL (status ${pageResponse.status}). Verificá que sea pública y esté bien escrita.` });
            }
            const html = await pageResponse.text();
            contenidoParaAnalizar = extraerTextoVisible(html);
            if (!contenidoParaAnalizar || contenidoParaAnalizar.length < 50) {
                return res.status(400).json({ error: 'No pudimos extraer suficiente texto de esa página. Puede ser una web muy dependiente de JavaScript (SPA).' });
            }
        } catch (fetchErr) {
            return res.status(400).json({ error: 'No pudimos acceder a esa URL. Revisá que el link sea correcto y empiece con http:// o https://' });
        }
    }

    // 3. Prompts estrictos basados en marcos teóricos
    const promptAds = `Eres un Auditor Cognitivo experto en growth marketing y psicología del consumidor. 
    Analiza este texto publicitario basándote en Ekman, Zajonc y la Teoría de la Mente.
    Tu respuesta DEBE ser un único objeto JSON válido, sin formato markdown. Usa este formato exacto:
    IMPORTANTE: "diagnostico_general" debe ser un array de exactamente 3 strings. "curva_emocional" usa una escala de -5 (rechazo/frustración) a +5 (entusiasmo/confianza). "cartesiano.valores" y "radar.valores" van de 0 a 10. Los campos "opcion_a_cuando_usar" y "opcion_b_cuando_usar" deben ser una frase corta y accionable.
    {
      "puntaje": 85,
      "cartesiano": { "labels": ["Inicio", "Desarrollo", "Cierre"], "valores": [7, 6, 8] },
      "radar": { "labels": ["Emociones (Ekman)", "Reacción (Zajonc)", "Motivación", "Teoría Mente", "Claridad"], "valores": [7, 8, 6, 7, 9] },
      "curva_emocional": { "inicio": -2, "desarrollo": 1, "cierre": 4 },
      "diagnostico_general": ["Fricción principal detectada: (una viñeta contundente y clínica)", "Reacción afectiva real del usuario: (otra viñeta)", "Oportunidad de conversión: (otra viñeta)"],
      "test_ab": { 
          "opcion_a": "REDISEÑO A (Anclaje Emocional): Redacta un anuncio COMPLETO y EXTENSO. Debe incluir: [TÍTULO MAGNÉTICO], [CUERPO DEL TEXTO] desarrollando el dolor y la solución, y un [CTA] claro. Debajo, añade un párrafo detallado justificando clínicamente por qué esta estructura mejora la conversión según Zajonc y Ekman.", 
          "opcion_a_cuando_usar": "Frase corta.",
          "opcion_b": "REDISEÑO B (Fricción Cero): Redacta una segunda variante COMPLETA. Incluye [TÍTULO], [CUERPO] y [CTA] enfocados en la simplicidad extrema y carga cognitiva mínima. Debajo, añade una justificación técnica de 3 o 4 líneas.",
          "opcion_b_cuando_usar": "Frase corta."
      }
    }
    Texto a analizar: "${contenidoParaAnalizar}"`;

    const promptSoporte = `Eres un Auditor Cognitivo experto en Experiencia de Cliente (CX) y psicología del consumidor.
    Analiza este mensaje de atención al cliente/soporte basándote en Ekman, Zajonc y la Teoría de la Mente, evaluando si reduce o aumenta la carga emocional y la carga de prueba del usuario.
    Tu respuesta DEBE ser un único objeto JSON válido, sin formato markdown. Usa este formato exacto:
    IMPORTANTE: "diagnostico_general" debe ser un array de exactamente 3 strings. "curva_emocional" usa una escala de -5 (rechazo/frustración) a +5 (confianza/alivio). "cartesiano.valores" y "radar.valores" van de 0 a 10. Los campos "opcion_a_cuando_usar" y "opcion_b_cuando_usar" deben ser una frase corta y accionable.
    {
      "puntaje": 85,
      "cartesiano": { "labels": ["Inicio", "Desarrollo", "Cierre"], "valores": [7, 6, 8] },
      "radar": { "labels": ["Emociones (Ekman)", "Reacción (Zajonc)", "Motivación", "Teoría Mente", "Claridad"], "valores": [7, 8, 6, 7, 9] },
      "curva_emocional": { "inicio": -2, "desarrollo": 1, "cierre": 4 },
      "diagnostico_general": ["Fricción operativa detectada: (¿traslada la carga de prueba al usuario o la asume el sistema?)", "Falla o acierto de Teoría de la Mente: (¿valida la urgencia real del usuario?)", "Oportunidad de Válvula de Escape: (cómo bajar la carga cognitiva)"],
      "test_ab": {
          "opcion_a": "REDISEÑO A (Triage con SLA claro): Redacta una respuesta COMPLETA que valide la frustración, fije un plazo concreto y traslade la responsabilidad al sistema. Debajo, justifica clínicamente por qué reduce la ansiedad.",
          "opcion_a_cuando_usar": "Frase corta.",
          "opcion_b": "REDISEÑO B (Resolución Inmediata): Redacta una segunda variante COMPLETA con salida automática (reembolso/reemplazo) sin más esfuerzo del usuario. Debajo, justifica la 'Paradoja de Recuperación del Servicio'.",
          "opcion_b_cuando_usar": "Frase corta."
      }
    }
    Mensaje a analizar: "${contenidoParaAnalizar}"`;

    const promptLift = `Eres un Auditor Cognitivo experto en CRO (Conversion Rate Optimization) y psicología del consumidor.
    Analiza el texto extraído de esta landing page aplicando el Modelo LIFT (Propuesta de Valor, Relevancia, Claridad, Ansiedad y Urgencia) como marco PRINCIPAL. Además, sumá un análisis COMPLEMENTARIO y separado desde Zajonc (reacción afectiva), Ekman (emociones universales) y Teoría de la Mente, sin repetir lo que ya dijiste en el diagnóstico LIFT.
    Tu respuesta DEBE ser un único objeto JSON válido, sin formato markdown. Usa este formato exacto:
    IMPORTANTE: "diagnostico_general" (LIFT) y "diagnostico_cognitivo" (Zajonc/Ekman/ToM) deben ser arrays de exactamente 3 y 2 strings respectivamente. "curva_emocional" usa una escala de -5 (desconfianza/confusión) a +5 (confianza/intención de conversión) a medida que el visitante recorre la página. "cartesiano.labels" deben ser las secciones reales de la página (ej. Hero, Cuerpo, CTA Final) y "valores" miden captación de atención de 0 a 10. "radar.labels" deben ser EXACTAMENTE: ["Propuesta de Valor", "Relevancia", "Claridad", "Reducción de Ansiedad", "Urgencia"], con "valores" de 0 a 10 (en Ansiedad, más alto = MENOS ansiedad generada, o sea mejor). Los campos "opcion_a_cuando_usar" y "opcion_b_cuando_usar" deben ser una frase corta y accionable.
    {
      "puntaje": 85,
      "cartesiano": { "labels": ["Hero", "Cuerpo", "CTA Final"], "valores": [7, 6, 8] },
      "radar": { "labels": ["Propuesta de Valor", "Relevancia", "Claridad", "Reducción de Ansiedad", "Urgencia"], "valores": [7, 8, 6, 5, 7] },
      "curva_emocional": { "inicio": -1, "desarrollo": 2, "cierre": 4 },
      "diagnostico_general": ["Fricción LIFT principal: (qué variable falla y por qué, con evidencia del texto)", "Punto fuerte detectado: (qué variable de LIFT funciona bien)", "Oportunidad de conversión: (qué cambiar primero y por qué)"],
      "diagnostico_cognitivo": ["Lectura desde Zajonc/Ekman: (qué reacción afectiva inmediata genera el texto, más allá de la lógica de conversión)", "Lectura desde Teoría de la Mente: (qué tan bien el copy anticipa el estado mental real del visitante)"],
      "test_ab": {
          "opcion_a": "REDISEÑO A del Hero (Propuesta de Valor Reforzada): Redacta un COMPLETO [TÍTULO], [SUBTÍTULO] y [CTA] nuevos para el hero de esta landing, resolviendo la fricción LIFT detectada. Debajo, justifica clínicamente la elección.",
          "opcion_a_cuando_usar": "Frase corta.",
          "opcion_b": "REDISEÑO B del Hero (Reducción de Ansiedad y Urgencia): Redacta una segunda variante COMPLETA de [TÍTULO], [SUBTÍTULO] y [CTA], priorizando bajar la ansiedad (prueba social, garantías) y sumar urgencia genuina. Debajo, justifica en 3-4 líneas.",
          "opcion_b_cuando_usar": "Frase corta."
      }
    }
    Texto extraído de la landing page a analizar: "${contenidoParaAnalizar}"`;

    const promptMaestro = modo === "soporte" ? promptSoporte : (modo === "landing" ? promptLift : promptAds);

    // 4. Modelos de las familias 3.x y 2.5 con capa gratuita en 2026
    const modelosGratuitos = [
        "gemini-3.5-flash",
        "gemini-3.1-flash-lite",
        "gemini-2.5-flash-lite",
        "gemini-2.5-flash"
    ];

    let successData = null;
    let lastError = null;

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

    // 5. Extracción quirúrgica del JSON
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

// Extrae texto visible de un HTML crudo, sacando scripts, estilos y tags
function extraerTextoVisible(html) {
    let limpio = html.replace(/<script[\s\S]*?<\/script>/gi, ' ');
    limpio = limpio.replace(/<style[\s\S]*?<\/style>/gi, ' ');
    limpio = limpio.replace(/<!--[\s\S]*?-->/g, ' ');
    limpio = limpio.replace(/<[^>]+>/g, ' ');
    limpio = limpio.replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&');
    limpio = limpio.replace(/\s+/g, ' ').trim();
    return limpio.substring(0, 6000);
}
