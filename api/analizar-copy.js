module.exports = async function handler(req, res) {
  // Cabeceras para que tu web y el servidor hablen sin bloqueos
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Método no permitido' });

  try {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) return res.status(500).json({ error: "Falta configurar la API Key en Vercel" });

    // Leemos el texto de forma segura
    let texto = "";
    if (req.body) {
      if (typeof req.body === 'string') {
        try { texto = JSON.parse(req.body).texto; } catch (e) { texto = req.body; }
      } else {
        texto = req.body.texto;
      }
    }
    if (!texto) return res.status(400).json({ error: 'El texto es requerido' });

    // 1. AUTO-DESCUBRIMIENTO: Le preguntamos a Google qué modelos tenés habilitados
    const getModelsRes = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`);
    const modelsData = await getModelsRes.json();

    if (!modelsData.models) {
      throw new Error("No se pudo listar los modelos de Google. Revisá la API Key.");
    }

    // Filtramos para usar el primero que sirva para generar texto
    const validModels = modelsData.models.filter(m => 
      m.supportedGenerationMethods && 
      m.supportedGenerationMethods.includes("generateContent")
    );

    // Priorizamos un modelo "flash" si existe, sino agarramos el primero de la lista
    const bestModelObj = validModels.find(m => m.name.includes("flash")) || validModels[0];
    const finalModelName = bestModelObj.name.replace('models/', '');

    // 2. PETICIÓN DIRECTA: Mandamos a auditar usando el modelo auto-descubierto
    const promptMaestro = `Eres un Auditor Cognitivo avanzado, experto en analizar copys publicitarios utilizando marcos teóricos de la psicología cognitiva (Ekman, Zajonc, Teoría de la Mente).
    Analiza el siguiente texto y responde ÚNICAMENTE con un objeto JSON válido, sin bloques de código markdown ni texto adicional, respetando exactamente esta estructura:
    {
      "grafico_cartesiano": { "inicio": 7, "desarrollo": 6, "cierre": 8 },
      "grafico_radial": { "emociones_universales": 7, "reaccion_afectiva": 8, "motivacion_intrinseca": 6, "teoria_de_la_mente": 7, "claridad": 9 },
      "diagnostico_general": "Texto breve con feedback...",
      "test_ab": { "opcion_a": "Opción A...", "opcion_b": "Opción B..." }
    }
    Texto a analizar: "${texto}"`;

    const requestBody = {
      contents: [{ parts: [{ text: promptMaestro }] }]
    };

    const generateRes = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${finalModelName}:generateContent?key=${apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(requestBody)
    });

    const generateData = await generateRes.json();

    if (!generateRes.ok) {
      throw new Error(JSON.stringify(generateData.error || generateData));
    }

    // 3. LIMPIEZA Y ENTREGA: Agarramos el texto y forzamos que sea un JSON puro
    const responseText = generateData.candidates[0].content.parts[0].text;
    const cleanJson = responseText.replace(/```json/gi, '').replace(/```/g, '').trim();
    const jsonResponse = JSON.parse(cleanJson);
    
    return res.status(200).json(jsonResponse);

  } catch (error) {
    console.error('Error detallado en el motor:', error);
    return res.status(500).json({ error: 'Falla interna del servidor', detalle: error.message });
  }
};
