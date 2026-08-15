const OPENING_CONTEXT_MAX_AGE_MS = 30000;
const OPENING_CONTEXT_MIN_CHARS = 12;

function cleanOpeningText(value) {
  return String(value || "")
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function extractOpeningContext(message) {
  if (!message) return "";

  const parts = [];
  const content = cleanOpeningText(message.content);
  if (content) parts.push(content);

  for (const embed of message.embeds || []) {
    const title = cleanOpeningText(embed?.title);
    const description = cleanOpeningText(embed?.description);
    if (title) parts.push(title);
    if (description) parts.push(description);

    for (const field of embed?.fields || []) {
      const name = cleanOpeningText(field?.name);
      const value = cleanOpeningText(field?.value);
      if (name && value) parts.push(`${name}: ${value}`);
      else if (value) parts.push(value);
    }
  }

  return cleanOpeningText(parts.join("\n")).slice(0, 4000);
}

function isExternalOpeningCandidate(message, clientUserId) {
  if (!message?.guild || !message.channel) return false;
  if (message.author?.id && message.author.id === clientUserId) return false;
  if (!message.author?.bot && !message.webhookId) return false;
  return extractOpeningContext(message).length >= OPENING_CONTEXT_MIN_CHARS;
}

function isWithinOpeningWindow(message, ticket, now = Date.now()) {
  const ticketCreatedAt = ticket?.createdAt ? new Date(ticket.createdAt).getTime() : NaN;
  const messageCreatedAt = Number(message?.createdTimestamp || 0);
  const reference = Number.isFinite(ticketCreatedAt) ? ticketCreatedAt : messageCreatedAt;
  if (!reference) return true;
  return Math.abs(now - reference) <= OPENING_CONTEXT_MAX_AGE_MS;
}

module.exports = {
  OPENING_CONTEXT_MAX_AGE_MS,
  OPENING_CONTEXT_MIN_CHARS,
  cleanOpeningText,
  extractOpeningContext,
  isExternalOpeningCandidate,
  isWithinOpeningWindow,
};
