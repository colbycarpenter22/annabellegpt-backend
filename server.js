require("dotenv").config()

const express = require("express")
const cors = require("cors")
const OpenAI = require("openai")

const app = express()
const port = process.env.PORT || 3000

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
})

app.use(cors())
app.use(express.json())

app.get("/", (req, res) => {
  res.json({ message: "Annabelle backend running" })
})

app.post("/chat", async (req, res) => {
  try {
    const { systemPrompt, model, messages } = req.body

    if (!Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: "Messages are required" })
    }

    const finalMessages = [
      {
        role: "system",
        content: systemPrompt || "You are Annabelle GPT, a practical ranching AI assistant."
      },
      ...messages.map((message) => ({
        role: message.role,
        content: message.content
      }))
    ]

    const response = await openai.chat.completions.create({
      model: model || "gpt-4o-mini",
      messages: finalMessages
    })

    res.json({
      reply: response.choices[0].message.content
    })
  } catch (error) {
    console.error("CHAT ERROR:")
    console.error(error)

    res.status(500).json({
      error: "Server error",
      details: error.message
    })
  }
})

app.listen(port, () => {
  console.log(`Server running on http://localhost:${port}`)
})
