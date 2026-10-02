const form = document.querySelector("#composer");
const input = document.querySelector("#input");
const send = document.querySelector("#send");
const messagesEl = document.querySelector("#messages");

const messages = [];

function renderMessage(role, content) {
  const article = document.createElement("article");
  article.className = `message ${role}`;

  const label = document.createElement("div");
  label.className = "label";
  label.textContent = role === "assistant" ? "Creative Director" : "You";

  const body = document.createElement("pre");
  body.textContent = content;

  article.append(label, body);
  messagesEl.append(article);
  article.scrollIntoView({ behavior: "smooth", block: "end" });
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();

  const text = input.value.trim();
  if (!text) return;

  messages.push({ role: "user", content: text });
  renderMessage("user", text);
  input.value = "";
  send.disabled = true;
  send.textContent = "Working…";

  try {
    const response = await fetch("/api/creative-director", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages })
    });

    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.error || "Request failed.");
    }

    const answer = data.text || "";
    messages.push({ role: "assistant", content: answer });
    renderMessage("assistant", answer);
  } catch (error) {
    renderMessage(
      "assistant",
      `Error: ${error instanceof Error ? error.message : String(error)}`
    );
  } finally {
    send.disabled = false;
    send.textContent = "Send";
    input.focus();
  }
});
