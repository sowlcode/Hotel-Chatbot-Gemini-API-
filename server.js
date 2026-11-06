const express = require("express");
const fs = require("fs");
const path = require("path");
require("dotenv").config();

const app = express();

const PORT = Number(process.env.PORT) || 3000;
const API_KEY = process.env.GEMINI_API_KEY;
const MODEL = process.env.GEMINI_MODEL || "gemini-3.8-flash";
const TEMPERATURE = Number(process.env.GEMINI_TEMP ?? 1);

const SYSTEM_PROMPT_PATH = path.join(__dirname, "system-prompt.txt");

const SYSTEM_PROMPT = fs.existsSync(SYSTEM_PROMPT_PATH)
    ? fs.readFileSync(SYSTEM_PROMPT_PATH, "utf8").trim()
    : "";

app.disable("x-powered-by");

app.use(express.json({ limit: "1mb" }));

app.use((req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Referrer-Policy", "no-referrer");
    next();
});

// --------------------------------------------------
// HOME PAGE
// --------------------------------------------------

app.get("/", (req, res) => {
    res.sendFile(path.join(__dirname, "index.html"));
});

// --------------------------------------------------
// CHAT API
// --------------------------------------------------

app.post("/api/chat", async (req, res) => {
    if (!API_KEY) {
        return res.status(500).json({
            error: "Gemini API key is missing. Configure GEMINI_API_KEY in .env."
        });
    }

    const { history } = req.body || {};

    if (!Array.isArray(history) || history.length === 0) {
        return res.status(400).json({
            error: "Conversation history is required."
        });
    }

    if (history.length > 40) {
        return res.status(400).json({
            error: "Conversation is too long. Start a new chat."
        });
    }

    // Only accept user/model text messages.
    const contents = [];

    for (const message of history) {
        if (
            !message ||
            !["user", "model"].includes(message.role) ||
            !Array.isArray(message.parts)
        ) {
            return res.status(400).json({
                error: "Invalid conversation format."
            });
        }

        const text = message.parts
            .filter(part => part && typeof part.text === "string")
            .map(part => part.text)
            .join("");

        if (!text.trim() || text.length > 30000) {
            return res.status(400).json({
                error: "Invalid or oversized message."
            });
        }

        contents.push({
            role: message.role,
            parts: [{ text }]
        });
    }

    if (contents[contents.length - 1].role !== "user") {
        return res.status(400).json({
            error: "The latest message must be from the user."
        });
    }

    const body = {
        contents,
        generationConfig: {
            temperature: Number.isFinite(TEMPERATURE)
                ? Math.min(2, Math.max(0, TEMPERATURE))
                : 1
        }
    };

    if (SYSTEM_PROMPT) {
        body.systemInstruction = {
            parts: [{ text: SYSTEM_PROMPT }]
        };
    }

    const url =
        `https://generativelanguage.googleapis.com/v1beta/models/` +
        `${encodeURIComponent(MODEL)}:streamGenerateContent?alt=sse`;

    const controller = new AbortController();

    // Stop the upstream request if the browser disconnects.
    res.on("close", () => {
        if (!res.writableEnded) {
            controller.abort();
        }
    });

    try {
        const geminiResponse = await fetch(url, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "x-goog-api-key": API_KEY
            },
            body: JSON.stringify(body),
            signal: controller.signal
        });

        if (!geminiResponse.ok) {
            let errorMessage = `Gemini API error: ${geminiResponse.status}`;

            try {
                const errorData = await geminiResponse.json();

                if (errorData.error?.message) {
                    errorMessage = errorData.error.message;
                }
            } catch {
                // Keep the original error message.
            }

            return res.status(geminiResponse.status).json({
                error: errorMessage
            });
        }

        if (!geminiResponse.body) {
            return res.status(502).json({
                error: "Gemini returned an empty response stream."
            });
        }

        res.status(200);

        res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
        res.setHeader("Cache-Control", "no-cache, no-transform");
        res.setHeader("Connection", "keep-alive");
        res.setHeader("X-Accel-Buffering", "no");

        const reader = geminiResponse.body.getReader();

        try {
            while (true) {
                const { done, value } = await reader.read();

                if (done) break;

                if (res.destroyed || controller.signal.aborted) {
                    break;
                }

                res.write(Buffer.from(value));
            }
        } finally {
            reader.releaseLock();
        }

        if (!res.destroyed) {
            res.end();
        }

    } catch (error) {
        if (error.name === "AbortError") {
            return;
        }

        console.error("Gemini error:", error);

        if (!res.headersSent && !res.destroyed) {
            res.status(500).json({
                error: "Unable to connect to Gemini. Please try again."
            });
        } else if (!res.destroyed) {
            res.end();
        }
    }
});

// --------------------------------------------------
// START SERVER
// --------------------------------------------------

app.listen(PORT, () => {
    console.log("----------------------------------");
    console.log("       GEMINI CHAT SERVER");
    console.log("----------------------------------");
    console.log(`URL: http://localhost:${PORT}`);
    console.log(`Model: ${MODEL}`);
    console.log(`System prompt: ${SYSTEM_PROMPT ? "Loaded" : "Not configured"}`);
    console.log("----------------------------------");
});