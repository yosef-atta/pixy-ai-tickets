const {
  WORKSPACE_AGENT_MODEL,
  WORKSPACE_AGENT_PROVIDER_ID,
  generateWorkspaceAgentReply,
  parseWorkspaceAgentCredential,
} = require("../workspaceAgentBridge");

const WORKSPACE_AGENT_CREDENTIAL_TYPE = "workspace-agent-connection";

function validateWorkspaceAgentConnection(credential) {
  const connection = parseWorkspaceAgentCredential(credential);
  return {
    valid: true,
    triggerId: connection.triggerId,
  };
}

function createWorkspaceAgentProvider(options = {}) {
  return Object.freeze({
    id: WORKSPACE_AGENT_PROVIDER_ID,
    displayName: "ChatGPT Workspace Agent (Beta)",
    defaultModel: WORKSPACE_AGENT_MODEL,
    requiresCredential: true,
    credentialType: WORKSPACE_AGENT_CREDENTIAL_TYPE,
    credentialLabel: "Workspace Agent connection",
    credentialPlaceholder: "Configured with access token + agtch_ trigger ID",
    supportsModelSelection: false,
    deliveryMode: "mcp_callback",

    async validateCredential(credential) {
      return validateWorkspaceAgentConnection(credential);
    },

    async generateReply(args = {}) {
      return generateWorkspaceAgentReply({
        ...args,
        ...(options.client ? { client: options.client } : {}),
        ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
        ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
      });
    },
  });
}

const workspaceAgentProvider = createWorkspaceAgentProvider();

module.exports = {
  WORKSPACE_AGENT_CREDENTIAL_TYPE,
  createWorkspaceAgentProvider,
  validateWorkspaceAgentConnection,
  workspaceAgentProvider,
};
