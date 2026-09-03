const { aiConfig } = require("../config/ai");

const SPEAKER_TYPES = Object.freeze({
  USER: "user",
  ASSISTANT: "assistant",
});

function cleanConversationContent(content) {
  return String(content || "")
    .replace(/\s+/g, " ")
    .trim();
}

function resolvePixyUserId({ message, channel } = {}) {
  return String(
    message?.client?.user?.id ||
    message?.guild?.members?.me?.id ||
    channel?.client?.user?.id ||
    ""
  ).trim() || null;
}

function classifyConversationMessage(messageItem, pixyUserId) {
  if (!messageItem || messageItem.webhookId) return null;

  if (messageItem.author?.bot) {
    if (!pixyUserId || String(messageItem.author?.id || "") !== String(pixyUserId)) {
      return null;
    }

    // Ticket controls, opening panels, and other interactive Pixy UI are not
    // assistant conversation turns and should not consume dialogue memory.
    if (Number(messageItem.components?.length || 0) > 0) return null;
    return SPEAKER_TYPES.ASSISTANT;
  }

  return SPEAKER_TYPES.USER;
}

function getCreatedTimestamp(messageItem) {
  const value = Number(messageItem?.createdTimestamp || 0);
  return Number.isFinite(value) ? value : 0;
}

function selectRecentConversationMessages(messages, options = {}) {
  const totalLimit = Math.max(
    1,
    Math.floor(Number(options.totalLimit ?? aiConfig.recentMessagesLimit) || 20)
  );
  const preferredPerSpeaker = Math.max(
    1,
    Math.floor(
      Number(
        options.preferredPerSpeaker ?? aiConfig.recentMessagesPreferredPerSpeaker
      ) || 10
    )
  );
  const perMessageMaxChars = Math.max(
    1,
    Math.floor(Number(options.perMessageMaxChars ?? aiConfig.recentMessageMaxChars) || 500)
  );
  const totalMaxChars = Math.max(
    perMessageMaxChars,
    Math.floor(Number(options.totalMaxChars ?? aiConfig.recentMessagesMaxChars) || 8000)
  );

  const newestFirst = [...(messages || [])]
    .filter((item) => item?.speakerType && cleanConversationContent(item.content))
    .sort((a, b) => b.createdTimestamp - a.createdTimestamp);

  const selected = [];
  const selectedIndexes = new Set();
  const speakerCounts = {
    [SPEAKER_TYPES.USER]: 0,
    [SPEAKER_TYPES.ASSISTANT]: 0,
  };

  // First pass keeps a healthy mix of both sides when both are available.
  newestFirst.forEach((item, index) => {
    if (selected.length >= totalLimit) return;
    if (speakerCounts[item.speakerType] >= preferredPerSpeaker) return;
    selected.push(item);
    selectedIndexes.add(index);
    speakerCounts[item.speakerType] += 1;
  });

  // The preferred split is intentionally soft. If one side has fewer turns,
  // fill the remaining memory with useful turns from the other side.
  newestFirst.forEach((item, index) => {
    if (selected.length >= totalLimit || selectedIndexes.has(index)) return;
    selected.push(item);
    selectedIndexes.add(index);
  });

  const budgetedNewestFirst = [];
  let remainingChars = totalMaxChars;

  for (const item of selected.sort((a, b) => b.createdTimestamp - a.createdTimestamp)) {
    if (remainingChars <= 0) break;
    const content = cleanConversationContent(item.content);
    if (!content) continue;

    const allowedChars = Math.min(perMessageMaxChars, remainingChars);
    const boundedContent = content.slice(0, allowedChars).trim();
    if (!boundedContent) continue;

    budgetedNewestFirst.push({
      speakerType: item.speakerType,
      authorName: item.authorName,
      content: boundedContent,
      createdTimestamp: item.createdTimestamp,
    });
    remainingChars -= boundedContent.length;
  }

  return budgetedNewestFirst
    .sort((a, b) => a.createdTimestamp - b.createdTimestamp)
    .map(({ createdTimestamp, ...item }) => item);
}

async function getRecentChannelMessages(
  channel,
  currentMessageId,
  options = {}
) {
  try {
    const pixyUserId = String(
      options.pixyUserId || resolvePixyUserId({ channel }) || ""
    ).trim() || null;
    const fetchLimit = Math.max(
      1,
      Math.min(
        100,
        Math.floor(Number(options.fetchLimit ?? aiConfig.recentMessagesFetchLimit) || 60)
      )
    );

    const fetched = await channel.messages.fetch({ limit: fetchLimit });
    const candidates = Array.from(fetched.values())
      .filter((messageItem) => messageItem.id !== currentMessageId)
      .map((messageItem) => {
        const speakerType = classifyConversationMessage(messageItem, pixyUserId);
        const content = cleanConversationContent(messageItem.content);
        if (!speakerType || !content) return null;

        return {
          speakerType,
          authorName:
            messageItem.member?.displayName ||
            messageItem.author?.username ||
            (speakerType === SPEAKER_TYPES.ASSISTANT ? "Pixy AI" : "User"),
          content,
          createdTimestamp: getCreatedTimestamp(messageItem),
        };
      })
      .filter(Boolean);

    return selectRecentConversationMessages(candidates, options);
  } catch (error) {
    console.error("Failed to fetch recent ticket messages:", error);
    return [];
  }
}

function formatRecentConversation(recentMessages = []) {
  if (!recentMessages.length) return "No recent messages available.";

  return recentMessages
    .map((messageItem) => {
      const content = cleanConversationContent(messageItem.content);
      if (messageItem.speakerType === SPEAKER_TYPES.ASSISTANT) {
        return `Pixy AI: ${content}`;
      }

      const author = cleanConversationContent(messageItem.authorName) || "Unknown user";
      return `User (${author}): ${content}`;
    })
    .join("\n");
}

module.exports = {
  SPEAKER_TYPES,
  classifyConversationMessage,
  cleanConversationContent,
  formatRecentConversation,
  getRecentChannelMessages,
  resolvePixyUserId,
  selectRecentConversationMessages,
};
