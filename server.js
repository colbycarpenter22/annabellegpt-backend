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

app.get("/weather", async (req, res) => {
  try {
    const weatherApiKey = process.env.WEATHERAPI_API_KEY;

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

// ---------- Chat Helpers ----------

function getLastUserMessage(messages = []) {
  const reversed = [...messages].reverse();
  const lastUser = reversed.find((msg) => msg?.role === "user" && typeof msg?.content === "string");
  return lastUser?.content || "";
}

function messageNeedsMarket(text = "") {
  const t = text.toLowerCase();
  return (
    t.includes("cattle market") ||
    t.includes("market price") ||
    t.includes("market prices") ||
    t.includes("cattle prices") ||
    t.includes("feeder cattle") ||
    t.includes("live cattle") ||
    t.includes("cattle futures") ||
    t.includes("futures") ||
    t.includes("commodity") ||
    t.includes("commodities")
  );
}

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
    let newsContext = "";

    // Always try to get live weather
    try {
      const weather = await getWeatherData(location);

      if (weather?.success) {
        weatherContext = `
LIVE WEATHER DATA (USE THIS IF USER ASKS ABOUT WEATHER):
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

    // Always try to get live market
    try {
      const market = await getMarketData();

      if (market?.success) {
        marketContext = `
LIVE CATTLE MARKET DATA (USE THIS IF USER ASKS ABOUT CATTLE PRICES OR MARKETS):
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

    // Optional: try ag news too
    try {
      const headlines = await fetchAgNews();

      if (Array.isArray(headlines) && headlines.length > 0) {
        newsContext = `
CURRENT AGRICULTURE HEADLINES:
${headlines
  .slice(0, 5)
  .map((item, index) => `${index + 1}. ${item.title} (${item.source})`)
  .join("\n")}
`;
      }
    } catch (error) {
      console.error("Ag news context error:", error);
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
1. If LIVE WEATHER DATA is included below and the user asks about weather, forecast, rain, snow, wind, temperature, cold, heat, storm, or this week’s weather, you MUST answer using that weather data.
2. Do NOT say you cannot access live weather data if LIVE WEATHER DATA is present below.
3. If the user asks about cattle markets, feeder cattle, live cattle, futures, or cattle prices, use the LIVE CATTLE MARKET DATA below.
4. Do NOT say you cannot access current market data if LIVE CATTLE MARKET DATA is present below.
5. If exact forecast data for a full week is not available and only current weather is available, say that clearly. Example: "I have current live weather data for Jackson, but not a full 7-day forecast in the current backend feed."
6. Prefer the backend-fed data over generic model assumptions.
7. Never claim lack of access to live weather or market data when that data is included below.

${weatherContext}

${marketContext}

${newsContext}
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