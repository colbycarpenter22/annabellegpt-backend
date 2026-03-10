import express from "express";
import cors from "cors";
import OpenAI from "openai";

const app = express();
app.use(cors());
app.use(express.json({ limit: "2mb" }));

const PORT = process.env.PORT || 3000;

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// ---------- Helpers ----------

function getLastUserMessage(messages = []) {
  const reversed = [...messages].reverse();
  return reversed.find((m) => m.role === "user")?.content || "";
}

function inferWeatherLocation(userMessage, fallbackLocation) {
  const lower = userMessage.toLowerCase();

  // very simple location extraction fallback
  // if the app sends ranchLocation, use that first
  if (fallbackLocation && fallbackLocation.trim()) return fallbackLocation.trim();

  // naive patterns
  const weatherMatch =
    userMessage.match(/in ([A-Za-z\s,]+)$/i) ||
    userMessage.match(/for ([A-Za-z\s,]+)$/i) ||
    userMessage.match(/at ([A-Za-z\s,]+)$/i);

  if (weatherMatch?.[1]) return weatherMatch[1].trim();

  return "Jackson, WY";
}

async function getWeather(location) {
  const apiKey = process.env.WEATHERAPI_KEY;
  if (!apiKey) {
    throw new Error("Missing WEATHERAPI_KEY");
  }

  const url = `https://api.weatherapi.com/v1/forecast.json?key=${apiKey}&q=${encodeURIComponent(
    location
  )}&days=2&aqi=no&alerts=yes`;

  const res = await fetch(url);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Weather API error: ${text}`);
  }

  const data = await res.json();

  const today = data.forecast?.forecastday?.[0];
  const tomorrow = data.forecast?.forecastday?.[1];

  return {
    location: `${data.location?.name}, ${data.location?.region || data.location?.country}`,
    local_time: data.location?.localtime,
    current: {
      temp_f: data.current?.temp_f,
      feelslike_f: data.current?.feelslike_f,
      wind_mph: data.current?.wind_mph,
      gust_mph: data.current?.gust_mph,
      wind_dir: data.current?.wind_dir,
      humidity: data.current?.humidity,
      precip_in: data.current?.precip_in,
      condition: data.current?.condition?.text,
    },
    today: today
      ? {
          max_f: today.day?.maxtemp_f,
          min_f: today.day?.mintemp_f,
          daily_chance_of_rain: today.day?.daily_chance_of_rain,
          daily_chance_of_snow: today.day?.daily_chance_of_snow,
          total_precip_in: today.day?.totalprecip_in,
          condition: today.day?.condition?.text,
        }
      : null,
    tomorrow: tomorrow
      ? {
          max_f: tomorrow.day?.maxtemp_f,
          min_f: tomorrow.day?.mintemp_f,
          daily_chance_of_rain: tomorrow.day?.daily_chance_of_rain,
          daily_chance_of_snow: tomorrow.day?.daily_chance_of_snow,
          total_precip_in: tomorrow.day?.totalprecip_in,
          condition: tomorrow.day?.condition?.text,
        }
      : null,
    alerts:
      data.alerts?.alert?.map((a) => ({
        headline: a.headline,
        severity: a.severity,
        event: a.event,
        desc: a.desc,
      })) || [],
  };
}

async function webSearch(query) {
  // You can swap this with Tavily, SerpAPI, Brave Search, Exa, etc.
  // Example below uses Tavily.
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

// ---------- Tool Definitions ----------

const tools = [
  {
    type: "function",
    function: {
      name: "get_weather",
      description:
        "Get live current weather and short forecast for a ranch or location. Use this for weather, wind, snow, rain, storms, temperature, or forecast questions.",
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
        "Search the live internet for current information like news, regulations, market info, current events, or anything that may have changed recently.",
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
- prices
- markets
- regulations
- current events
- schedules
- internet information

If a tool is needed, use it before answering.
If no live data is needed, answer directly.
If live data is unavailable, say that clearly.
When weather is relevant, make the answer practical for ranch operations.`;

    const chatMessages = [
      { role: "system", content: baseSystemPrompt },
      ...messages.map((m) => ({
        role: m.role,
        content: m.text || m.content || "",
      })),
    ];

    // First call: let model decide if it wants tools
    const firstResponse = await openai.chat.completions.create({
      model,
      messages: chatMessages,
      tools,
      tool_choice: "auto",
      temperature: 0.4,
    });

    const assistantMessage = firstResponse.choices[0].message;

    if (!assistantMessage.tool_calls || assistantMessage.tool_calls.length === 0) {
      return res.json({
        reply: assistantMessage.content || "No response returned.",
      });
    }

    const toolResults = [];

    for (const toolCall of assistantMessage.tool_calls) {
      const functionName = toolCall.function.name;
      const args = JSON.parse(toolCall.function.arguments || "{}");

      if (functionName === "get_weather") {
        const location =
          args.location?.trim() ||
          inferWeatherLocation(lastUserMessage, ranchLocation);

        const weather = await getWeather(location);

        toolResults.push({
          tool_call_id: toolCall.id,
          role: "tool",
          name: "get_weather",
          content: JSON.stringify(weather),
        });
      }

      if (functionName === "web_search") {
        const query = args.query?.trim() || lastUserMessage;
        const results = await webSearch(query);

        toolResults.push({
          tool_call_id: toolCall.id,
          role: "tool",
          name: "web_search",
          content: JSON.stringify(results),
        });
      }
    }

    // Second call: let model answer using tool results
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
      secondResponse.choices[0].message.content || "No response returned.";

    return res.json({ reply: finalReply });
  } catch (error) {
    console.error("Chat error:", error);
    return res.status(500).json({
      error: true,
      message: error.message || "Server error",
    });
  }
});

app.get("/", (_req, res) => {
  res.send("AnnabelleAI backend is running.");
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
