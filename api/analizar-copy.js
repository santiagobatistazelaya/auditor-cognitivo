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

    const getModelsRes = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`);
    const modelsData = await getModelsRes.json();

    if (!modelsData.models) throw new Error("No se pudo listar los modelos.");

    const validModels = modelsData.models.filter(m => 
      m.supportedGenerationMethods && m.supportedGenerationMethods.includes("generateContent")
    );
    const fallbackModels = validModels.filter(m => 
      !m.name.includes("2.5-flash") && !m.name.includes("1.5-flash") && !m.name.includes("gemini-pro")
    );
    const modelsToTry = fallbackModels.length > 0 ? fallbackModels : validModels;

    const promptMaestro = `Eres un Auditor Cognitivo avanzado, experto en analizar copys publicitarios utilizando marcos teóricos de la psicología cognitiva (Ekman, Zajonc, Teoría de la Mente).
    Analiza el siguiente texto y responde ÚNICAMENTE con un objeto JSON válido, sin texto introductorio.
    {
      "grafico_cartesiano": { "inicio": 7, "desarrollo": 6, "cierre": 8 },
      "grafico_radial": { "emociones_universales": 7, "reaccion_afectiva": 8, "motivacion_intrinseca": 6, "teoria_de_la_mente": 7, "claridad": 9 },
      "diagnostico_general": "Texto breve con feedback...",
      "test_ab": { "opcion_a": "Opción A...", "opcion_b": "Opción B..." }
    }
    Texto a analizar: "${texto}"`;

    const requestBody = { contents: [{ parts: [{ text: promptMaestro }] }] };
    let generateData = null;
    let success = false;

    for (const modelObj of modelsToTry) {
        const finalModelName = modelObj.name.replace('models/', '');
        const generateRes = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${finalModelName}:generateContent?key=${apiKey}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(requestBody)
        });

        generateData = await generateRes.json();
        if (generateRes.ok) {
            success = true;
            break; 
        }
    }

    if (!success) throw new Error("Error de conexión con IA.");

    // EL EXTRACTOR QUIRÚRGICO: Agarramos solo lo que está entre { y }
    const responseText = generateData.candidates[0].content.parts[0].text;
    const startIndex = responseText.indexOf('{');
    const endIndex = responseText.lastIndexOf('}');

    if (startIndex === -1 || endIndex === -1) {
        throw new Error("La IA no devolvió un formato compatible para los gráficos.");
    }

    const cleanJson = responseText.substring(startIndex, endIndex + 1);
    const jsonResponse = JSON.parse(cleanJson);
    
    return res.status(200).json(jsonResponse);

  } catch (error) {
    console.error('Error detallado en el motor:', error);
    return res.status(500).json({ error: 'Falla interna del servidor', detalle: error.message });
  }
};
