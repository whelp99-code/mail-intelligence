/**
 * Multi-mailbox account registry (read-only listing + active switch).
 */

export function sanitizeAccount(account = {}) {
  return {
    id: String(account.id || ''),
    email: account.email ? String(account.email) : undefined,
    displayName: account.displayName ? String(account.displayName) : undefined,
    authMode: account.authMode ? String(account.authMode) : undefined,
    mailboxUser: account.mailboxUser ? String(account.mailboxUser) : undefined,
    connected: Boolean(account.refreshToken || account.accessToken),
    provider: account.provider ? String(account.provider) : 'microsoft'
  };
}

export function listAccountsFromStore(store = {}) {
  const accounts = Array.isArray(store.accounts) ? store.accounts.map(sanitizeAccount) : [];
  const activeAccountId = store.activeAccountId ? String(store.activeAccountId) : accounts[0]?.id;
  return {
    activeAccountId,
    accounts: accounts.map((account) => ({
      ...account,
      isActive: account.id === activeAccountId
    }))
  };
}

export function findAccountById(store = {}, accountId = '') {
  const accounts = Array.isArray(store.accounts) ? store.accounts : [];
  return accounts.find((account) => String(account.id) === String(accountId)) || null;
}

export function applyAccountToRuntimeConfig(account = {}) {
  return {
    mailboxUser: account.mailboxUser || account.email || '',
    tenantId: account.tenantId || '',
    clientId: account.clientId || '',
    clientSecret: account.clientSecret || '',
    accessToken: account.accessToken || '',
    refreshToken: account.refreshToken || '',
    loginTenant: account.loginTenant || 'common',
    expiresAt: account.expiresAt || 0
  };
}
