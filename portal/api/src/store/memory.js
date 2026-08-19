// In-memory storage driver — preview mode only (AUTH_DISABLED=true).
//
// Exists so the portal can run with no database at all. It holds just enough
// conversation state for multi-turn chat, because the model needs the earlier
// turns replayed to it and that history has to live somewhere. It is per-process
// and bounded, and everything in it is lost on restart.
//
// There are no accounts in preview mode — one shared anonymous session is served
// instead — so the user operations refuse rather than pretend.

import crypto from 'crypto';

const CONVERSATION_LIMIT = 60;
const MESSAGE_LIMIT = 200;

const noAccounts = () => {
  throw new Error('Accounts need a database. Preview mode serves one shared anonymous session.');
};

export function createMemoryStore() {
  const conversations = new Map();
  const messages = new Map();

  return {
    driver: 'memory',
    describe: () => 'in-memory (preview mode — nothing is persisted)',
    async initSchema() { /* nothing to create */ },
    async close() { conversations.clear(); messages.clear(); },

    // ---- users ----
    async countUsers() { return 0; },
    async findUserByEmail() { return null; },
    async findUserById() { return null; },
    async touchLastLogin() { /* no account to stamp */ },
    async updateUserKey() { noAccounts(); },
    async createUser() { noAccounts(); },

    // ---- conversations ----
    async listConversations(userId) {
      return [...conversations.values()]
        .filter(c => c.user_id === userId)
        .sort((a, b) => b.updated_at.localeCompare(a.updated_at))
        .map(({ user_id, ...row }) => row);
    },
    async getConversation(id, userId) {
      const found = conversations.get(id);
      return found && found.user_id === userId ? found : null;
    },
    async createConversation({ id, userId, title, mode }) {
      const now = new Date().toISOString();
      conversations.set(id, { id, user_id: userId, title, mode, created_at: now, updated_at: now });
      messages.set(id, []);
      // Insertion order puts the oldest at the front, so that is what to drop.
      while (conversations.size > CONVERSATION_LIMIT) {
        const oldest = conversations.keys().next().value;
        conversations.delete(oldest);
        messages.delete(oldest);
      }
    },
    async touchConversation(id, mode) {
      const found = conversations.get(id);
      if (!found) return;
      if (mode) found.mode = mode;
      found.updated_at = new Date().toISOString();
    },
    async deleteConversation(id, userId) {
      if (conversations.get(id)?.user_id !== userId) return;
      conversations.delete(id);
      messages.delete(id);
    },

    // ---- messages ----
    async getMessages(conversationId, limit) {
      const list = messages.get(conversationId) || [];
      return limit ? list.slice(-limit) : [...list];
    },
    async addMessage({ conversationId, role, content }) {
      const list = messages.get(conversationId);
      if (!list) return null;
      const id = crypto.randomUUID();
      list.push({ id, role, content, created_at: new Date().toISOString() });
      if (list.length > MESSAGE_LIMIT) list.splice(0, list.length - MESSAGE_LIMIT);
      return id;
    },
    async deleteMessage(id) {
      for (const [conversationId, list] of messages) {
        const at = list.findIndex(m => m.id === id);
        if (at !== -1) { list.splice(at, 1); messages.set(conversationId, list); return; }
      }
    }
  };
}
