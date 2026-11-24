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
    // ACCIÓN 1: Leer página principal y descubrir secciones clave
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

      const textoLimpio = limpiarContenidoCRO(homeData.textoCrudo).substring(0, 9000);
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
    // ACCIÓN 2: Leer 1 subpágina en ejecución independiente
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

      const textoLimpio = limpiarContenidoCRO(subData.textoCrudo).substring(0, 9000);
      return res.status(200).json({
        omitida: false,
        nombre,
        url,
        texto: textoLimpio
      });
    }

    // =========================================================================
    // ACCIÓN 3: Auditoría con presupuesto de tiempo controlado (< 53s)
    // =========================================================================
    const inicio = Date.now();
    const LIMITE_TOTAL_MS = 53000;
    const tiempoRestante = () => LIMITE_TOTAL_MS - (Date.now() - inicio);

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey && !process.env.GROQ_API_KEY) {
      return res.status(500).json({ error: "Falta configurar la API Key en Vercel." });
    }

    const modo = body?.modo || "ads";
    const texto = (body?.texto || "").trim();
    const textoManual = (body?.textoManual || "").trim();
    const bloquesEntrada = Array.isArray(body?.bloques) ? body.bloques : [];

    // Armamos versión normal y versión compacta (por si una web muy densa necesita un reintento más liviano)
    const { contenidoNormal, contenidoCompacto, paginasEscaneadas, errorValidacion } = prepararContexto(
      modo,
      texto,
      textoManual,
      bloquesEntrada
    );

    if (errorValidacion) {
      return res.status(400).json({ error: errorValidacion });
    }

    const esMultiseccion = paginasEscaneadas.length > 1;
    const promptNormal = construirPrompt(modo, contenidoNormal, paginasEscaneadas, esMultiseccion);
    const promptCompacto = construirPrompt(modo, contenidoCompacto, paginasEscaneadas, esMultiseccion);

    // 1. Descubrir modelos flash activos (hasta 4, priorizando estables sobre preview)
    const modelosActivos = apiKey ? await obtenerModelosGeminiActivos(apiKey) : [];

    let jsonResponse = null;
    const resumenErrores = [];

    // 2. Ronda principal sobre modelos activos de Gemini
    for (let i = 0; i < modelosActivos.length && !jsonResponse; i++) {
      const disponible = tiempoRestante();
      if (disponible < 8000) break;

      const modelo = modelosActivos[i];
      // Si el primero falló por lento, los siguientes usan el prompt compacto para responder rápido
      const promptUsar = i === 0 ? promptNormal : promptCompacto;
      const timeoutModelo = i === 0 ? Math.min(24000, disponible - 2000) : Math.min(18000, disponible - 2000);

      const intento = await invocarGemini(apiKey, modelo, promptUsar, timeoutModelo);
      if (intento.ok) {
        jsonResponse = intento.data;
      } else {
        resumenErrores.push(`${modelo}: ${intento.motivo} (${intento.seg}s)`);
      }
    }

    // 3. Respaldo automático con Groq (independiente de Google, ~3 segundos)
    if (!jsonResponse && process.env.GROQ_API_KEY && tiempoRestante() >= 7000) {
      const intentoGroq = await invocarGroq(process.env.GROQ_API_KEY, promptCompacto, Math.min(15000, tiempoRestante() - 1000));
      if (intentoGroq.ok) {
        jsonResponse = intentoGroq.data;
      } else {
        resumenErrores.push(`groq: ${intentoGroq.motivo} (${intentoGroq.seg}s)`);
      }
    }

    // 4. Último intento compacto en el mejor modelo Gemini si sobra tiempo (absorbe 503 breves o timeouts del 1er intento)
    if (!jsonResponse && apiKey && modelosActivos.length > 0 && tiempoRestante() >= 14000) {
      await new Promise(r => setTimeout(r, 1500));
      const modeloRetry = modelosActivos[0];
      const intentoFinal = await invocarGemini(apiKey, modeloRetry, promptCompacto, Math.min(20000, tiempoRestante() - 1500));
      if (intentoFinal.ok) {
        jsonResponse = intentoFinal.data;
      } else {
        resumenErrores.push(`retry-${modeloRetry}: ${intentoFinal.motivo} (${intentoFinal.seg}s)`);
      }
    }

    if (!jsonResponse) {
      return res.status(503).json({
        error: `Los modelos de IA no respondieron a tiempo (${resumenErrores.join(' | ')}).`
      });
    }

    const resultadoSeguro = normalizarResultado(jsonResponse, paginasEscaneadas, modo);
    return res.status(200).json(resultadoSeguro);

  } catch (error) {
    console.error('Error detallado en el motor:', error);
    return res.status(500).json({ error: 'Falla interna del servidor', detalle: error.message });
  }
};

// =============================================================================
// PREPARACIÓN DE CONTEXTO Y NORMALIZACIÓN DE RESPUESTA
// =============================================================================
function prepararContexto(modo, texto, textoManual, bloquesEntrada) {
  let paginasEscaneadas = [];

  if (modo !== "landing") {
    if (!texto) return { errorValidacion: 'El texto es requerido.' };
    return {
      contenidoNormal: texto.substring(0, 6000),
      contenidoCompacto: texto.substring(0, 3500),
      paginasEscaneadas
    };
  }

  if (textoManual.length >= 50) {
    const limpio = limpiarContenidoCRO(textoManual);
    paginasEscaneadas.push({ nombre: 'Contenido Pegado (Manual)', url: texto || '#' });
    return {
      contenidoNormal: `=== PÁGINA PRINCIPAL ===\n${limpio.substring(0, 6500)}`,
      contenidoCompacto: `=== PÁGINA PRINCIPAL ===\n${limpio.substring(0, 3800)}`,
      paginasEscaneadas
    };
  }

  if (bloquesEntrada.length === 0) {
    return { errorValidacion: 'No se recibió contenido para auditar.' };
  }

  const home = bloquesEntrada[0];
  const lineasHomeSet = crearIndiceDeLineas(home.texto || "");
  const homeNombre = home.nombre || 'Página Principal';

  paginasEscaneadas.push({ nombre: homeNombre, url: home.url || '#' });

  const normales = [`=== SECCIÓN 1: ${homeNombre.toUpperCase()} (${home.url}) ===\n${(home.texto || "").substring(0, 4200)}`];
  const compactos = [`=== SECCIÓN 1: ${homeNombre.toUpperCase()} (${home.url}) ===\n${(home.texto || "").substring(0, 2600)}`];

  let idxSec = 2;
  for (let i = 1; i < bloquesEntrada.length; i++) {
    const sub = bloquesEntrada[i];
    if (!sub || !sub.texto) continue;

    const soloUnico = deduplicarContraHome(sub.texto, lineasHomeSet);
    if (soloUnico.length < 90) continue;

    paginasEscaneadas.push({ nombre: sub.nombre, url: sub.url });
    normales.push(`=== SECCIÓN ${idxSec}: ${sub.nombre.toUpperCase()} (${sub.url}) ===\n${soloUnico.substring(0, 2000)}`);
    compactos.push(`=== SECCIÓN ${idxSec}: ${sub.nombre.toUpperCase()} (${sub.url}) ===\n${soloUnico.substring(0, 1200)}`);
    idxSec++;
  }

  return {
    contenidoNormal: normales.join("\n\n---\n\n"),
    contenidoCompacto: compactos.join("\n\n---\n\n"),
    paginasEscaneadas
  };
}

function parsearJsonSeguro(rawText) {
  if (!rawText || typeof rawText !== 'string') throw new Error('Respuesta vacía');
  let clean = rawText.replace(/```json/gi, '').replace(/```/g, '').trim();
  const first = clean.indexOf('{');
  const last = clean.lastIndexOf('}');
  if (first === -1 || last === -1) throw new Error('Sin llaves JSON');
  return JSON.parse(clean.substring(first, last + 1));
}

function normalizarResultado(raw, paginasEscaneadas, modo) {
  const clamp = (n, min, max, fallback) => {
    const v = Number(n);
    return Number.isFinite(v) ? Math.max(min, Math.min(max, Math.round(v))) : fallback;
  };

  const defaultCartLabels = paginasEscaneadas.length > 1
    ? paginasEscaneadas.map(p => p.nombre)
    : ['Inicio', 'Desarrollo', 'Cierre'];

  const cartLabels = Array.isArray(raw?.cartesiano?.labels) && raw.cartesiano.labels.length > 0
    ? raw.cartesiano.labels.map(String)
    : defaultCartLabels;

  const cartValsRaw = Array.isArray(raw?.cartesiano?.valores) ? raw.cartesiano.valores : [];
  const cartValores = cartLabels.map((_, idx) => clamp(cartValsRaw[idx], 0, 10, 7));

  const defaultRadarLabels = modo === 'landing'
    ? ['Propuesta de Valor', 'Relevancia', 'Claridad', 'Reducción de Ansiedad', 'Urgencia']
    : ['Emociones (Ekman)', 'Reacción (Zajonc)', 'Motivación', 'Teoría Mente', 'Claridad'];

  const radarLabels = Array.isArray(raw?.radar?.labels) && raw.radar.labels.length === 5
    ? raw.radar.labels.map(String)
    : defaultRadarLabels;

  const radarValsRaw = Array.isArray(raw?.radar?.valores) ? raw.radar.valores : [];
  const radarValores = radarLabels.map((_, idx) => clamp(radarValsRaw[idx], 0, 10, 7));

  const resultado = {
    puntaje: clamp(raw?.puntaje, 0, 100, 75),
    resumen_ejecutivo: String(raw?.resumen_ejecutivo || ''),
    analisis_continuidad: String(raw?.analisis_continuidad || ''),
    auditoria_por_seccion: Array.isArray(raw?.auditoria_por_seccion)
      ? raw.auditoria_por_seccion.map((s, idx) => ({
          nombre: String(s?.nombre || paginasEscaneadas[idx]?.nombre || `Sección ${idx + 1}`),
          url: String(s?.url || paginasEscaneadas[idx]?.url || '#'),
          puntaje: clamp(s?.puntaje, 0, 100, 70),
          rol_en_embudo: String(s?.rol_en_embudo || ''),
          que_funciona: String(s?.que_funciona || ''),
          friccion_principal: String(s?.friccion_principal || ''),
          mejora_inmediata: String(s?.mejora_inmediata || '')
        }))
      : [],
    cartesiano: { labels: cartLabels, valores: cartValores },
    radar: { labels: radarLabels, valores: radarValores },
    curva_emocional: {
      inicio: clamp(raw?.curva_emocional?.inicio, -5, 5, 1),
      desarrollo: clamp(raw?.curva_emocional?.desarrollo, -5, 5, 1),
      cierre: clamp(raw?.curva_emocional?.cierre, -5, 5, 2)
    },
    diagnostico_general: Array.isArray(raw?.diagnostico_general) ? raw.diagnostico_general.map(String) : [],
    diagnostico_cognitivo: Array.isArray(raw?.diagnostico_cognitivo) ? raw.diagnostico_cognitivo.map(String) : [],
    test_ab: {
      opcion_a: String(raw?.test_ab?.opcion_a || ''),
      opcion_a_cuando_usar: String(raw?.test_ab?.opcion_a_cuando_usar || ''),
      opcion_b: String(raw?.test_ab?.opcion_b || ''),
      opcion_b_cuando_usar: String(raw?.test_ab?.opcion_b_cuando_usar || '')
    },
    hipotesis_medicion_ga4: Array.isArray(raw?.hipotesis_medicion_ga4) ? raw.hipotesis_medicion_ga4.map(String) : []
  };

  if (modo === "landing") {
    resultado.paginas_escaneadas = paginasEscaneadas;
  }

  return resultado;
}

// =============================================================================
// CLIENTES DE IA (GEMINI + GROQ)
// =============================================================================
async function obtenerModelosGeminiActivos(apiKey) {
  const base = ["gemini-3.5-flash", "gemini-3.1-flash-lite"];
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 3500);

  try {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`, { signal: ctrl.signal });
    if (!res.ok) return base;

    const listData = await res.json();
    const descubiertos = (listData.models || [])
      .filter(m =>
        (m.supportedGenerationMethods || []).includes("generateContent") &&
        /gemini.*flash/i.test(m.name) &&
        !/(image|audio|tts|vision|robotics|computer-use|embedding|live|thinking)/i.test(m.name)
      )
      .map(m => m.name.replace(/^models\//, ""));

    if (descubiertos.length === 0) return base;

    // Prioriza versiones estables sobre preview/exp y lite rápidos como respaldo
    const peso = (name) => {
      let score = 50;
      if (/preview|exp/i.test(name)) score += 20;
      if (/3\.5-flash$/i.test(name)) score -= 30;
      else if (/flash-lite$/i.test(name)) score -= 25;
      else if (/flash$/i.test(name)) score -= 20;
      else if (/flash-lite/i.test(name)) score -= 15;
      return score;
    };

    return descubiertos.sort((a, b) => peso(a) - peso(b)).slice(0, 4);
  } catch {
    return base;
  } finally {
    clearTimeout(timer);
  }
}

async function invocarGemini(apiKey, modelo, prompt, timeoutMs) {
  const t0 = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${modelo}:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: {
            response_mime_type: "application/json",
            temperature: 0.2,
            maxOutputTokens: 3200
          }
        }),
        signal: controller.signal
      }
    );

    const data = await response.json();
    const seg = Math.round((Date.now() - t0) / 1000);

    if (response.ok && data.candidates?.[0]?.content?.parts?.[0]?.text) {
      const parsed = parsearJsonSeguro(data.candidates[0].content.parts[0].text);
      return { ok: true, data: parsed, seg };
    }
    return { ok: false, motivo: String(response.status), seg };
  } catch (err) {
    const seg = Math.round((Date.now() - t0) / 1000);
    return { ok: false, motivo: err.name === 'AbortError' ? 'timeout' : 'parse_err', seg };
  } finally {
    clearTimeout(timer);
  }
}

async function invocarGroq(groqKey, prompt, timeoutMs) {
  const t0 = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${groqKey}`
      },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        temperature: 0.2,
        max_tokens: 3000,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: 'Devuelve exclusivamente un objeto JSON válido respetando exactamente la estructura solicitada, en español.' },
          { role: 'user', content: prompt.substring(0, 14000) }
        ]
      }),
      signal: controller.signal
    });

    const data = await response.json();
    const seg = Math.round((Date.now() - t0) / 1000);

    if (response.ok && data.choices?.[0]?.message?.content) {
      const parsed = parsearJsonSeguro(data.choices[0].message.content);
      return { ok: true, data: parsed, seg };
    }
    return { ok: false, motivo: String(response.status), seg };
  } catch (err) {
    const seg = Math.round((Date.now() - t0) / 1000);
    return { ok: false, motivo: err.name === 'AbortError' ? 'timeout' : 'err', seg };
  } finally {
    clearTimeout(timer);
  }
}

// =============================================================================
// EXTRACCIÓN Y LIMPIEZA DE SITIOS WEB
// =============================================================================
async function extraerContenidoWeb(targetUrl, jinaTimeoutMs = 11000, fallbackTimeoutMs = 5500) {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), jinaTimeoutMs);

    const jinaRes = await fetch(`https://r.jina.ai/${targetUrl}`, {
      headers: {
        'Accept': 'text/plain',
        'X-Return-Format': 'markdown',
        'X-Timeout': String(Math.floor(jinaTimeoutMs / 1000)),
        'User-Agent': 'AuditorCognitivo/2.4'
      },
      signal: controller.signal
    });
    clearTimeout(timeoutId);

    if (jinaRes.ok) {
      const markdown = await jinaRes.text();
      if (markdown && markdown.trim().length > 100) {
        const acotado = markdown.substring(0, 120000);
        return {
          textoCrudo: acotado,
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

// Limpia mega-menús, imágenes, cookies, legales y líneas repetidas para enviar solo señal real de CRO
function limpiarContenidoCRO(texto) {
  const sinImagenes = texto
    .replace(/!\[.*?\]\(data:image\/.*?\)/g, '')
    .replace(/!\[.*?\]\(.*?\)/g, '')
    .replace(/\r/g, '');

  const lineas = sinImagenes.split('\n');
  const resultado = [];
  const vistas = new Set();
  let rachaLinks = [];

  const esLineaSoloLink = (l) => /^[-*•]?\s*\[[^\]]{1,70}\]\([^)]+\)\s*$/.test(l.trim());
  const esRuidoLegal = (l) => /(©\s*\d{4}|all rights reserved|todos los derechos reservados|política de privacidad|privacy policy|política de cookies|cookie settings|aceptar todas las cookies|términos de uso|terms of service|skip to main content|saltar al contenido)/i.test(l);

  const vaciarRacha = () => {
    if (rachaLinks.length > 5) {
      resultado.push(...rachaLinks.slice(0, 2));
      resultado.push(`[... ${rachaLinks.length - 2} enlaces de navegación condensados ...]`);
    } else {
      resultado.push(...rachaLinks);
    }
    rachaLinks = [];
  };

  for (const rawLinea of lineas) {
    if (esLineaSoloLink(rawLinea)) {
      rachaLinks.push(rawLinea);
      continue;
    }
    if (rachaLinks.length > 0) vaciarRacha();

    const limpia = rawLinea
      .replace(/\[([^\]]{1,120})\]\(https?:\/\/[^)]+\)/g, '$1')
      .replace(/https?:\/\/\S+/g, '')
      .replace(/\s+/g, ' ')
      .trim();

    if (!limpia || limpia.length < 3) continue;
    if (esRuidoLegal(limpia)) continue;

    // Evita repetir el mismo botón/frase 15 veces dentro de la misma página (ej. "Más información")
    const clave = limpia.toLowerCase();
    if (clave.length < 40 && vistas.has(clave)) continue;
    vistas.add(clave);

    resultado.push(limpia);
  }
  if (rachaLinks.length > 0) vaciarRacha();

  return resultado.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

function crearIndiceDeLineas(texto) {
  const set = new Set();
  for (const linea of texto.split('\n')) {
    const norm = linea.trim().toLowerCase();
    if (norm.length >= 10) set.add(norm);
  }
  return set;
}

function deduplicarContraHome(textoSubpagina, lineasHomeSet) {
  const filtradas = textoSubpagina.split('\n').filter((linea) => {
    const norm = linea.trim().toLowerCase();
    if (!norm) return false;
    if (norm.length >= 10 && lineasHomeSet.has(norm)) return false;
    return true;
  });
  return filtradas.join('\n').trim();
}

function descubrirSubpaginasClave(contenidoCrudo, baseUrlStr, esHtml, maxPaginas = 3) {
  let baseUrl;
  try { baseUrl = new URL(baseUrlStr); } catch { return []; }

  const baseHost = baseUrl.hostname.replace(/^www\./, '');
  const basePathNormalizado = baseUrl.pathname.replace(/\/+$/, '') || '/';
  const baseSegmentos = basePathNormalizado.split('/').filter(Boolean);
  const tienePrefijoIdioma = baseSegmentos.length === 1 && /^[a-z]{2}(-[a-z]{2})?$/i.test(baseSegmentos[0]);
  const maxProfundidad = tienePrefijoIdioma ? 3 : 2;

  const candidatos = new Map();
  const regex = esHtml
    ? /<a[^>]+href=["']([^"'#]+)["'][^>]*>([\s\S]*?)<\/a>/gi
    : /\[([^\]]{2,60})\]\(([^)\s]+)\)/g;

  const excluir = /\/(login|log-in|signin|sign-in|signup|sign-up|register|auth|account|mi-cuenta|privacy|privacidad|terms|terminos|legal|cookies?|policy|politica|careers|jobs|empleo|press|prensa|status|api|cdn-cgi|wp-content|wp-admin|feed|rss|sitemap|search|buscar|wishlist|favoritos|support|soporte|help|ayuda|legal-notice)\b/i;
  const textosGenericos = /^(ver todo|view all|see all|ver más|leer más|más información|learn more|home|inicio|volver|descubrir|explorar)$/i;
  const extensionesIgnorar = /\.(png|jpg|jpeg|gif|svg|webp|pdf|zip|mp4|mp3|css|js|xml|ico|json)$/i;

  const prioridadAlta = /(pricing|precios|planes|plans|servicios|services|product|producto|productos|solutions|soluciones|features|caracteristicas|funcionalidades|shop|store|tienda|catalogo|packs|paquetes|calzado|zapatillas|running|mujer|hombre|ofertas|sale|descuentos|ps5|ps-plus|games|juegos|hardware|consolas|accesorios)/i;
  const prioridadMedia = /(about|nosotros|quienes-somos|empresa|company|filosofia|mision|vision|how-it-works|como-funciona|casos|cases|clientes|customers|demo|contacto|contact|equipo|team|why|por-que)/i;

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

    // Si la Home tiene prefijo de idioma (ej. /es-uy), prioriza links del mismo idioma
    if (tienePrefijoIdioma && !cleanPath.toLowerCase().startsWith(`/${baseSegmentos[0].toLowerCase()}/`)) continue;

    const segmentos = cleanPath.split('/').filter(Boolean);
    if (segmentos.length === 0 || segmentos.length > maxProfundidad) continue;

    const cleanUrl = `${urlObj.origin}${cleanPath}`;
    let puntaje = 0;

    if (prioridadAlta.test(cleanPath) || prioridadAlta.test(rawTexto)) puntaje += 10;
    else if (prioridadMedia.test(cleanPath) || prioridadMedia.test(rawTexto)) puntaje += 6;
    else puntaje += 2;

    if (segmentos.length <= (tienePrefijoIdioma ? 2 : 1)) puntaje += 3;
    if (textosGenericos.test(rawTexto)) puntaje -= 5;

    const nombreLimpio = (rawTexto && rawTexto.length >= 2 && rawTexto.length <= 30 && !/^http/i.test(rawTexto))
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

// =============================================================================
// PROMPTS CLÍNICOS Y CONCISOS (RÁPIDOS Y SIN RELLENO)
// =============================================================================
function construirPrompt(modo, contenido, paginasEscaneadas = [], esMultiseccion = false) {
  if (modo === "landing") {
    const listaPaginas = paginasEscaneadas.map(p => p.nombre).join(', ');
    const ejemploSecciones = paginasEscaneadas.map(p => ({
      nombre: p.nombre,
      url: p.url,
      puntaje: 75,
      rol_en_embudo: "1 frase sobre su rol en el recorrido.",
      que_funciona: "1-2 frases con cita textual real de esta página.",
      friccion_principal: "1-2 frases sobre la falla LIFT específica de esta página.",
      mejora_inmediata: "1 frase concreta y accionable."
    }));

    return `Eres un Auditor Cognitivo Senior en CRO y psicología del consumidor.
Audita este sitio web${esMultiseccion ? ` (${paginasEscaneadas.length} páginas: ${listaPaginas})` : ''} usando el Modelo LIFT + Zajonc, Ekman y Teoría de la Mente.

REGLAS:
- Sé clínico, concreto y conciso (máx. 2 frases por campo, cero relleno).
- Cita texto real extraído de cada página.
- En "auditoria_por_seccion" devolvé exactamente ${paginasEscaneadas.length} ítems (uno por página recibida), sin repetir hallazgos entre páginas.

Devolvé EXCLUSIVAMENTE un JSON válido con esta estructura:
{
  "puntaje": 76,
  "resumen_ejecutivo": "2 frases directas: punto fuerte y mayor fuga de conversión.",
  "analisis_continuidad": "${esMultiseccion ? '2-3 frases evaluando si se sostiene la promesa al pasar de la Home a las secciones internas.' : ''}",
  "auditoria_por_seccion": ${JSON.stringify(ejemploSecciones)},
  "cartesiano": {
    "labels": ${esMultiseccion ? JSON.stringify(paginasEscaneadas.map(p => p.nombre)) : '["Hero", "Propuesta", "Prueba Social", "CTA Final"]'},
    "valores": [${esMultiseccion ? paginasEscaneadas.map(() => 7).join(', ') : '8, 7, 7, 6'}]
  },
  "radar": {
    "labels": ["Propuesta de Valor", "Relevancia", "Claridad", "Reducción de Ansiedad", "Urgencia"],
    "valores": [8, 7, 6, 7, 4]
  },
  "curva_emocional": { "inicio": 2, "desarrollo": 0, "cierre": 1 },
  "diagnostico_general": [
    "Fricción LIFT principal (con cita real): ...",
    "Punto fuerte estructural: ...",
    "Oportunidad prioritaria (qué cambiar primero): ..."
  ],
  "diagnostico_cognitivo": [
    "Zajonc / Ekman: ...",
    "Teoría de la Mente: ..."
  ],
  "test_ab": {
    "opcion_a": "REDISEÑO A (Claridad Funcional): [TÍTULO] ... [SUBTÍTULO] ... [CTA] ... Justificación en 1 frase.",
    "opcion_a_cuando_usar": "Frase corta.",
    "opcion_b": "REDISEÑO B (Urgencia + Anti-Fricción): [TÍTULO] ... [SUBTÍTULO] ... [CTA] ... Justificación en 1 frase.",
    "opcion_b_cuando_usar": "Frase corta."
  },
  "hipotesis_medicion_ga4": [
    "Métrica/evento 1 medible en GA4.",
    "Métrica/evento 2 medible en GA4.",
    "Evento custom 3 para validar la fricción."
  ]
}

Contenido extraído:
"""
${contenido}
"""`;
  }

  if (modo === "soporte") {
    return `Eres un Auditor Cognitivo experto en CX y psicología del consumidor. Sé clínico y conciso (máx. 2 frases por campo).
Devolvé EXCLUSIVAMENTE un JSON válido:
{
  "puntaje": 75,
  "resumen_ejecutivo": "2 frases sobre el impacto emocional y operativo.",
  "cartesiano": { "labels": ["Apertura", "Explicación", "Cierre"], "valores": [6, 5, 7] },
  "radar": { "labels": ["Emociones (Ekman)", "Reacción (Zajonc)", "Empatía Operativa", "Teoría Mente", "Claridad"], "valores": [6, 7, 5, 6, 8] },
  "curva_emocional": { "inicio": -2, "desarrollo": 0, "cierre": 2 },
  "diagnostico_general": ["Fricción operativa: ...", "Teoría de la Mente: ...", "Válvula de escape: ..."],
  "diagnostico_cognitivo": ["Zajonc / Ekman: ...", "Carga cognitiva: ..."],
  "test_ab": {
    "opcion_a": "REDISEÑO A (Triage con SLA claro): respuesta completa + justificación breve.",
    "opcion_a_cuando_usar": "Frase corta.",
    "opcion_b": "REDISEÑO B (Resolución Inmediata): respuesta completa + justificación breve.",
    "opcion_b_cuando_usar": "Frase corta."
  },
  "hipotesis_medicion_ga4": ["CSAT / recontacto 48hs.", "Customer Effort Score (CES).", "Tasa de escalamiento o churn."]
}
Mensaje:
"""
${contenido}
"""`;
  }

  return `Eres un Auditor Cognitivo experto en growth marketing y psicología del consumidor. Sé clínico y conciso (máx. 2 frases por campo).
Devolvé EXCLUSIVAMENTE un JSON válido:
{
  "puntaje": 80,
  "resumen_ejecutivo": "2 frases sobre detención de scroll y potencial de conversión.",
  "cartesiano": { "labels": ["Gancho", "Desarrollo", "CTA"], "valores": [7, 6, 8] },
  "radar": { "labels": ["Emociones (Ekman)", "Reacción (Zajonc)", "Motivación", "Teoría Mente", "Claridad"], "valores": [7, 8, 6, 7, 9] },
  "curva_emocional": { "inicio": -1, "desarrollo": 2, "cierre": 4 },
  "diagnostico_general": ["Fricción principal: ...", "Reacción afectiva: ...", "Oportunidad de conversión: ..."],
  "diagnostico_cognitivo": ["Zajonc / Ekman: ...", "Teoría de la Mente: ..."],
  "test_ab": {
    "opcion_a": "REDISEÑO A (Anclaje Emocional): [TÍTULO] ... [CUERPO] ... [CTA] ... Justificación breve.",
    "opcion_a_cuando_usar": "Frase corta.",
    "opcion_b": "REDISEÑO B (Fricción Cero): [TÍTULO] ... [CUERPO] ... [CTA] ... Justificación breve.",
    "opcion_b_cuando_usar": "Frase corta."
  },
  "hipotesis_medicion_ga4": ["CTR saliente Variante A vs Original.", "CPA / costo por lead.", "Rebote post-clic en landing."]
}
Anuncio:
"""
${contenido}
"""`;
}
