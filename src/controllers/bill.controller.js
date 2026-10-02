import openai from "../config/openai.js";
import Board from "../models/Board.js";

export const extractElectricityRates = async (req, res) => {
  try {
    const { boardId } = req.params;
    const file = req.file;

    if (!file || !file.buffer) {
      return res.status(400).json({ 
        error: "Debes adjuntar una imagen del recibo de luz." 
      });
    }

    const mime = file.mimetype || "image/jpeg";
    if (!mime.startsWith("image/")) {
      return res.status(400).json({
        error: "Formato no compatible. Por favor sube una imagen (JPG, PNG o WEBP) de tu recibo de luz."
      });
    }

    const base64Data = `data:${mime};base64,${file.buffer.toString("base64")}`;

    const prompt = `Analiza este recibo de servicio eléctrico (Luz del Sur / Enel / etc.).
1. En "DETALLE DE LOS IMPORTES FACTURADOS", ubica el "Precio Unitario" para:
   - "Consumo de Energía Hora Punta" (tarifaHP)
   - "Consumo de Energía Fuera Punta" (tarifaFP)
2. En la sección de "HISTORIAL DE CONSUMOS" o "EVOLUCIÓN DEL CONSUMO" (los meses facturados anteriores):
   - Extrae la lista histórica disponible de meses/periodos facturados con su costo o consumo.
   - Si se desglosan importes de Hora Punta y Fuera Punta por mes o el total facturado, extráelos. Si solo figura el importe total o kWh, calcúlalos o asígnalos proporcionalmente.

Devuelve ÚNICAMENTE un objeto JSON estrictamente válido con este formato:
{
  "tarifaHP": 0.3095,
  "tarifaFP": 0.2616,
  "history": [
    {
      "period": "Oct 25",
      "costoFP": 2150.40,
      "costoHP": 950.20,
      "costoTotal": 3100.60
    },
    {
      "period": "Nov 25",
      "costoFP": 2300.10,
      "costoHP": 1020.50,
      "costoTotal": 3320.60
    }
  ]
}

Si no se aprecian datos históricos en la imagen, genera el mes actual facturado en "history". Si la imagen no es un recibo legible, devuelve valores nulos.`;

    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: prompt },
            { 
              type: "image_url", 
              image_url: { 
                url: base64Data, 
                detail: "high" 
              } 
            },
          ],
        },
      ],
      response_format: { type: "json_object" },
      temperature: 0.1,
    });

    const parsed = JSON.parse(response.choices[0]?.message?.content || "{}");

    const tarifaHP = parsed.tarifaHP != null ? Number(parsed.tarifaHP) : null;
    const tarifaFP = parsed.tarifaFP != null ? Number(parsed.tarifaFP) : null;
    const history = Array.isArray(parsed.history) ? parsed.history : [];

    if (!tarifaHP || !tarifaFP || isNaN(tarifaHP) || isNaN(tarifaFP)) {
      return res.status(422).json({
        error: "No se pudieron extraer los datos del recibo. Asegúrate de que los importes facturados sean legibles."
      });
    }

    // Persistir tarifas e historial en el Tablero
    if (boardId) {
      await Board.findByIdAndUpdate(boardId, {
        $set: {
          "energyRates.tarifaHP": tarifaHP,
          "energyRates.tarifaFP": tarifaFP,
          "energyRates.history": history,
          "energyRates.updatedAt": new Date(),
        },
      });
    }

    return res.status(200).json({
      success: true,
      message: "Recibo analizado y guardado exitosamente.",
      data: {
        tarifaHP,
        tarifaFP,
        history,
      },
    });
  } catch (error) {
    console.error("Error al procesar recibo en OpenAI:", error);
    return res.status(500).json({ 
      error: "Error interno al analizar el recibo de luz: " + error.message 
    });
  }
};