module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Método no permitido' });

  try {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) return res.status(500).json({ error: "Falta configurar la API Key" });

    let texto = "";
    if (req.body) {
      if (typeof req.body === 'string') {
        try { texto = JSON.parse(req.body).texto; } catch (e) { texto = req.body; }
      } else {
        texto = req.body.texto;
      }
    }
    if (!texto) return res.status(400).json({ error: 'El texto es requerido' });

    // 1. Buscamos modelos y filtramos el que nos bloqueó (2.5-flash)
    const getModelsRes = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`);
    const modelsData = await getModelsRes.json();
    if (!modelsData.models) throw new Error("No se pudo listar los modelos.");

    const validModels = modelsData.models.filter(m => 
      m.supportedGenerationMethods && 
      m.supportedGenerationMethods.includes("generateContent") && 
      !m.name.includes("2.5-flash")
    );

    // Priorizamos los modelos 1.5 que soportan JSON estricto
    const bestModelObj = validModels.find(m => m.name.includes("1.5-flash")) || 
                         validModels.find(m => m.name.includes("1.5-pro")) || 
                         validModels[0];

    if (!bestModelObj) throw new Error("No hay modelos disponibles.");
    const finalModelName = bestModelObj.name.replace('models/', '');

    const promptMaestro = `Eres un Auditor Cognitivo experto. Analiza este texto publicitario basándote en Ekman, Zajonc y la Teoría de la Mente.
    Tu respuesta DEBE ser un único objeto JSON. Completa los valores de este formato y no escribas nada fuera de las llaves:
    {
      "grafico_cartesiano": { "inicio": 7, "desarrollo": 6, "cierre": 8 },
      "grafico_radial": { "emociones_universales": 7, "reaccion_afectiva": 8, "motivacion_intrinseca": 6, "teoria_de_la_mente": 7, "claridad": 9 },
      "diagnostico_general": "Texto con feedback...",
      "test_ab": { "opcion_a": "Opción A...", "opcion_b": "Opción B..." }
    }
    Texto a analizar: "${texto}"`;

    // 2. EL TRUCO: Le exigimos a la API de Google que solo permita salir un JSON válido
    const requestBody = { 
        contents: [{ parts: [{ text: promptMaestro }] }],
        generationConfig: { responseMimeType: "application/json" }
    };

    let generateRes = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${finalModelName}:generateContent?key=${apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(requestBody)
    });

    let generateData = await generateRes.json();

    // Mecanismo de seguridad por si el modelo elegido no soporta el parámetro estricto
    if (!generateRes.ok && generateData.error && generateData.error.message.includes("responseMimeType")) {
        delete requestBody.generationConfig;
        generateRes = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${finalModelName}:generateContent?key=${apiKey}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(requestBody)
        });
        generateData = await generateRes.json();
    }

    if (!generateRes.ok) throw new Error(JSON.stringify(generateData.error));

    // 3. Limpieza final y lectura de datos
    const responseText = generateData.candidates[0].content.parts[0].text;
    
    let cleanJson = responseText.replace(/```json/gi, '').replace(/```/g, '').trim();
    const firstBrace = cleanJson.indexOf('{');
    const lastBrace = cleanJson.lastIndexOf('}');
    if (firstBrace !== -1 && lastBrace !== -1) {
        cleanJson = cleanJson.substring(firstBrace, lastBrace + 1);
    }

    const jsonResponse = JSON.parse(cleanJson);
    return res.status(200).json(jsonResponse);

  } catch (error) {
    console.error('Error detallado en el motor:', error);
    return res.status(500).json({ error: 'Falla interna del servidor', detalle: error.message });
  }
};
