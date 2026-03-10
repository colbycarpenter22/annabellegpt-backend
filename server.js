import express from "express";
import cors from "cors";
import OpenAI from "openai";
import fetch from "node-fetch";

const app = express();
app.use(cors());
app.use(express.json({ limit: "2mb" }));

const PORT = process.env.PORT || 10000;

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// ---------- Helpers ----------

function getLastUserMessage(messages = []) {
  const reversed = [...messages].reverse();
  const msg = reversed.find((m) => m.role === "user");
  return msg?.content || msg?.text || "";
}

function safeTrim(value) {
  return typeof value === "string" ? value.trim() : "";
}

function inferWeatherLocation(userMessage, fallbackLocation) {
  const fallback = safeTrim(fallbackLocation);
  if (fallback) return fallback;

  const match =
    userMessage.match(/\bin\s+([A-Za-z0-9\s,.-]+)$/i) ||
    userMessage.match(/\bfor\s+([A-Za-z0-9\s,.-]+)$/i) ||
    userMessage.match(/\bat\s+([A-Za-z0-9\s,.-]+)$/i);

  if (match?.[1]) return match[1].trim();

  return "Jackson, WY";
}

// ---------- Geocoding + NOAA Alerts ----------

async function geocodeLocation(location) {
  const apiKey = process.env.WEATHERAPI_KEY;
  if (!apiKey) {
    throw new Error("Missing WEATHERAPI_KEY");
  }

  const url = `https://api.weatherapi.com/v1/search.json?key=${apiKey}&q=${encodeURIComponent(location)}`;
  const res = await fetch(url);

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`WeatherAPI geocoding error: ${text}`);
  }

  const data = await res.json();

  if (!Array.isArray(data) || data.length === 0) {
    throw new Error(`Location not found: ${location}`);
  }

  const place = data[0];

  return {
    name: place.name,
    region: place.region || "",
    country: place.country || "",
    lat: place.lat,
    lon: place.lon,
  };
}

async function getNOAAAlerts(lat, lon) {
  const url = `https://api.weather.gov/alerts/active?point=${lat},${lon}`;

  const res = await fetch(url, {
    headers: {
      "User-Agent": "AnnabelleAI/1.0",
      "Accept": "application/geo+json",
    },
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`NOAA alerts lookup failed: ${text}`);
  }

  const data = await res.json();

  return (data.features || []).map((a) => ({
    event: a.properties?.event || "",
    severity: a.properties?.severity || "",
    headline: a.properties?.headline || "",
    description: a.properties?.description || "",
    instruction: a.properties?.instruction || "",
  }));
}

// ---------- Weather ----------

async function getWeather(location) {
  const apiKey = process.env.WEATHERAPI_KEY;
  if (!apiKey) {
    throw new Error("Missing WEATHERAPI_KEY");
  }

  const forecastUrl =
    `https://api.weatherapi.com/v1/forecast.json?key=${apiKey}&q=${encodeURIComponent(location)}&days=3&aqi=no&alerts=yes`;

  const res = await fetch(forecastUrl);

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Weather API error: ${text}`);
  }

  const data = await res.json();

  const today = data.forecast?.forecastday?.[0] || null;
  const tomorrow = data.forecast?.forecastday?.[1] || null;

  let noaaAlerts = [];
  try {
    const geo = await geocodeLocation(location);
    noaaAlerts = await getNOAAAlerts(geo.lat, geo.lon);
  } catch (error) {
    noaaAlerts = [
      {
        event: "NOAA Alerts Unavailable",
        severity: "Unknown",
        headline: error.message || "NOAA alerts unavailable",
        description: "",
        instruction: "",
      },
    ];
  }

  return {
    location: `${data.location?.name || ""}, ${data.location?.region || data.location?.country || ""}`.trim(),
    coordinates: {
      lat: data.location?.lat,
      lon: data.location?.lon,
    },
    local_time: data.location?.localtime || "",
    current: {
      temp_f: data.current?.temp_f,
      feelslike_f: data.current?.feelslike_f,
      humidity: data.current?.humidity,
      wind_mph: data.current?.wind_mph,
      gust_mph: data.current?.gust_mph,
      wind_dir: data.current?.wind_dir,
      precip_in: data.current?.precip_in,
      condition: data.current?.condition?.text || "",
      is_day: data.current?.is_day,
    },
    today: today
      ? {
          date: today.date,
          max_f: today.day?.maxtemp_f,
          min_f: today.day?.mintemp_f,
          avg_f: today.day?.avgtemp_f,
          chance_of_rain: today.day?.daily_chance_of_rain,
          chance_of_snow: today.day?.daily_chance_of_snow,
          total_precip_in: today.day?.totalprecip_in,
          max_wind_mph: today.day?.maxwind_mph,
          condition: today.day?.condition?.text || "",
        }
      : null,
    tomorrow: tomorrow
      ? {
          date: tomorrow.date,
          max_f: tomorrow.day?.maxtemp_f,
          min_f: tomorrow.day?.mintemp_f,
          avg_f: tomorrow.day?.avgtemp_f,
          chance_of_rain: tomorrow.day?.daily_chance_of_rain,
          chance_of_snow: tomorrow.day?.daily_chance_of_snow,
          total_precip_in: tomorrow.day?.totalprecip_in,
          max_wind_mph: tomorrow.day?.maxwind_mph,
          condition: tomorrow.day?.condition?.text || "",
        }
      : null,
    weatherapi_alerts: (data.alerts?.alert || []).map((a) => ({
      headline: a.headline || "",
      severity: a.severity || "",
      event: a.event || "",
      areas: a.areas || "",
      desc: a.desc || "",
      instruction: a.instruction || "",
    })),
    noaa_alerts: noaaAlerts,
  };
}

// ---------- Web Search ----------

async function webSearch(query) {
  const apiKey = process.env.TAVILY_API_KEY;
  if (!apiKey) {
    throw new Error("Missing TAVILY_API_KEY");
  }

  const res = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      api_key: apiKey,
      query,
      search_depth: "advanced",
      include_answer: true,
      max_results: 5,
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Web search error: ${text}`);
  }

  const data = await res.json();

  return {
    query,
    answer: data.answer || "",
    results: (data.results || []).map((r) => ({
      title: r.title,
      url: r.url,
      content: r.content,
    })),
  };
}

// ---------- Tools ----------

const tools = [
  {
    type: "function",
    function: {
      name: "get_weather",
      description:
        "Get live weather, forecast, wind, precipitation, snow, and severe weather alerts for a ranch or location. Use this for weather questions and also for operational ranch questions where current weather affects herd, hay, calving, grazing, travel, mud, freeze risk, storm prep, or daily priorities.",
      parameters: {
        type: "object",
        properties: {
          location: {
            type: "string",
            description: "City, state, ZIP code, or ranch location.",
          },
        },
        required: ["location"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "web_search",
      description:
        "Search the live internet for current information such as market news, regulations, livestock news, hay prices, schedules, breaking events, or anything that may have changed recently.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "The search query to run on the internet.",
          },
        },
        required: ["query"],
      },
    },
  },
];

// ---------- Main Chat Endpoint ----------

app.post("/chat", async (req, res) => {
  try {
    const {
      messages = [],
      model = "gpt-4.1-mini",
      ranchLocation = "",
      systemPrompt,
    } = req.body;

    const lastUserMessage = getLastUserMessage(messages);

    const baseSystemPrompt =
      systemPrompt ||
      `You are AnnabelleAI, a practical ranching AI assistant.

Use live tools whenever the question depends on current or changing information such as:
- weather
- forecasts
- wind
- storms
- snow
- heat
- market prices
- regulations
- news
- schedules
- internet information

If a tool is needed, use it before answering.
If no live data is needed, answer directly.
If live data is unavailable, say that clearly.

When weather data is available, interpret it for ranch operations:
- Wind above 25 mph -> mention calves, windbreaks, loose tarps, feeders, fencing
- Wind above 40 mph -> mention high livestock stress and infrastructure risk
- Temperatures below 20F -> mention water tanks, ice, newborn calves, exposure
- Snow or winter precip -> mention staging hay, access, calving cows, shelter
- Heavy rain -> mention mud, drainage, feeding areas, vehicle access
- Temperatures above 90F -> mention heat stress, water needs, shade, cattle movement
- If severe weather alerts exist, mention them clearly and explain practical ranch actions

Be clear, useful, practical, and plain spoken.`;

    const normalizedMessages = messages.map((m) => ({
      role: m.role,
      content: m.content || m.text || "",
    }));

    const chatMessages = [
      { role: "system", content: baseSystemPrompt },
      ...normalizedMessages,
    ];

    const firstResponse = await openai.chat.completions.create({
      model,
      messages: chatMessages,
      tools,
      tool_choice: "auto",
      temperature: 0.4,
    });

    const assistantMessage = firstResponse.choices[0]?.message;

    if (!assistantMessage?.tool_calls || assistantMessage.tool_calls.length === 0) {
      return res.json({
        reply: assistantMessage?.content || "No response returned.",
      });
    }

    const toolResults = [];

    for (const toolCall of assistantMessage.tool_calls) {
      const functionName = toolCall.function.name;
      let args = {};

      try {
        args = JSON.parse(toolCall.function.arguments || "{}");
      } catch {
        args = {};
      }

      if (functionName === "get_weather") {
        try {
          const location =
            safeTrim(args.location) || inferWeatherLocation(lastUserMessage, ranchLocation);

          const weather = await getWeather(location);

          toolResults.push({
            tool_call_id: toolCall.id,
            role: "tool",
            name: "get_weather",
            content: JSON.stringify(weather),
          });
        } catch (err) {
          toolResults.push({
            tool_call_id: toolCall.id,
            role: "tool",
            name: "get_weather",
            content: JSON.stringify({
              error: true,
              message: err.message || "Weather lookup failed",
            }),
          });
        }
      }

      if (functionName === "web_search") {
        try {
          const query = safeTrim(args.query) || lastUserMessage;
          const results = await webSearch(query);

          toolResults.push({
            tool_call_id: toolCall.id,
            role: "tool",
            name: "web_search",
            content: JSON.stringify(results),
          });
        } catch (err) {
          toolResults.push({
            tool_call_id: toolCall.id,
            role: "tool",
            name: "web_search",
            content: JSON.stringify({
              error: true,
              message: err.message || "Web search failed",
            }),
          });
        }
      }
    }

    const secondResponse = await openai.chat.completions.create({
      model,
      messages: [
        ...chatMessages,
        assistantMessage,
        ...toolResults,
      ],
      temperature: 0.4,
    });

    const finalReply =
      secondResponse.choices[0]?.message?.content || "No response returned.";

    return res.json({ reply: finalReply });
  } catch (error) {
    console.error("Chat error:", error);
    console.error("Chat error stack:", error?.stack);
    console.error("Request body:", JSON.stringify(req.body, null, 2));

    return res.status(500).json({
      error: true,
      message: error.message || "Server error",
    });
  }
});

app.get("/", (_req, res) => {
  res.send("AnnabelleAI backend is running.");
});

app.get("/market", async (_req, res) => {
  try {
    // Starter placeholder values
    // Replace later with real CME / USDA / market provider data
    const marketData = {
      updatedAt: new Date().toISOString(),
      feederCattle: {
        label: "Feeder Cattle",
        price: "247.85",
        change: "+2.15"
      },
      liveCattle: {
        label: "Live Cattle",
        price: "189.42",
        change: "+1.08"
      },
      boxedBeef: {
        label: "Boxed Beef Choice",
        price: "312.40",
        change: "-0.56"
      }
    };

    res.json(marketData);
  } catch (error) {
    console.error("Market endpoint error:", error);
    res.status(500).json({
      error: true,
      message: error.message || "Failed to load market data"
    });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
