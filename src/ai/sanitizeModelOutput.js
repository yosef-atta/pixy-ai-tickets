function convertMarkdownTables(text) {
  const lines = String(text || "").replace(/\r\n/g, "\n").split("\n");
  const output = [];
  let inTable = false;
  let headers = [];
  let tableRows = [];

  function flushTable() {
    if (!tableRows.length) {
      inTable = false;
      headers = [];
      tableRows = [];
      return;
    }

    for (const row of tableRows) {
      if (!row.some(Boolean)) continue;
      const primary = row[0];
      const details = [];
      for (let i = 1; i < row.length; i++) {
        const val = row[i];
        if (!val) continue;
        const headerName = headers[i] || "";
        if (headerName) {
          details.push(`  - **${headerName}**: ${val}`);
        } else {
          details.push(`  - ${val}`);
        }
      }
      if (primary) {
        output.push(`- **${primary}**`);
      }
      if (details.length) {
        output.push(...details);
      }
      output.push("");
    }

    inTable = false;
    headers = [];
    tableRows = [];
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    const isTableRow = line.startsWith("|") && line.endsWith("|") && line.split("|").length >= 3;
    const isDivider = isTableRow && /^\|(?:\s*:?-+:?\s*\|)+$/.test(line);

    if (isTableRow) {
      const cells = line
        .slice(1, -1)
        .split("|")
        .map((c) => c.trim().replace(/<br\s*\/?>/gi, "\n    "));

      if (isDivider) {
        inTable = true;
        continue;
      }

      if (!inTable) {
        const nextLine = (lines[i + 1] || "").trim();
        if (nextLine.startsWith("|") && /^\|(?:\s*:?-+:?\s*\|)+$/.test(nextLine)) {
          headers = cells;
          continue;
        }
      }

      tableRows.push(cells);
    } else {
      if (inTable || tableRows.length > 0) {
        flushTable();
      }
      output.push(lines[i]);
    }
  }

  if (inTable || tableRows.length > 0) {
    flushTable();
  }

  return output.join("\n");
}

function sanitizeDiscordMarkdown(value) {
  let text = String(value ?? "");

  // Replace HTML line breaks with newlines
  text = text.replace(/<br\s*\/?>/gi, "\n");

  // Convert markdown pipe tables to clean Discord bulleted lists
  text = convertMarkdownTables(text);

  // Strip unsupported HTML tags
  text = text.replace(/<\/?(?:div|span|p|table|thead|tbody|tr|td|th|font|b|i|u|strong|em|center)\b[^>]*>/gi, "");

  return text
    .replace(/\r\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function stripThinkBlocks(value) {
  const input = String(value ?? "");
  const tagPattern = /<\s*(\/?)\s*think\b[^>]*>/gi;

  let result = "";
  let cursor = 0;
  let depth = 0;
  let match;

  while ((match = tagPattern.exec(input)) !== null) {
    if (depth === 0) {
      result += input.slice(cursor, match.index);
    }

    if (match[1] === "/") {
      if (depth > 0) depth -= 1;
    } else {
      depth += 1;
    }

    cursor = tagPattern.lastIndex;
  }

  if (depth === 0) {
    result += input.slice(cursor);
  }

  return sanitizeDiscordMarkdown(result);
}

module.exports = {
  convertMarkdownTables,
  sanitizeDiscordMarkdown,
  stripThinkBlocks,
};
