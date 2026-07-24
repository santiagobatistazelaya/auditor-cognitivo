const { GoogleGenerativeAI } = require("@google/generative-ai");

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Método no permitido' });
  }

  try {
    if (!process.env.GEMINI_API_KEY) {
      return res.status(500).json({ error: "Falta configurar la API Key en Vercel" });
    }

    const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
    const { texto } = req.body;

    if (!texto) {
      return res.status(400).json({ error: 'El texto es requerido' });
    }

    const model = genAI.getGenerativeModel({
        model: "gemini-1.5-flash",
        generationConfig: {
            responseMimeType: "application/json",
        }
    });

    const promptMaestro = `Eres un Auditor Cognitivo avanzado, experto en analizar copys publicitarios utilizando marcos teóricos de la psicología cognitiva.
    Tarea: Analiza el siguiente texto publicitario y evalúa su rendimiento.
    Tu respuesta debe ser ÚNICAMENTE un objeto JSON válido, sin texto adicional ni explicaciones.

    Formato de Salida Requerido (JSON):
    {
      "grafico_cartesiano": {
        "inicio": 7,
        "desarrollo": 6,
        "cierre": 8
      },
      "grafico_radial": {
        "emociones_universales": 7,
        "reaccion_afectiva": 8,
        "motivacion_intrinseca": 6,
        "teoria_de_la_mente": 7,
        "claridad": 9
      },
      "diagnostico_general": "Texto breve con el feedback y justificación...",
      "test_ab": {
        "opcion_a": "Texto reescrito priorizando reacción afectiva.",
        "opcion_b": "Texto reescrito priorizando motivación intrínseca."
      }
    }

    Texto a analizar:
    "${texto}"`;

    const result = await model.generateContent(promptMaestro);
    const responseText = result.response.text();

    const jsonResponse = JSON.parse(responseText);
    return res.status(200).json(jsonResponse);

  } catch (error) {
    console.error('Error detallado en el motor:', error);
    return res.status(500).json({ error: 'Falla interna del servidor', detalle: error.message });
  }
};
