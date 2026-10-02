import express from "express";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { GoogleGenAI, Type } from "@google/genai";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CREATIVE_DIRECTOR_ROOT = path.join(
  __dirname,
  "creative-director-skill-main",
  "creative-director"
);
const SKILL_PATH = path.join(CREATIVE_DIRECTOR_ROOT, "SKILL.md");
const PUBLIC_DIR = path.join(__dirname, "public");

const app = express();
app.use(express.json({ limit: "2mb" }));
app.use(express.static(PUBLIC_DIR));

const readFilesDeclaration = {
  name: "read_creative_director_files",
  description:
    "Read files from the installed Creative Director skill when SKILL.md references them.",
  parameters: {
    type: Type.OBJECT,
    properties: {
      paths: {
        type: Type.ARRAY,
        items: { type: Type.STRING }
      }
    },
    required: ["paths"]
  }
};

function normalizeSkillPath(rawPath) {
  if (typeof rawPath !== "string" || !rawPath.trim()) {
    throw new Error("Path must be a non-empty string.");
  }

  let cleaned = rawPath.trim();
  if (cleaned.startsWith("[[") && cleaned.endsWith("]]")) {
    cleaned = cleaned.slice(2, -2);
  }

  cleaned = cleaned.split("#", 1)[0].replaceAll("\\", "/");
  cleaned = cleaned.replace(/^\.\//, "");

  if (!cleaned || path.isAbsolute(cleaned)) {
    throw new Error("Only relative skill paths are allowed.");
  }

  const resolved = path.resolve(CREATIVE_DIRECTOR_ROOT, cleaned);
  const rootWithSep = CREATIVE_DIRECTOR_ROOT.endsWith(path.sep)
    ? CREATIVE_DIRECTOR_ROOT
    : CREATIVE_DIRECTOR_ROOT + path.sep;

  if (resolved !== CREATIVE_DIRECTOR_ROOT && !resolved.startsWith(rootWithSep)) {
    throw new Error("Path is outside the Creative Director skill.");
  }

  return { cleaned, resolved };
}

async function readCreativeDirectorFiles(paths) {
  if (!Array.isArray(paths) || paths.length === 0) {
    return { files: [], error: "No paths supplied." };
  }

  if (paths.length > 20) {
    return { files: [], error: "Read at most 20 files per tool call." };
  }

  const files = await Promise.all(
    paths.map(async (requestedPath) => {
      try {
        const { cleaned, resolved } = normalizeSkillPath(requestedPath);
        const stat = await fs.stat(resolved);
        if (!stat.isFile()) {
          return { path: cleaned, error: "Not a file." };
        }
        return { path: cleaned, content: await fs.readFile(resolved, "utf8") };
      } catch (error) {
        return {
          path: String(requestedPath),
          error: error instanceof Error ? error.message : String(error)
        };
      }
    })
  );

  return { files };
}

function toGeminiContents(messages) {
  return messages.map((message) => ({
    role: message.role === "assistant" ? "model" : "user",
    parts: [{ text: String(message.content ?? "") }]
  }));
}

app.post("/api/creative-director", async (req, res) => {
  try {
    const messages = Array.isArray(req.body?.messages) ? req.body.messages : [];
    if (messages.length === 0) {
      return res.status(400).json({ error: "messages is required." });
    }

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      return res.status(500).json({ error: "GEMINI_API_KEY is not configured." });
    }

    const skill = await fs.readFile(SKILL_PATH, "utf8");
    const systemInstruction =
      skill +
      "\n\nRuntime file access: when SKILL.md tells you to load/open a [[wikilink]] or inspect a referenced case, use read_creative_director_files. Paths are relative to the creative-director directory. Do not assume file contents you have not read." +
      "\n\nOutput contract for this app: apply the Creative Director methodology internally, but for TV promo voice-over requests return only the voice-over variants. Do not show phases, brief, insight, scores, rationale, discarded directions, recommendation, or process notes. Do not ask follow-up questions when the request already gives enough constraints. Return 5 variants by default, each from a clearly different creative angle. If the user explicitly requests a different number, follow it. Preserve the user's word limit.";

    const ai = new GoogleGenAI({ apiKey });
    const contents = toGeminiContents(messages);
    const config = {
      systemInstruction,
      tools: [{ functionDeclarations: [readFilesDeclaration] }]
    };

    for (let round = 0; round < 12; round += 1) {
      const response = await ai.models.generateContent({
        model: "gemini-3.6-flash",
        contents,
        config
      });

      const functionCalls = response.functionCalls ?? [];
      if (functionCalls.length === 0) {
        return res.json({ text: response.text ?? "" });
      }

      const modelContent = response.candidates?.[0]?.content;
      if (!modelContent) {
        throw new Error("Model returned no content.");
      }
      contents.push(modelContent);

      const functionResponses = [];
      for (const call of functionCalls) {
        if (call.name !== "read_creative_director_files") {
          functionResponses.push({
            functionResponse: {
              id: call.id,
              name: call.name,
              response: { error: "Unknown function." }
            }
          });
          continue;
        }

        functionResponses.push({
          functionResponse: {
            id: call.id,
            name: call.name,
            response: await readCreativeDirectorFiles(call.args?.paths)
          }
        });
      }

      contents.push({ role: "user", parts: functionResponses });
    }

    throw new Error("Creative Director exceeded the file-reading limit.");
  } catch (error) {
    console.error(error);
    res.status(500).json({
      error: error instanceof Error ? error.message : String(error)
    });
  }
});

app.get("/{*splat}", (_req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, "index.html"));
});

const port = Number(process.env.PORT || 3000);
app.listen(port, "0.0.0.0", () => {
  console.log(`Creative Director app listening on port ${port}`);
});
