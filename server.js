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

async function fetchYahooQuote(symbol) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=5d`;

  const response = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0",
      "Accept": "application/json"
    }
  });

  if (!response.ok) {
    throw new Error(`Yahoo request failed for ${symbol}: ${response.status}`);
  }

  const data = await response.json();
  const result = data?.chart?.result?.[0];
  const meta = result?.meta;

  if (!meta) {
    throw new Error(`No quote data returned for ${symbol}`);
  }

  const price = Number(meta.regularMarketPrice ?? 0);
  const previousClose = Number(meta.previousClose ?? 0);
  const change = price - previousClose;

  return {
    symbol,
    price: Number(price.toFixed(2)),
    previousClose: Number(previousClose.toFixed(2)),
    change: Number(change.toFixed(2)),
    currency: meta.currency ?? "USD",
    exchangeName: meta.exchangeName ?? "",
    marketState: meta.marketState ?? "",
    updatedAt: meta.regularMarketTime
      ? new Date(meta.regularMarketTime * 1000).toISOString()
      : new Date().toISOString()
  };
}

async function getMarketData() {
  const [feeder, live] = await Promise.all([
    fetchYahooQuote("GF=F"), // Feeder Cattle futures
    fetchYahooQuote("LE=F")  // Live Cattle futures
  ]);

  const summary =
    live.change >= feeder.change
      ? "Live cattle are leading today."
      : "Feeder cattle are leading today.";

  return {
    success: true,
    summary,
    feederCattle: feeder.price,
    liveCattle: live.price,
    feederSymbol: "GF=F",
    liveSymbol: "LE=F",
    feederChange: feeder.change,
    liveChange: live.change,
    updatedAt: new Date().toISOString(),
    source: "Yahoo Finance delayed futures",
    cattle: {
      feederCattle: feeder.price,
      liveCattle: live.price,
      feederSymbol: "GF=F",
      liveSymbol: "LE=F",
      feederChange: feeder.change,
      liveChange: live.change
    }
  };
}

app.get("/market", async (_req, res) => {
  try {
    const marketData = await getMarketData();
    return res.json(marketData);
  } catch (error) {
    console.error("Market route error:", error);

    return res.status(500).json({
      success: false,
      message: error.message || "Unknown server error"
    });
  }
});

// ---------- Weather ----------

async function getWeatherData(location = "Jackson, WY") {
  const weatherApiKey = process.env.WEATHERAPI_API_KEY;

  if (!weatherApiKey) {
    throw new Error("Missing WEATHER_API_KEY");
  }

  const url = new URL("https://api.weatherapi.com/v1/current.json");
  url.searchParams.set("key", weatherApiKey);
  url.searchParams.set("q", location);
  url.searchParams.set("aqi", "no");

  const response = await fetch(url);
  const data = await response.json();

  if (!response.ok || data.error) {
    throw new Error(data?.error?.message || "Weather API request failed");
  }

  return {
    success: true,
    location: `${data.location?.name ?? location}${data.location?.region ? ", " + data.location.region : ""}`,
    temperature: data.current?.temp_f ?? null,
    condition: data.current?.condition?.text ?? "Unavailable",
    wind: data.current?.wind_mph ?? null,
    updatedAt: data.location?.localtime ?? ""
  };
}

app.get("/weather", async (req, res) => {
  try {
    const location = (req.query.location || "Jackson, WY").toString().trim();
    const weather = await getWeatherData(location);

    return res.json(weather);
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

    const incomingMessages = Array.isArray(req.body?.messages)
      ? req.body.messages
      : [];

    const location =
      typeof req.body?.location === "string" && req.body.location.trim().length > 0
        ? req.body.location.trim()
        : "Jackson, WY";

    let weatherContext = "";
    let marketContext = "";

    try {
      const weather = await getWeatherData(location);

      if (weather?.success) {
        weatherContext = `
LIVE WEATHER DATA:
Location: ${weather.location}
Temperature: ${weather.temperature}°F
Condition: ${weather.condition}
Wind: ${weather.wind} mph
Updated at: ${weather.updatedAt}
`;
      }
    } catch (error) {
      console.error("Weather context error:", error);
    }

    try {
      const market = await getMarketData();

      if (market?.success) {
        marketContext = `
LIVE CATTLE MARKET DATA:
Feeder Cattle (${market.feederSymbol}): ${market.feederCattle}
Live Cattle (${market.liveSymbol}): ${market.liveCattle}
Feeder daily change: ${market.feederChange}
Live daily change: ${market.liveChange}
Market summary: ${market.summary}
Updated at: ${market.updatedAt}
Source: ${market.source}
`;
      }
    } catch (error) {
      console.error("Market context error:", error);
    }

    const baseSystemPrompt =
      typeof req.body?.systemPrompt === "string" &&
      req.body.systemPrompt.trim().length > 0
        ? req.body.systemPrompt.trim()
        : "You are AnnabelleAI, a practical ranching AI assistant.";

    const systemPrompt = `
${baseSystemPrompt}

You are connected to live backend data.

IMPORTANT RULES:
1. If LIVE WEATHER DATA is included below and the user asks about weather, forecast, rain, snow, wind, temperature, cold, heat, storm, current conditions, or this week’s weather, answer using that weather data.
2. Do not say you cannot access live or current weather data when LIVE WEATHER DATA is included below.
3. If only current weather is available and the user asks for a full-week forecast, clearly say you have current live weather but not a full 7-day forecast in the current backend feed.
4. If the user asks about cattle markets, feeder cattle, live cattle, futures, or cattle prices, answer using LIVE CATTLE MARKET DATA below.
5. Do not say you cannot access current cattle market data when LIVE CATTLE MARKET DATA is included below.
6. Prefer backend-fed data over generic assumptions.

${weatherContext}

${marketContext}
`.trim();

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
        temperature: 0.2
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