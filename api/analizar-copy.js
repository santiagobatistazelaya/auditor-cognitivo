module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Método no permitido' });

  try {
    let body = req.body;
    if (typeof body === 'string') {
      try { body = JSON.parse(body); } catch (e) { body = { texto: body }; }
    }

    const accion = body?.accion || "auditar";

    // =========================================================================
    // ACCIÓN 1: Leer solo la página principal y descubrir subpáginas clave
    // =========================================================================
    if (accion === "leer_home") {
      const url = (body?.url || "").trim();
      const escaneoProfundo = body?.escaneoProfundo !== false;

      if (!url || !/^https?:\/\//i.test(url)) {
        return res.status(400).json({ error: 'La URL debe empezar con http:// o https://' });
      }

      const homeData = await extraerContenidoWeb(url, 12000, 6000);

      if (!homeData.textoCrudo || homeData.textoCrudo.length < 80 || pareceBloqueoAntiBot(homeData.textoCrudo)) {
        return res.status(422).json({
          bloqueadoPorAntiBot: true,
          error: 'Este sitio bloquea el acceso automatizado (protección anti-bot).'
        });
      }

      const textoLimpio = limpiarMegaMenu(homeData.textoCrudo).substring(0, 11000);
      const subpaginas = escaneoProfundo
        ? descubrirSubpaginasClave(homeData.crudoOriginal, url, homeData.esHtml, 3)
        : [];

      return res.status(200).json({
        nombre: 'Página Principal',
        url,
        texto: textoLimpio,
        subpaginas
      });
    }

    // =========================================================================
    // ACCIÓN 2: Leer 1 subpágina en su propia ejecución independiente
    // =========================================================================
    if (accion === "leer_subpagina") {
      const url = (body?.url || "").trim();
      const nombre = (body?.nombre || "Sección").trim();

      if (!url || !/^https?:\/\//i.test(url)) {
        return res.status(200).json({ omitida: true });
      }

      const subData = await extraerContenidoWeb(url, 10000, 5000);
      if (!subData.textoCrudo || subData.textoCrudo.length < 100 || pareceBloqueoAntiBot(subData.textoCrudo)) {
        return res.status(200).json({ omitida: true });
      }

      const textoLimpio = limpiarMegaMenu(subData.textoCrudo).substring(0, 12000);
      return res.status(200).json({
        omitida: false,
        nombre,
        url,
        texto: textoLimpio
      });
    }

    // =========================================================================
    // ACCIÓN 3: Deduplicar secciones y ejecutar auditoría con Gemini
    // =========================================================================
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) return res.status(500).json({ error: "Falta configurar la API Key de Gemini" });

    const modo = body?.modo || "ads";
    const texto = (body?.texto || "").trim();
    const textoManual = (body?.textoManual || "").trim();
    const bloquesEntrada = Array.isArray(body?.bloques) ? body.bloques : [];

    let contenidoParaAnalizar = "";
    let paginasEscaneadas = [];

    if (modo === "landing") {
      if (textoManual.length >= 50) {
        paginasEscaneadas.push({ nombre: 'Contenido Pegado (Manual)', url: texto || '#' });
        contenidoParaAnalizar = `=== PÁGINA PRINCIPAL (${texto || 'URL con anti-bot'}) ===\n${limpiarMegaMenu(textoManual).substring(0, 14000)}`;
      } else if (bloquesEntrada.length > 0) {
        const home = bloquesEntrada[0];
        const lineasHomeSet = crearIndiceDeLineas(home.texto || "");
        const homeTexto = (home.texto || "").substring(0, 9500);

        paginasEscaneadas.push({ nombre: home.nombre || 'Página Principal', url: home.url || '#' });
        const bloquesLimpios = [`=== SECCIÓN 1: ${(home.nombre || 'PÁGINA PRINCIPAL').toUpperCase()} (${home.url}) ===\n${homeTexto}`];

        let idxSec = 2;
        for (let i = 1; i < bloquesEntrada.length; i++) {
          const sub = bloquesEntrada[i];
          if (!sub || !sub.texto) continue;

          // Saca header, mega-menú y footer repetidos de la Home
          const soloUnico = deduplicarContraHome(sub.texto, lineasHomeSet);
          if (soloUnico.length < 100) continue;

          paginasEscaneadas.push({ nombre: sub.nombre, url: sub.url });
          bloquesLimpios.push(
            `=== SECCIÓN ${idxSec}: ${sub.nombre.toUpperCase()} (${sub.url}) ===\n[Contenido propio de esta sección, sin menú ni footer repetido]\n${soloUnico.substring(0, 5200)}`
          );
          idxSec++;
        }

        contenidoParaAnalizar = bloquesLimpios.join("\n\n========================================\n\n");
      } else {
        return res.status(400).json({ error: 'No se recibió contenido para auditar.' });
      }
    } else {
      if (!texto) return res.status(400).json({ error: 'El texto es requerido' });
      contenidoParaAnalizar = texto;
    }

    const esMultiseccion = paginasEscaneadas.length > 1;
    const promptMaestro = construirPrompt(modo, contenidoParaAnalizar, paginasEscaneadas, esMultiseccion);

    const modelosGratuitos = [
      "gemini-2.5-flash",
      "gemini-2.5-flash-lite",
      "gemini-3.5-flash",
      "gemini-3.1-flash-lite"
    ];

    let responseText = null;
    let lastError = null;

    for (const modelo of modelosGratuitos) {
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 28000);

        const response = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${modelo}:generateContent?key=${apiKey}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              contents: [{ parts: [{ text: promptMaestro }] }],
              generationConfig: {
                response_mime_type: "application/json",
                temperature: 0.2,
                maxOutputTokens: 6000
              }
            }),
            signal: controller.signal
          }
        );
        clearTimeout(timeoutId);

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
      throw new Error(JSON.stringify(lastError || "Todos los modelos fallaron o excedieron el tiempo."));
    }

    const jsonResponse = JSON.parse(responseText);

    if (modo === "landing") {
      jsonResponse.paginas_escaneadas = paginasEscaneadas;
    }

    return res.status(200).json(jsonResponse);

  } catch (error) {
    console.error('Error detallado en el motor:', error);
    return res.status(500).json({ error: 'Falla interna del servidor', detalle: error.message });
  }
};

// Extrae contenido vía Jina Reader con fallback a fetch nativo
async function extraerContenidoWeb(targetUrl, jinaTimeoutMs = 11000, fallbackTimeoutMs = 5000) {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), jinaTimeoutMs);

    const jinaRes = await fetch(`https://r.jina.ai/${targetUrl}`, {
      headers: {
        'Accept': 'text/plain',
        'X-Return-Format': 'markdown',
        'X-Timeout': String(Math.floor(jinaTimeoutMs / 1000)),
        'User-Agent': 'AuditorCognitivo/2.3'
      },
      signal: controller.signal
    });
    clearTimeout(timeoutId);

    if (jinaRes.ok) {
      const markdown = await jinaRes.text();
      if (markdown && markdown.trim().length > 100) {
        const acotado = markdown.substring(0, 120000);
        return {
          textoCrudo: limpiarBasuraMarkdown(acotado),
          crudoOriginal: acotado,
          esHtml: false
        };
      }
    }
  } catch (jinaErr) {
    console.warn(`Jina Reader falló para ${targetUrl}:`, jinaErr.message);
  }

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), fallbackTimeoutMs);
    const pageResponse = await fetch(targetUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
        'Accept-Language': 'es-UY,es;q=0.9,en;q=0.8'
      },
      signal: controller.signal
    });
    clearTimeout(timeoutId);

    if (!pageResponse.ok) return { textoCrudo: "", crudoOriginal: "", esHtml: true };
    const html = await pageResponse.text();
    const acotadoHtml = html.substring(0, 140000);
    return {
      textoCrudo: extraerTextoVisible(acotadoHtml),
      crudoOriginal: acotadoHtml,
      esHtml: true
    };
  } catch {
    return { textoCrudo: "", crudoOriginal: "", esHtml: true };
  }
}

function pareceBloqueoAntiBot(texto) {
  const muestra = texto.substring(0, 1500).toLowerCase();
  const señales = [
    'access denied',
    'you don\'t have permission to access',
    'enable javascript and cookies to continue',
    'checking your browser before accessing',
    'attention required! | cloudflare',
    'just a moment...',
    'pardon our interruption',
    'incident id:'
  ];
  return texto.length < 1800 && señales.some(s => muestra.includes(s));
}

function limpiarBasuraMarkdown(md) {
  return md
    .replace(/!\[.*?\]\(data:image\/.*?\)/g, '')
    .replace(/!\[.*?\]\(.*?\)/g, '')
    .replace(/\r/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function limpiarMegaMenu(texto) {
  const lineas = texto.split('\n');
  const resultado = [];
  let rachaLinks = [];

  const esLineaSoloLink = (l) => {
    const t = l.trim();
    if (!t) return false;
    return /^[-*•]?\s*\[[^\]]{1,70}\]\([^)]+\)\s*$/.test(t);
  };

  const vaciarRacha = () => {
    if (rachaLinks.length > 6) {
      resultado.push(...rachaLinks.slice(0, 3));
      resultado.push(`[... ${rachaLinks.length - 3} enlaces de menú condensados ...]`);
    } else {
      resultado.push(...rachaLinks);
    }
    rachaLinks = [];
  };

  for (const linea of lineas) {
    if (esLineaSoloLink(linea)) {
      rachaLinks.push(linea);
    } else {
      if (rachaLinks.length > 0) vaciarRacha();
      resultado.push(linea);
    }
  }
  if (rachaLinks.length > 0) vaciarRacha();

  return resultado
    .join('\n')
    .replace(/\[([^\]]{2,100})\]\(https?:\/\/[^)]+\)/g, '$1')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function crearIndiceDeLineas(texto) {
  const set = new Set();
  for (const linea of texto.split('\n')) {
    const norm = linea.trim().toLowerCase();
    if (norm.length >= 12) set.add(norm);
  }
  return set;
}

function deduplicarContraHome(textoSubpagina, lineasHomeSet) {
  const filtradas = textoSubpagina.split('\n').filter((linea) => {
    const norm = linea.trim().toLowerCase();
    if (!norm) return true;
    if (norm.length >= 12 && lineasHomeSet.has(norm)) return false;
    return true;
  });

  return filtradas.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

function descubrirSubpaginasClave(contenidoCrudo, baseUrlStr, esHtml, maxPaginas = 3) {
  let baseUrl;
  try { baseUrl = new URL(baseUrlStr); } catch { return []; }

  const baseHost = baseUrl.hostname.replace(/^www\./, '');
  const basePathNormalizado = baseUrl.pathname.replace(/\/+$/, '') || '/';
  const candidatos = new Map();

  const regex = esHtml
    ? /<a[^>]+href=["']([^"'#]+)["'][^>]*>([\s\S]*?)<\/a>/gi
    : /\[([^\]]{2,60})\]\(([^)\s]+)\)/g;

  const excluir = /\/(login|log-in|signin|sign-in|signup|sign-up|register|auth|account|mi-cuenta|privacy|privacidad|terms|terminos|legal|cookies?|policy|politica|careers|jobs|empleo|press|prensa|status|api|cdn-cgi|wp-content|wp-admin|feed|rss|sitemap|search|buscar|wishlist|favoritos)\b/i;
  const textosGenericosBajaPrioridad = /^(ver todo|view all|see all|ver más|leer más|home|inicio|volver)$/i;
  const extensionesIgnorar = /\.(png|jpg|jpeg|gif|svg|webp|pdf|zip|mp4|mp3|css|js|xml|ico|json)$/i;

  const prioridadAlta = /(pricing|precios|planes|plans|servicios|services|product|producto|productos|solutions|soluciones|features|caracteristicas|funcionalidades|shop|store|tienda|catalogo|packs|paquetes|calzado|zapatillas|running|mujer|hombre|ofertas|sale|descuentos)/i;
  const prioridadMedia = /(about|nosotros|quienes-somos|empresa|company|filosofia|mision|vision|how-it-works|como-funciona|casos|cases|clientes|customers|demo|contacto|contact|equipo|team|why|por-que|ayuda|envios|devoluciones)/i;

  let match;
  while ((match = regex.exec(contenidoCrudo)) !== null) {
    const rawHref = (esHtml ? match[1] : match[2]).trim();
    const rawTexto = (esHtml ? match[2].replace(/<[^>]+>/g, '') : match[1]).replace(/\s+/g, ' ').trim();

    if (!rawHref || /^(mailto:|tel:|javascript:|#)/i.test(rawHref)) continue;

    let urlObj;
    try { urlObj = new URL(rawHref, baseUrl.origin); } catch { continue; }

    const host = urlObj.hostname.replace(/^www\./, '');
    if (host !== baseHost) continue;

    const cleanPath = urlObj.pathname.replace(/\/+$/, '') || '/';
    if (cleanPath === basePathNormalizado) continue;
    if (excluir.test(cleanPath) || extensionesIgnorar.test(cleanPath)) continue;

    const segmentos = cleanPath.split('/').filter(Boolean);
    if (segmentos.length === 0 || segmentos.length > 2) continue;

    const cleanUrl = `${urlObj.origin}${cleanPath}`;
    let puntaje = 0;

    if (prioridadAlta.test(cleanPath) || prioridadAlta.test(rawTexto)) puntaje += 10;
    else if (prioridadMedia.test(cleanPath) || prioridadMedia.test(rawTexto)) puntaje += 6;
    else puntaje += 2;

    if (segmentos.length === 1) puntaje += 3;
    if (textosGenericosBajaPrioridad.test(rawTexto)) puntaje -= 5;

    const nombreLimpio = (rawTexto && rawTexto.length >= 3 && rawTexto.length <= 32 && !/^http/i.test(rawTexto))
      ? rawTexto
      : segmentos[segmentos.length - 1].replace(/[-_]/g, ' ').replace(/\b\w/g, c => c.toUpperCase());

    if (!candidatos.has(cleanUrl) || candidatos.get(cleanUrl).puntaje < puntaje) {
      candidatos.set(cleanUrl, { url: cleanUrl, nombre: nombreLimpio, puntaje });
    }
  }

  return Array.from(candidatos.values())
    .filter(c => c.puntaje >= 5)
    .sort((a, b) => b.puntaje - a.puntaje)
    .slice(0, maxPaginas);
}

function extraerTextoVisible(html) {
  let limpio = html.replace(/<script[\s\S]*?<\/script>/gi, '\n');
  limpio = limpio.replace(/<style[\s\S]*?<\/style>/gi, '\n');
  limpio = limpio.replace(/<!--[\s\S]*?-->/g, '\n');
  limpio = limpio.replace(/<\/(p|div|h1|h2|h3|h4|li|section|article|tr)>/gi, '\n');
  limpio = limpio.replace(/<[^>]+>/g, ' ');
  limpio = limpio.replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&');
  return limpio.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}

function construirPrompt(modo, contenido, paginasEscaneadas = [], esMultiseccion = false) {
  if (modo === "landing") {
    const listaPaginas = paginasEscaneadas.map(p => p.nombre).join(', ');
    const ejemploSecciones = paginasEscaneadas.map(p => ({
      nombre: p.nombre,
      url: p.url,
      puntaje: 78,
      rol_en_embudo: "Qué objetivo cumple esta página dentro del recorrido.",
      que_funciona: "Acierto concreto encontrado EXCLUSIVAMENTE en esta página (con cita textual real).",
      friccion_principal: "Fricción cognitiva o falla LIFT específica de ESTA página.",
      mejora_inmediata: "Cambio concreto y accionable para optimizar esta sección."
    }));

    return `Eres un Auditor Cognitivo Senior especializado en CRO (Conversion Rate Optimization) y psicología del consumidor.
Analiza en profundidad el contenido extraído de este sitio web${esMultiseccion ? ` (se auditaron ${paginasEscaneadas.length} páginas: ${listaPaginas})` : ''}.

REGLA CRÍTICA DE PROFUNDIDAD:
- No te quedes solo con el menú o el footer. Cada sección secundaria ya fue limpiada de elementos repetidos para que evalúes el contenido PROPIO de cada apartado.
- Debes auditar CADA UNA de las páginas recibidas en el array "auditoria_por_seccion" (exactamente ${paginasEscaneadas.length} elementos, respetando sus nombres y URLs), señalando hallazgos distintos y citas textuales reales de cada página.
- Aplica el Modelo LIFT (Propuesta de Valor, Relevancia, Claridad, Reducción de Ansiedad, Urgencia) + lectura cognitiva (Zajonc, Ekman, Teoría de la Mente).

Devuelve EXCLUSIVAMENTE un JSON válido con esta estructura exacta:
{
  "puntaje": 82,
  "resumen_ejecutivo": "Síntesis ejecutiva de 2-3 líneas resumiendo la salud global del sitio y su principal fuga de conversión.",
  "analisis_continuidad": "${esMultiseccion ? 'Párrafo clínico evaluando la coherencia entre la Página Principal y las secciones internas.' : ''}",
  "auditoria_por_seccion": ${JSON.stringify(ejemploSecciones, null, 2)},
  "cartesiano": {
    "labels": ${esMultiseccion ? JSON.stringify(paginasEscaneadas.map(p => p.nombre)) : '["Hero", "Propuesta / Beneficios", "Prueba Social", "CTA Final"]'},
    "valores": [${esMultiseccion ? paginasEscaneadas.map(() => 7).join(', ') : '8, 7, 8, 6'}]
  },
  "radar": {
    "labels": ["Propuesta de Valor", "Relevancia", "Claridad", "Reducción de Ansiedad", "Urgencia"],
    "valores": [8, 8, 7, 9, 4]
  },
  "curva_emocional": { "inicio": 2, "desarrollo": 1, "cierre": 3 },
  "diagnostico_general": [
    "Fricción LIFT global principal (con evidencia textual): ...",
    "Punto fuerte estructural del sitio: ...",
    "Oportunidad de conversión prioritaria (qué cambiar primero): ..."
  ],
  "diagnostico_cognitivo": [
    "Zajonc / Ekman (fluidez cognitiva y reacción afectiva inmediata): ...",
    "Teoría de la Mente (sintonía con dudas y miedos implícitos del visitante): ..."
  ],
  "test_ab": {
    "opcion_a": "REDISEÑO A (Claridad Funcional): [TÍTULO], [SUBTÍTULO] y [CTA] nuevos resolviendo la fricción principal. Debajo, justificación clínica.",
    "opcion_a_cuando_usar": "Frase corta y accionable.",
    "opcion_b": "REDISEÑO B (Urgencia + Anti-Fricción): [TÍTULO], [SUBTÍTULO] y [CTA] priorizando bajar ansiedad y sumar urgencia genuina. Debajo, justificación técnica.",
    "opcion_b_cuando_usar": "Frase corta y accionable."
  },
  "hipotesis_medicion_ga4": [
    "CTR del CTA primario segmentado por variante: qué confirmaría la hipótesis.",
    "Métrica de navegación o scroll entre secciones auditadas: qué buscar en los datos.",
    "Evento custom de abandono temprano: cómo validar si la fricción es real."
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
Analiza este mensaje de soporte basándote en Ekman, Zajonc y la Teoría de la Mente.

Devuelve EXCLUSIVAMENTE un JSON válido con esta estructura exacta:
{
  "puntaje": 75,
  "resumen_ejecutivo": "Síntesis ejecutiva de 2 líneas sobre el impacto emocional y operativo de esta respuesta.",
  "cartesiano": { "labels": ["Apertura", "Explicación", "Cierre / Salida"], "valores": [6, 5, 7] },
  "radar": { "labels": ["Emociones (Ekman)", "Reacción (Zajonc)", "Empatía Operativa", "Teoría Mente", "Claridad"], "valores": [6, 7, 5, 6, 8] },
  "curva_emocional": { "inicio": -2, "desarrollo": 0, "cierre": 2 },
  "diagnostico_general": [
    "Fricción operativa detectada: ...",
    "Falla o acierto de Teoría de la Mente: ...",
    "Oportunidad de Válvula de Escape: ..."
  ],
  "diagnostico_cognitivo": [
    "Zajonc / Ekman: ...",
    "Carga Cognitiva: ..."
  ],
  "test_ab": {
    "opcion_a": "REDISEÑO A (Triage con SLA claro): Respuesta COMPLETA + justificación clínica.",
    "opcion_a_cuando_usar": "Frase corta y accionable.",
    "opcion_b": "REDISEÑO B (Resolución Inmediata): Respuesta COMPLETA + justificación.",
    "opcion_b_cuando_usar": "Frase corta y accionable."
  },
  "hipotesis_medicion_ga4": [
    "CSAT / Tasa de recontacto en 48hs.",
    "Customer Effort Score (CES) en el flujo de resolución.",
    "Tasa de escalamiento o churn post-ticket."
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
    "Zajonc / Ekman: ...",
    "Teoría de la Mente: ..."
  ],
  "test_ab": {
    "opcion_a": "REDISEÑO A (Anclaje Emocional): [TÍTULO], [CUERPO] y [CTA] + justificación clínica.",
    "opcion_a_cuando_usar": "Frase corta y accionable.",
    "opcion_b": "REDISEÑO B (Fricción Cero): [TÍTULO], [CUERPO] y [CTA] + justificación técnica.",
    "opcion_b_cuando_usar": "Frase corta y accionable."
  },
  "hipotesis_medicion_ga4": [
    "Thumbstop rate / CTR saliente comparando Variante A vs Original.",
    "CPA / Costo por lead calificado en landing de destino.",
    "Tasa de rebote post-clic."
  ]
}
Texto a analizar:
"""
${contenido}
"""`;
}
