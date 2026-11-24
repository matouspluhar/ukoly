// Přístup k OneDrivu přes Microsoft Graph, přihlášení MSAL.js (SPA, veřejný klient).
import { CONFIG } from '../config.js';

const GRAPH = 'https://graph.microsoft.com/v1.0';
const SCOPES = ['Files.ReadWrite'];

export class GraphError extends Error {
  constructor(status, msg) { super(msg || `Graph ${status}`); this.status = status; }
}
export class OfflineError extends Error { constructor(e) { super('offline'); this.cause = e; } }
export class AuthError extends Error { constructor(e) { super('auth'); this.cause = e; } }

const encPath = (p) => p.split('/').map(encodeURIComponent).join('/');
const toItem = (j) => ({
  id: j.id,
  name: j.name,
  eTag: j.eTag,
  parentId: j.parentReference?.id,
  downloadUrl: j['@microsoft.graph.downloadUrl'],
  isFile: !!j.file,
});

export function appBaseUrl() { return new URL('./', location.href).href; }

export function createGraphBackend() {
  const msal = window.msal;
  let pca = null;
  let account = null;
  const folderIds = {};

  async function token() {
    if (!account) throw new AuthError();
    try {
      const r = await pca.acquireTokenSilent({ scopes: SCOPES, account });
      return r.accessToken;
    } catch (e) {
      if (e instanceof msal.InteractionRequiredAuthError) throw new AuthError(e);
      if (!navigator.onLine || /network|fetch/i.test(String(e?.errorCode || e?.message))) throw new OfflineError(e);
      throw new AuthError(e);
    }
  }

  async function req(method, url, { body, headers = {} } = {}) {
    const t = await token();
    let res;
    try {
      res = await fetch(url.startsWith('http') ? url : GRAPH + url, {
        method, body, headers: { Authorization: 'Bearer ' + t, ...headers },
      });
    } catch (e) { throw new OfflineError(e); }
    if (res.status === 401) throw new AuthError();
    if (!res.ok) throw new GraphError(res.status, await res.text().catch(() => ''));
    return res;
  }

  async function folderId(path) {
    if (!folderIds[path]) {
      const r = await req('GET', `/me/drive/root:/${encPath(path)}?$select=id`);
      folderIds[path] = (await r.json()).id;
    }
    return folderIds[path];
  }

  return {
    demo: false,

    async init() {
      pca = new msal.PublicClientApplication({
        auth: {
          clientId: CONFIG.clientId,
          authority: `https://login.microsoftonline.com/${CONFIG.tenantId}`,
          redirectUri: appBaseUrl(),
          navigateToLoginRequestUrl: false,
        },
        cache: { cacheLocation: 'localStorage' },
      });
      await pca.initialize();
      try {
        const res = await pca.handleRedirectPromise();
        if (res?.account) account = res.account;
      } catch (e) { console.warn('redirect', e); }
      account = account || pca.getAllAccounts()[0] || null;
      if (account) pca.setActiveAccount(account);
      return !!account;
    },

    signedIn: () => !!account,
    userName: () => account?.username || '',
    login: () => pca.loginRedirect({ scopes: SCOPES, prompt: 'select_account' }),
    reauth: () => pca.acquireTokenRedirect({ scopes: SCOPES, account }),
    logout: () => pca.logoutRedirect({ account, postLogoutRedirectUri: appBaseUrl() }),

    folderId: () => folderId(CONFIG.folder),

    async list() {
      const items = [];
      let url = `/me/drive/root:/${encPath(CONFIG.folder)}:/children?$top=200`;
      while (url) {
        const j = await (await req('GET', url)).json();
        for (const it of j.value) if (it.file && it.name.toLowerCase().endsWith('.md')) items.push(toItem(it));
        url = j['@odata.nextLink'] || null;
      }
      return items;
    },

    async getItem(id) {
      return toItem(await (await req('GET', `/me/drive/items/${id}`)).json());
    },

    async getText(item) {
      if (item.downloadUrl) {
        try {
          const r = await fetch(item.downloadUrl);
          if (r.ok) return await r.text();
        } catch (e) { if (!navigator.onLine) throw new OfflineError(e); }
      }
      return (await req('GET', `/me/drive/items/${item.id}/content`)).text();
    },

    async put(id, text, eTag) {
      const r = await req('PUT', `/me/drive/items/${id}/content`, {
        body: text, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'If-Match': eTag },
      });
      return toItem(await r.json());
    },

    async create(name, text) {
      const path = `${CONFIG.folder}/${name}`;
      const r = await req('PUT', `/me/drive/root:/${encPath(path)}:/content?@microsoft.graph.conflictBehavior=fail`, {
        body: text, headers: { 'Content-Type': 'text/plain; charset=utf-8' },
      });
      return toItem(await r.json());
    },

    async moveToDone(id, eTag, newName) {
      const body = { parentReference: { id: await folderId(CONFIG.doneFolder) } };
      if (newName) body.name = newName;
      const r = await req('PATCH', `/me/drive/items/${id}?@microsoft.graph.conflictBehavior=fail`, {
        body: JSON.stringify(body), headers: { 'Content-Type': 'application/json', 'If-Match': eTag },
      });
      return toItem(await r.json());
    },
  };
}
