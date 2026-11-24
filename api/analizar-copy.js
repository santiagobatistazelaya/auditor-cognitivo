module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Método no permitido' });

  try {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) return res.status(500).json({ error: "Falta configurar la API Key de Gemini" });

    // 1. Lectura segura del body
    let body = req.body;
    if (typeof body === 'string') {
      try { body = JSON.parse(body); } catch (e) { body = { texto: body }; }
    }

    const modo = body?.modo || "ads";
    const texto = (body?.texto || "").trim();
    const etapas = Array.isArray(body?.etapas) ? body.etapas : [];

    let contenidoParaAnalizar = "";
    let nombresEtapas = [];

    // 2. Extracción de contenido según modo
    if (modo === "funnel") {
      const etapasValidas = etapas.filter(e => e.url && /^https?:\/\//i.test(e.url.trim()));
      if (etapasValidas.length < 2) {
        return res.status(400).json({ error: 'Ingresá al menos 2 URLs válidas (con http:// o https://) para auditar el flujo completo.' });
      }
      if (etapasValidas.length > 4) {
        return res.status(400).json({ error: 'El máximo permitido es de 4 URLs por auditoría para evitar timeouts.' });
      }

      const limitePorEtapa = Math.floor(24000 / etapasValidas.length);

      const resultados = await Promise.all(
        etapasValidas.map(async (etapa, idx) => {
          const nombre = (etapa.nombre || `Etapa ${idx + 1}`).trim();
          nombresEtapas.push(nombre);
          const contenido = await extraerContenidoWeb(etapa.url.trim(), limitePorEtapa);
          if (!contenido || contenido.length < 50) {
            return `=== ETAPA ${idx + 1}: ${nombre} (${etapa.url}) ===\n[ADVERTENCIA: No se pudo extraer contenido suficiente de esta URL]`;
          }
          return `=== ETAPA ${idx + 1}: ${nombre} (${etapa.url}) ===\n${contenido}`;
        })
      );

      contenidoParaAnalizar = resultados.join("\n\n----------------------------------------\n\n");

    } else if (modo === "landing") {
      if (!texto || !/^https?:\/\//i.test(texto)) {
        return res.status(400).json({ error: 'La URL debe empezar con http:// o https://' });
      }
      contenidoParaAnalizar = await extraerContenidoWeb(texto, 18000);
      if (!contenidoParaAnalizar || contenidoParaAnalizar.length < 50) {
        return res.status(400).json({ error: 'No pudimos extraer suficiente texto de esa página. Verificá que sea pública.' });
      }

    } else {
      if (!texto) return res.status(400).json({ error: 'El texto es requerido' });
      contenidoParaAnalizar = texto;
    }

    // 3. Construcción del prompt maestro
    const promptMaestro = construirPrompt(modo, contenidoParaAnalizar, nombresEtapas);

    // 4. Fallback de modelos con Structured Output nativo (JSON garantizado)
    const modelosGratuitos = [
      "gemini-3.5-flash",
      "gemini-3.1-flash-lite",
      "gemini-2.5-flash-lite",
      "gemini-2.5-flash"
    ];

    let responseText = null;
    let lastError = null;

    for (const modelo of modelosGratuitos) {
      try {
        const response = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${modelo}:generateContent?key=${apiKey}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              contents: [{ parts: [{ text: promptMaestro }] }],
              generationConfig: {
                response_mime_type: "application/json",
                temperature: 0.2
              }
            })
          }
        );

        const data = await response.json();

        if (response.ok && data.candidates && data.candidates[0]?.content?.parts?.[0]?.text) {
          responseText = data.candidates[0].content.parts[0].text;
          break;
        } else {
          lastError = data;
        }
      } catch (fetchError) {
        lastError = fetchError.message;
      }
    }

    if (!responseText) {
      throw new Error(JSON.stringify(lastError || "Todos los modelos fallaron."));
    }

    // 5. Parseo directo sin regex frágil
    const jsonResponse = JSON.parse(responseText);
    return res.status(200).json(jsonResponse);

  } catch (error) {
    console.error('Error detallado en el motor:', error);
    return res.status(500).json({ error: 'Falla interna del servidor', detalle: error.message });
  }
};

// Motor de lectura: intenta Jina Reader (renderiza JS y devuelve Markdown estructurado)
// Si falla o tarda demasiado, hace fallback a fetch nativo ampliado
async function extraerContenidoWeb(targetUrl, maxChars = 18000) {
  // Intento 1: Jina Reader
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 12000);

    const jinaRes = await fetch(`https://r.jina.ai/${targetUrl}`, {
      headers: {
        'Accept': 'text/plain',
        'X-Return-Format': 'markdown',
        'User-Agent': 'AuditorCognitivo/2.0'
      },
      signal: controller.signal
    });
    clearTimeout(timeoutId);

    if (jinaRes.ok) {
      const markdown = await jinaRes.text();
      if (markdown && markdown.trim().length > 100) {
        return limpiarMarkdown(markdown).substring(0, maxChars);
      }
    }
  } catch (jinaErr) {
    console.warn(`Jina Reader falló para ${targetUrl}, usando fallback nativo:`, jinaErr.message);
  }

  // Intento 2: Fallback a fetch nativo
  try {
    const pageResponse = await fetch(targetUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
    });
    if (!pageResponse.ok) return "";
    const html = await pageResponse.text();
    return extraerTextoVisible(html, maxChars);
  } catch (fallbackErr) {
    console.error(`Fallback nativo falló para ${targetUrl}:`, fallbackErr.message);
    return "";
  }
}

function limpiarMarkdown(md) {
  // Elimina links de imágenes muy largos en base64 o exceso de saltos de línea para ahorrar tokens
  return md
    .replace(/!\[.*?\]\(data:image\/.*?\)/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function extraerTextoVisible(html, maxChars) {
  let limpio = html.replace(/<script[\s\S]*?<\/script>/gi, ' ');
  limpio = limpio.replace(/<style[\s\S]*?<\/style>/gi, ' ');
  limpio = limpio.replace(/<!--[\s\S]*?-->/g, ' ');
  limpio = limpio.replace(/<[^>]+>/g, ' ');
  limpio = limpio.replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&');
  limpio = limpio.replace(/\s+/g, ' ').trim();
  return limpio.substring(0, maxChars);
}

function construirPrompt(modo, contenido, nombresEtapas = []) {
  if (modo === "funnel") {
    return `Eres un Auditor Cognitivo Senior especializado en CRO (Conversion Rate Optimization) y psicología del consumidor.
Analiza el recorrido completo de estas páginas/secciones de un mismo sitio o embudo aplicando:
1) Modelo LIFT (Propuesta de Valor, Relevancia, Claridad, Reducción de Ansiedad, Urgencia) como marco principal.
2) Continuidad de Expectativa y Fricción de Transición entre páginas (¿lo que se promete al inicio se sostiene en el resto del sitio o aparece confusión/ansiedad?).
3) Lectura cognitiva complementaria (Zajonc, Ekman y Teoría de la Mente).

El nivel de análisis debe ser clínico, concreto (citando frases reales del sitio extraído) y listo para publicarse como caso de estudio en un portfolio profesional.

Devuelve EXCLUSIVAMENTE un JSON válido con esta estructura exacta:
{
  "puntaje": 82,
  "resumen_ejecutivo": "Síntesis ejecutiva de 2-3 líneas explicando la salud del flujo completo, dónde se gana confianza y dónde se pierde conversión.",
  "analisis_continuidad": "Párrafo clínico evaluando la coherencia entre las páginas auditadas (${nombresEtapas.join(' -> ')}): ¿se mantiene la promesa de valor o hay saltos de tono, fricción informativa o pérdida de impulso?",
  "cartesiano": {
    "labels": ${JSON.stringify(nombresEtapas)},
    "valores": [${nombresEtapas.map(() => 7).join(', ')}]
  },
  "radar": {
    "labels": ["Propuesta de Valor", "Relevancia", "Claridad", "Reducción de Ansiedad", "Urgencia"],
    "valores": [8, 7, 6, 8, 5]
  },
  "curva_emocional": { "inicio": 1, "desarrollo": 2, "cierre": 3 },
  "diagnostico_general": [
    "Fricción LIFT principal (con evidencia textual): ...",
    "Punto fuerte estructural del sitio: ...",
    "Oportunidad crítica de conversión (qué cambiar primero): ..."
  ],
  "diagnostico_cognitivo": [
    "Zajonc / Ekman (fluidez afectiva y respuesta visceral): ...",
    "Teoría de la Mente (qué tan bien anticipa el estado mental y miedos del visitante): ..."
  ],
  "test_ab": {
    "opcion_a": "REDISEÑO A (Claridad Funcional y Consistencia): Propuesta completa de [TÍTULO], [SUBTÍTULO] y [CTA] para el punto de mayor fricción detectado. Debajo, justificación clínica.",
    "opcion_a_cuando_usar": "Frase corta y accionable indicando cuándo priorizar esta variante.",
    "opcion_b": "REDISEÑO B (Reducción de Ansiedad + Urgencia): Segunda variante completa de [TÍTULO], [SUBTÍTULO] y [CTA] atacando objeciones ocultas. Debajo, justificación técnica.",
    "opcion_b_cuando_usar": "Frase corta y accionable indicando cuándo priorizar esta variante."
  },
  "hipotesis_medicion_ga4": [
    "Evento / métrica primaria (ej. CTR del CTA principal segmentado por variante): qué confirmaría la hipótesis.",
    "Métrica de navegación o scroll (ej. tasa de paso entre Etapa 1 y Etapa 2 o scroll depth): qué buscar.",
    "Evento custom de abandono (ej. hero_exit o drop_off en sección crítica): cómo validar si la fricción es real."
  ]
}

IMPORTANTE:
- "cartesiano.valores" debe tener EXACTAMENTE la misma cantidad de números (de 0 a 10) que etiquetas en "cartesiano.labels", midiendo la retención/eficacia de cada etapa.
- "radar.valores" va de 0 a 10 (en Reducción de Ansiedad, más alto = menos ansiedad, es decir, mejor).
- "curva_emocional" va de -5 a +5.

Contenido del sitio/embudo a auditar:
"""
${contenido}
"""`;
  }

  if (modo === "landing") {
    return `Eres un Auditor Cognitivo Senior especializado en CRO (Conversion Rate Optimization) y psicología del consumidor.
Analiza en profundidad el contenido completo en Markdown de esta landing page aplicando el Modelo LIFT (Propuesta de Valor, Relevancia, Claridad, Reducción de Ansiedad, Urgencia) como marco principal, más una lectura complementaria desde Zajonc, Ekman y Teoría de la Mente sin repetir hallazgos.

Cita frases textuales reales de la página para respaldar el diagnóstico y redacta con rigor de caso de estudio profesional para portfolio.

Devuelve EXCLUSIVAMENTE un JSON válido con esta estructura exacta:
{
  "puntaje": 85,
  "resumen_ejecutivo": "Síntesis ejecutiva de 2-3 líneas resumiendo el punto fuerte de la landing y su principal fuga de conversión.",
  "cartesiano": {
    "labels": ["Hero", "Propuesta / Beneficios", "Prueba Social", "CTA Final"],
    "valores": [8, 7, 9, 6]
  },
  "radar": {
    "labels": ["Propuesta de Valor", "Relevancia", "Claridad", "Reducción de Ansiedad", "Urgencia"],
    "valores": [8, 8, 7, 9, 4]
  },
  "curva_emocional": { "inicio": 1, "desarrollo": 3, "cierre": 2 },
  "diagnostico_general": [
    "Fricción LIFT principal (citando texto real): ...",
    "Punto fuerte detectado (qué variable LIFT neutraliza objeciones): ...",
    "Oportunidad de conversión prioritaria: ..."
  ],
  "diagnostico_cognitivo": [
    "Zajonc / Ekman (fluidez cognitiva y reacción afectiva inmediata): ...",
    "Teoría de la Mente (sintonía con dudas y miedos implícitos del decisor): ..."
  ],
  "test_ab": {
    "opcion_a": "REDISEÑO A del Hero (Claridad Funcional): [TÍTULO], [SUBTÍTULO] y [CTA] nuevos resolviendo la fricción principal. Debajo, justificación clínica.",
    "opcion_a_cuando_usar": "Frase corta y accionable.",
    "opcion_b": "REDISEÑO B del Hero (Urgencia + Anti-Fricción): [TÍTULO], [SUBTÍTULO] y [CTA] priorizando bajar ansiedad y activar urgencia genuina. Debajo, justificación técnica.",
    "opcion_b_cuando_usar": "Frase corta y accionable."
  },
  "hipotesis_medicion_ga4": [
    "CTR del CTA primario segmentado por variante del hero: qué valida.",
    "Scroll depth hasta la sección de mayor engagement: qué confirma.",
    "Evento custom de salida temprana (ej. hero_exit vs scroll): cómo probar la fricción en datos."
  ]
}

IMPORTANTE:
- "cartesiano.labels" deben reflejar 3 a 5 secciones reales detectadas en la página (0 a 10 en valores).
- "radar.valores" va de 0 a 10 (en Reducción de Ansiedad, más alto = mejor).
- "curva_emocional" va de -5 a +5.

Contenido extraído de la landing page:
"""
${contenido}
"""`;
  }

  if (modo === "soporte") {
    return `Eres un Auditor Cognitivo experto en Experiencia de Cliente (CX) y psicología del consumidor.
Analiza este mensaje de atención al cliente/soporte basándote en Ekman, Zajonc y la Teoría de la Mente, evaluando si reduce o aumenta la carga emocional y la carga de prueba del usuario.

Devuelve EXCLUSIVAMENTE un JSON válido con esta estructura exacta:
{
  "puntaje": 75,
  "resumen_ejecutivo": "Síntesis ejecutiva de 2 líneas sobre el impacto emocional y operativo de esta respuesta.",
  "cartesiano": { "labels": ["Apertura", "Explicación", "Cierre / Salida"], "valores": [6, 5, 7] },
  "radar": { "labels": ["Emociones (Ekman)", "Reacción (Zajonc)", "Empatía Operativa", "Teoría Mente", "Claridad"], "valores": [6, 7, 5, 6, 8] },
  "curva_emocional": { "inicio": -2, "desarrollo": 0, "cierre": 2 },
  "diagnostico_general": [
    "Fricción operativa detectada (¿traslada la carga de prueba al usuario o la asume el sistema?): ...",
    "Falla o acierto de Teoría de la Mente (¿valida la urgencia real?): ...",
    "Oportunidad de Válvula de Escape (cómo bajar la carga cognitiva): ..."
  ],
  "diagnostico_cognitivo": [
    "Zajonc / Ekman (micro-reacción afectiva frente al tono del mensaje): ...",
    "Carga Cognitiva: cuánto esfuerzo mental exige el siguiente paso al cliente."
  ],
  "test_ab": {
    "opcion_a": "REDISEÑO A (Triage con SLA claro): Respuesta COMPLETA que valide la frustración, fije plazo concreto y traslade la responsabilidad al sistema. Debajo, justificación clínica.",
    "opcion_a_cuando_usar": "Frase corta y accionable.",
    "opcion_b": "REDISEÑO B (Resolución Inmediata): Segunda variante COMPLETA con salida automática sin más esfuerzo del usuario. Debajo, justifica la Paradoja de Recuperación del Servicio.",
    "opcion_b_cuando_usar": "Frase corta y accionable."
  },
  "hipotesis_medicion_ga4": [
    "CSAT / Tasa de recontacto en 48hs tras recibir este mensaje.",
    "Customer Effort Score (CES) en el flujo de resolución.",
    "Tasa de escalamiento a reclamo formal o churn post-ticket."
  ]
}
Mensaje a analizar:
"""
${contenido}
"""`;
  }

  // Modo Ads por defecto
  return `Eres un Auditor Cognitivo experto en growth marketing y psicología del consumidor.
Analiza este texto publicitario basándote en Ekman, Zajonc y la Teoría de la Mente.

Devuelve EXCLUSIVAMENTE un JSON válido con esta estructura exacta:
{
  "puntaje": 80,
  "resumen_ejecutivo": "Síntesis ejecutiva de 2 líneas sobre el potencial de detención de scroll y conversión del anuncio.",
  "cartesiano": { "labels": ["Gancho / Inicio", "Desarrollo", "Cierre / CTA"], "valores": [7, 6, 8] },
  "radar": { "labels": ["Emociones (Ekman)", "Reacción (Zajonc)", "Motivación", "Teoría Mente", "Claridad"], "valores": [7, 8, 6, 7, 9] },
  "curva_emocional": { "inicio": -1, "desarrollo": 2, "cierre": 4 },
  "diagnostico_general": [
    "Fricción principal detectada: ...",
    "Reacción afectiva real del usuario: ...",
    "Oportunidad de conversión: ..."
  ],
  "diagnostico_cognitivo": [
    "Zajonc / Ekman (disparador emocional dominante en los primeros 3 segundos): ...",
    "Teoría de la Mente (ajuste entre promesa y nivel de conciencia del prospecto): ..."
  ],
  "test_ab": {
    "opcion_a": "REDISEÑO A (Anclaje Emocional): Anuncio COMPLETO con [TÍTULO MAGNÉTICO], [CUERPO DEL TEXTO] y [CTA]. Debajo, justificación clínica según Zajonc y Ekman.",
    "opcion_a_cuando_usar": "Frase corta y accionable.",
    "opcion_b": "REDISEÑO B (Fricción Cero): Segunda variante COMPLETA con [TÍTULO], [CUERPO] y [CTA] enfocados en carga cognitiva mínima. Debajo, justificación técnica.",
    "opcion_b_cuando_usar": "Frase corta y accionable."
  },
  "hipotesis_medicion_ga4": [
    "Thumbstop rate / CTR saliente comparando Variante A vs Original.",
    "CPA / Costo por lead calificado en landing de destino.",
    "Porcentaje de rebote post-clic (para validar coherencia anuncio-landing)."
  ]
}
Texto a analizar:
"""
${contenido}
"""`;
}
