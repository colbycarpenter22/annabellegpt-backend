import express from "express";
import cors from "cors";
import dotenv from "dotenv";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 10000;

app.use(cors());
app.use(express.json({ limit: "2mb" }));

app.get("/", (_req, res) => {
  res.json({
    success: true,
    message: "AnnabelleAI backend is running"
  });
});

app.get("/health", (_req, res) => {
  res.json({
    success: true,
    status: "ok"
  });
});

// ---------- Market ----------

app.get("/market", async (_req, res) => {
  try {
    const apiKey = process.env.COMMODITIES_API_KEY;

    if (!apiKey) {
      return res.status(500).json({
        success: false,
        message: "Missing COMMODITIES_API_KEY"
      });
    }

    const url =
      `https://commodities-api.com/api/latest` +
      `?access_key=${apiKey}&base=USD&symbols=GF,LCAT`;

    const response = await fetch(url);
    const data = await response.json();

    console.log("Market API response:", data);

    if (!response.ok || data.error) {
      return res.status(500).json({
        success: false,
        message: data.message || "Commodities API request failed",
        raw: data
      });
    }

    const rates = data.data?.rates || data.rates || {};
    const base = data.data?.base || data.base || "USD";
    const date = data.data?.date || data.date || null;

    return res.json({
      success: true,
      base,
      date,
      cattle: {
        feederCattle: rates.GF ?? null,
        liveCattle: rates.LCAT ?? null
      }
    });
  } catch (error) {
    console.error("Market route error:", error);

    return res.status(500).json({
      success: false,
      message: error.message || "Unknown server error"
    });
  }
});

// ---------- Weather ----------

app.get("/weather", async (req, res) => {
  try {
    const weatherApiKey = process.env.WEATHER_API_KEY;

    if (!weatherApiKey) {
      return res.status(500).json({
        success: false,
        message: "Missing WEATHER_API_KEY"
      });
    }

    const location = (req.query.location || "Jackson, WY").toString().trim();

    const url = new URL("https://api.weatherapi.com/v1/current.json");
    url.searchParams.set("key", weatherApiKey);
    url.searchParams.set("q", location);
    url.searchParams.set("aqi", "no");

    const response = await fetch(url);
    const data = await response.json();

    console.log("Weather API response:", data);

    if (!response.ok || data.error) {
      return res.status(500).json({
        success: false,
        message: data?.error?.message || "Weather API request failed",
        raw: data
      });
    }

    return res.json({
      success: true,
      location: `${data.location?.name ?? location}${data.location?.region ? ", " + data.location.region : ""}`,
      temperature: data.current?.temp_f ?? null,
      condition: data.current?.condition?.text ?? "Unavailable",
      wind: data.current?.wind_mph ?? null,
      updatedAt: data.location?.localtime ?? ""
    });
  } catch (error) {
    console.error("Weather route error:", error);

    return res.status(500).json({
      success: false,
      message: error.message || "Unknown server error"
    });
  }
});

// ---------- Chat ----------

app.post("/chat", async (req, res) => {
  try {
    const openaiApiKey = process.env.OPENAI_API_KEY;

    if (!openaiApiKey) {
      return res.status(500).json({
        success: false,
        message: "Missing OPENAI_API_KEY"
      });
    }

    const incomingMessages = Array.isArray(req.body?.messages) ? req.body.messages : [];
    const systemPrompt =
      typeof req.body?.systemPrompt === "string" && req.body.systemPrompt.trim().length > 0
        ? req.body.systemPrompt.trim()
        : "You are AnnabelleAI, a helpful ranch, cattle, hay, grazing, calving, and agriculture assistant. Be concise, practical, and useful.";

    const messages = [
      { role: "system", content: systemPrompt },
      ...incomingMessages.map((msg) => ({
        role: msg.role,
        content: msg.content
      }))
    ];

    const openAIResponse = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${openaiApiKey}`
      },
      body: JSON.stringify({
        model: req.body?.model || "gpt-4o-mini",
        messages,
        temperature: 0.7
      })
    });

    const data = await openAIResponse.json();

    if (!openAIResponse.ok) {
      console.error("OpenAI error:", data);
      return res.status(500).json({
        success: false,
        message: data?.error?.message || "OpenAI request failed",
        raw: data
      });
    }

    const reply =
      data?.choices?.[0]?.message?.content ||
      "Sorry, I could not generate a response.";

    return res.json({
      success: true,
      reply
    });
  } catch (error) {
    console.error("Chat route error:", error);

    return res.status(500).json({
      success: false,
      message: error.message || "Unknown server error"
    });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});