import express from "express";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

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
        const content = await fs.readFile(resolved, "utf8");
        return { path: cleaned, content };
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
const groqReadFilesTool = {
  type: "function",
  function: {
    name: "read_creative_director_files",
    description:
      "Read one or more files from the installed Creative Director skill. Paths are relative to the creative-director directory. Use this whenever SKILL.md tells you to load/open a [[wikilink]] or inspect case-library files.",
    parameters: {
      type: "object",
      properties: {
        paths: {
          type: "array",
          description:
            "1-20 relative file paths, for example references/insight-mining.md or references/legendary-campaigns/cards/C001.md.",
          items: { type: "string" }
        }
      },
      required: ["paths"]
    }
  }
};

async function runGroq({ apiKey, model, systemInstruction, messages }) {
  const groqMessages = [
    { role: "system", content: systemInstruction },
    ...messages.map((message) => ({
      role: message.role === "assistant" ? "assistant" : "user",
      content: String(message.content ?? "")
    }))
  ];

  const maxToolRounds = 24;

  for (let round = 0; round <= maxToolRounds; round += 1) {
    const response = await fetch(
      "https://api.groq.com/openai/v1/chat/completions",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          model,
          messages: groqMessages,
          tools: [groqReadFilesTool],
          tool_choice: "auto"
        })
      }
    );

    const data = await response.json();

    if (!response.ok) {
      const error = new Error(
        data?.error?.message || `Groq request failed with status ${response.status}.`
      );
      error.status = response.status;
      throw error;
    }

    const message = data?.choices?.[0]?.message;
    if (!message) {
      throw new Error("Groq returned no message.");
    }

    const toolCalls = Array.isArray(message.tool_calls)
      ? message.tool_calls
      : [];

    if (toolCalls.length === 0) {
      return message.content ?? "";
    }

    if (round === maxToolRounds) {
      throw new Error(
        "Creative Director exceeded the maximum file-reading rounds."
      );
    }

    groqMessages.push(message);

    for (const call of toolCalls) {
      let result;

      if (call?.function?.name !== "read_creative_director_files") {
        result = { error: "Unknown function." };
      } else {
        try {
          const args = JSON.parse(call.function.arguments || "{}");
          result = await readCreativeDirectorFiles(args.paths);
        } catch (error) {
          result = {
            error: error instanceof Error ? error.message : String(error)
          };
        }
      }

      groqMessages.push({
        role: "tool",
        tool_call_id: call.id,
        name: call.function.name,
        content: JSON.stringify(result)
      });
    }
  }

  throw new Error("Creative Director did not produce a final response.");
}

app.post("/api/creative-director", async (req, res) => {
  try {
    const messages = Array.isArray(req.body?.messages) ? req.body.messages : [];
    if (messages.length === 0) {
      return res.status(400).json({ error: "messages is required." });
    }

    const apiKey = process.env.GROQ_API_KEY;
    if (!apiKey) {
      return res.status(500).json({ error: "GROQ_API_KEY is not configured." });
    }

    const skill = await fs.readFile(SKILL_PATH, "utf8");
    const systemInstruction =
      skill +
      "\n\nRuntime file access: when the skill instructs you to load/open a [[wikilink]] or inspect a referenced case, use read_creative_director_files. Paths are relative to the creative-director directory. Do not assume file contents you have not read.";

    const text = await runGroq({
      apiKey,
      model: "openai/gpt-oss-120b",
      systemInstruction,
      messages
    });

    return res.json({ text });
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
app.listen(port, () => {
  console.log(`Creative Director app listening on port ${port}`);
});
