module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Método no permitido' });

  try {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) return res.status(500).json({ error: "Falta configurar la API Key de Gemini" });

    let body = req.body;
    if (typeof body === 'string') {
      try { body = JSON.parse(body); } catch (e) { body = { texto: body }; }
    }

    const modo = body?.modo || "ads";
    const texto = (body?.texto || "").trim();
    const escaneoProfundo = body?.escaneoProfundo !== false; // true por defecto

    if (!texto) return res.status(400).json({ error: 'El texto o la URL es requerido' });

    let contenidoParaAnalizar = texto;
    let paginasEscaneadas = [];

    // 1. Modo Web / Landing: lee la URL principal y, si está activo, rastrea subpáginas clave automáticamente
    if (modo === "landing") {
      if (!/^https?:\/\//i.test(texto)) {
        return res.status(400).json({ error: 'La URL debe empezar con http:// o https://' });
      }

      const homeData = await extraerContenidoWeb(texto, 12000);
      if (!homeData.texto || homeData.texto.length < 50) {
        return res.status(400).json({ error: 'No pudimos extraer suficiente texto de esa página. Verificá que sea pública.' });
      }

      paginasEscaneadas.push({ nombre: 'Página Principal', url: texto });

      let bloques = [`=== PÁGINA PRINCIPAL (${texto}) ===\n${homeData.texto}`];

      // Auto-descubrimiento de secciones clave (Servicios, Precios, Nosotros, Producto, etc.)
      if (escaneoProfundo) {
        const subpaginasClave = descubrirSubpaginasClave(homeData.crudo, texto, homeData.esHtml, 3);

        if (subpaginasClave.length > 0) {
          const resultadosSub = await Promise.all(
            subpaginasClave.map(async (sub) => {
              const subData = await extraerContenidoWeb(sub.url, 5000, 8000);
              if (subData.texto && subData.texto.length > 80) {
                return { nombre: sub.nombre, url: sub.url, texto: subData.texto };
              }
              return null;
            })
          );

          for (const item of resultadosSub) {
            if (item) {
              paginasEscaneadas.push({ nombre: item.nombre, url: item.url });
              bloques.push(`=== SECCIÓN DETECTADA: ${item.nombre.toUpperCase()} (${item.url}) ===\n${item.texto}`);
            }
          }
        }
      }

      contenidoParaAnalizar = bloques.join("\n\n----------------------------------------\n\n");
    }

    // 2. Prompt maestro adaptado a la profundidad detectada
    const esMultiseccion = paginasEscaneadas.length > 1;
    const promptMaestro = construirPrompt(modo, contenidoParaAnalizar, paginasEscaneadas, esMultiseccion);

    // 3. Llamada a Gemini con JSON nativo garantizado
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

    const jsonResponse = JSON.parse(responseText);

    // Adjuntamos metadata real de qué páginas leyó el crawler
    if (modo === "landing") {
      jsonResponse.paginas_escaneadas = paginasEscaneadas;
    }

    return res.status(200).json(jsonResponse);

  } catch (error) {
    console.error('Error detallado en el motor:', error);
    return res.status(500).json({ error: 'Falla interna del servidor', detalle: error.message });
  }
};

// Extrae contenido vía Jina Reader (renderiza JS y devuelve Markdown) con fallback a HTML nativo
async function extraerContenidoWeb(targetUrl, maxChars = 12000, timeoutMs = 11000) {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    const jinaRes = await fetch(`https://r.jina.ai/${targetUrl}`, {
      headers: {
        'Accept': 'text/plain',
        'X-Return-Format': 'markdown',
        'User-Agent': 'AuditorCognitivo/2.1'
      },
      signal: controller.signal
    });
    clearTimeout(timeoutId);

    if (jinaRes.ok) {
      const markdown = await jinaRes.text();
      if (markdown && markdown.trim().length > 100) {
        return {
          texto: limpiarMarkdown(markdown).substring(0, maxChars),
          crudo: markdown,
          esHtml: false
        };
      }
    }
  } catch (jinaErr) {
    console.warn(`Jina Reader falló para ${targetUrl}:`, jinaErr.message);
  }

  // Fallback nativo
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 7000);
    const pageResponse = await fetch(targetUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
      signal: controller.signal
    });
    clearTimeout(timeoutId);

    if (!pageResponse.ok) return { texto: "", crudo: "", esHtml: true };
    const html = await pageResponse.text();
    return {
      texto: extraerTextoVisible(html, maxChars),
      crudo: html,
      esHtml: true
    };
  } catch (fallbackErr) {
    return { texto: "", crudo: "", esHtml: true };
  }
}

// Descubre automáticamente los links internos más valiosos para CRO (Precios, Servicios, Nosotros, Producto)
function descubrirSubpaginasClave(contenidoCrudo, baseUrlStr, esHtml, maxPaginas = 3) {
  let baseUrl;
  try {
    baseUrl = new URL(baseUrlStr);
  } catch {
    return [];
  }

  const baseHost = baseUrl.hostname.replace(/^www\./, '');
  const basePathNormalizado = baseUrl.pathname.replace(/\/+$/, '') || '/';
  const candidatos = new Map();

  const regex = esHtml
    ? /<a[^>]+href=["']([^"'#]+)["'][^>]*>([\s\S]*?)<\/a>/gi
    : /\[([^\]]{2,60})\]\(([^)\s]+)\)/g;

  const excluir = /\/(login|log-in|signin|sign-in|signup|sign-up|register|auth|account|privacy|privacidad|terms|terminos|legal|cookies?|policy|politica|careers|jobs|empleo|press|prensa|status|api|cdn-cgi|wp-content|wp-admin|feed|rss|sitemap|search|buscar)\b/i;
  const extensionesIgnorar = /\.(png|jpg|jpeg|gif|svg|webp|pdf|zip|mp4|mp3|css|js|xml|ico|json)$/i;

  const prioridadAlta = /(pricing|precios|planes|plans|servicios|services|product|producto|productos|solutions|soluciones|features|caracteristicas|funcionalidades|shop|store|tienda|catalogo|packs|paquetes)/i;
  const prioridadMedia = /(about|nosotros|quienes-somos|empresa|company|filosofia|mision|vision|how-it-works|como-funciona|casos|cases|clientes|customers|demo|contacto|contact|equipo|team|why|por-que)/i;

  let match;
  while ((match = regex.exec(contenidoCrudo)) !== null) {
    const rawHref = (esHtml ? match[1] : match[2]).trim();
    const rawTexto = (esHtml ? match[2].replace(/<[^>]+>/g, '') : match[1]).replace(/\s+/g, ' ').trim();

    if (!rawHref || /^(mailto:|tel:|javascript:|#)/i.test(rawHref)) continue;

    let urlObj;
    try {
      urlObj = new URL(rawHref, baseUrl.origin);
    } catch {
      continue;
    }

    const host = urlObj.hostname.replace(/^www\./, '');
    if (host !== baseHost) continue;

    const cleanPath = urlObj.pathname.replace(/\/+$/, '') || '/';
    if (cleanPath === basePathNormalizado) continue;
    if (excluir.test(cleanPath) || extensionesIgnorar.test(cleanPath)) continue;

    // Evita artículos profundos de blog o URLs con demasiados niveles
    const segmentos = cleanPath.split('/').filter(Boolean);
    if (segmentos.length === 0 || segmentos.length > 2) continue;

    const cleanUrl = `${urlObj.origin}${cleanPath}`;
    let puntaje = 0;

    if (prioridadAlta.test(cleanPath) || prioridadAlta.test(rawTexto)) puntaje += 10;
    else if (prioridadMedia.test(cleanPath) || prioridadMedia.test(rawTexto)) puntaje += 6;
    else puntaje += 1;

    if (segmentos.length === 1) puntaje += 3;

    // Nombre legible para mostrar en el dashboard
    const nombreLimpio = (rawTexto && rawTexto.length >= 3 && rawTexto.length <= 32 && !/^http/i.test(rawTexto))
      ? rawTexto
      : segmentos[segmentos.length - 1].replace(/[-_]/g, ' ').replace(/\b\w/g, c => c.toUpperCase());

    if (!candidatos.has(cleanUrl) || candidatos.get(cleanUrl).puntaje < puntaje) {
      candidatos.set(cleanUrl, { url: cleanUrl, nombre: nombreLimpio, puntaje });
    }
  }

  return Array.from(candidatos.values())
    .filter(c => c.puntaje >= 4) // Solo subpáginas relevantes
    .sort((a, b) => b.puntaje - a.puntaje)
    .slice(0, maxPaginas);
}

function limpiarMarkdown(md) {
  return md
    .replace(/!\[.*?\]\(data:image\/.*?\)/g, '')
    .replace(/!\[.*?\]\(.*?\)/g, '')
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

function construirPrompt(modo, contenido, paginasEscaneadas = [], esMultiseccion = false) {
  if (modo === "landing") {
    const listaPaginas = paginasEscaneadas.map(p => p.nombre).join(' -> ');

    return `Eres un Auditor Cognitivo Senior especializado en CRO (Conversion Rate Optimization) y psicología del consumidor.
Analiza en profundidad el contenido completo extraído de este sitio web${esMultiseccion ? ` (incluyendo su página principal y las secciones detectadas automáticamente: ${listaPaginas})` : ''}.

Aplica:
1) Modelo LIFT (Propuesta de Valor, Relevancia, Claridad, Reducción de Ansiedad, Urgencia) como marco principal.
2) Lectura cognitiva complementaria desde Zajonc, Ekman y Teoría de la Mente sin repetir hallazgos.
${esMultiseccion ? '3) Coherencia y continuidad narrativa entre la página principal y sus secciones secundarias (¿lo que se promete en el inicio se sostiene en servicios, precios o filosofía?).' : ''}

Cita frases textuales reales extraídas del sitio para respaldar el diagnóstico. El resultado debe tener nivel ejecutivo, listo para publicar como caso de estudio en portfolio o LinkedIn.

Devuelve EXCLUSIVAMENTE un JSON válido con esta estructura exacta:
{
  "puntaje": 85,
  "resumen_ejecutivo": "Síntesis ejecutiva de 2-3 líneas resumiendo el punto fuerte del sitio y su mayor fuga de conversión.",
  "analisis_continuidad": "${esMultiseccion ? 'Párrafo clínico evaluando la coherencia entre la página principal y las secciones internas escaneadas.' : ''}",
  "cartesiano": {
    "labels": ${esMultiseccion ? JSON.stringify(paginasEscaneadas.map(p => p.nombre)) : '["Hero", "Propuesta / Beneficios", "Prueba Social", "CTA Final"]'},
    "valores": [${esMultiseccion ? paginasEscaneadas.map(() => 7).join(', ') : '8, 7, 8, 6'}]
  },
  "radar": {
    "labels": ["Propuesta de Valor", "Relevancia", "Claridad", "Reducción de Ansiedad", "Urgencia"],
    "valores": [8, 8, 7, 9, 4]
  },
  "curva_emocional": { "inicio": 1, "desarrollo": 3, "cierre": 2 },
  "diagnostico_general": [
    "Fricción LIFT principal (citando texto real): ...",
    "Punto fuerte detectado (qué variable LIFT neutraliza objeciones): ...",
    "Oportunidad de conversión prioritaria (qué cambiar primero): ..."
  ],
  "diagnostico_cognitivo": [
    "Zajonc / Ekman (fluidez cognitiva y reacción afectiva inmediata): ...",
    "Teoría de la Mente (sintonía con dudas y miedos implícitos del visitante): ..."
  ],
  "test_ab": {
    "opcion_a": "REDISEÑO A (Claridad Funcional): [TÍTULO], [SUBTÍTULO] y [CTA] nuevos resolviendo la fricción principal detectada. Debajo, justificación clínica.",
    "opcion_a_cuando_usar": "Frase corta y accionable.",
    "opcion_b": "REDISEÑO B (Urgencia + Anti-Fricción): [TÍTULO], [SUBTÍTULO] y [CTA] priorizando bajar ansiedad y sumar urgencia genuina. Debajo, justificación técnica.",
    "opcion_b_cuando_usar": "Frase corta y accionable."
  },
  "hipotesis_medicion_ga4": [
    "CTR del CTA primario segmentado por variante: qué confirmaría la hipótesis.",
    "Scroll depth o paso entre secciones clave: qué buscar en los datos.",
    "Evento custom de abandono temprano (ej. hero_exit): cómo probar si la fricción es real."
  ]
}

IMPORTANTE:
- "cartesiano.valores" debe coincidir en cantidad con "cartesiano.labels" (escala 0 a 10).
- "radar.valores" va de 0 a 10 (en Reducción de Ansiedad, más alto = mejor).
- "curva_emocional" va de -5 a +5.

Contenido extraído del sitio:
"""
${contenido}
"""`;
  }

  if (modo === "soporte") {
    return `Eres un Auditor Cognitivo experto en Experiencia de Cliente (CX) y psicología del consumidor.
Analiza este mensaje de soporte basándote en Ekman, Zajonc y la Teoría de la Mente, evaluando si reduce o aumenta la carga emocional y la carga de prueba del usuario.

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
