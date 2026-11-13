// Gmail read-only scan. The access token lives only for one scan and is revoked right after.
const AUTH = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN = 'https://oauth2.googleapis.com/token';
const REVOKE = 'https://oauth2.googleapis.com/revoke';
const API = 'https://gmail.googleapis.com/gmail/v1/users/me';
const QUERY = 'newer_than:13m -category:promotions -category:social {receipt invoice subscription renewal renews "payment received" "your plan" membership billed charged}';
const MAX_MESSAGES = 400;

export function authUrl({ clientId, redirectUri, state }) {
  const q = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: 'https://www.googleapis.com/auth/gmail.readonly',
    access_type: 'online',
    prompt: 'select_account',
    state,
  });
  return `${AUTH}?${q}`;
}

async function google(url, init) {
  const res = await fetch(url, init);
  if (!res.ok) throw new Error(`Google ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

const entities = { amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", nbsp: ' ' };
const decode = (s) => s.replace(/&(amp|lt|gt|quot|#39|nbsp);/g, (_, e) => entities[e]);

export async function scan({ code, clientId, clientSecret, redirectUri }) {
  const { access_token: token } = await google(TOKEN, {
    method: 'POST',
    body: new URLSearchParams({ code, client_id: clientId, client_secret: clientSecret, redirect_uri: redirectUri, grant_type: 'authorization_code' }),
  });
  const auth = { headers: { authorization: `Bearer ${token}` } };
  try {
    const ids = [];
    for (let page; ids.length < MAX_MESSAGES; ) {
      const q = new URLSearchParams({ q: QUERY, maxResults: '100', ...(page && { pageToken: page }) });
      const list = await google(`${API}/messages?${q}`, auth);
      ids.push(...(list.messages || []).map((m) => m.id));
      if (!(page = list.nextPageToken)) break;
    }
    const messages = [];
    // shortcut: uses Gmail's ~200-char snippet, not the full body; parse MIME bodies if amounts are missed.
    for (let i = 0; i < ids.length; i += 20) {
      const batch = await Promise.all(ids.slice(i, i + 20).map((id) =>
        google(`${API}/messages/${id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject`, auth)));
      for (const m of batch) {
        const header = (name) => m.payload?.headers?.find((h) => h.name === name)?.value || '';
        messages.push({ from: header('From'), subject: header('Subject'), date: new Date(Number(m.internalDate)).toISOString().slice(0, 10), snippet: decode(m.snippet || '') });
      }
    }
    return messages;
  } finally {
    fetch(`${REVOKE}?token=${encodeURIComponent(token)}`, { method: 'POST' }).catch(() => {});
  }
}
