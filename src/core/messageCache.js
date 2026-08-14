// Centralized resolution of decrypted plaintext from the local secure cache.
//
// A cached record may be keyed by EITHER the real server message id OR a
// fallback id (the sidebar preview historically wrote Date.now() when the
// conversation list omitted last_id), and a record may have been written under
// the peer's numeric id and/or the username. Every reader must therefore match
// by id first, then by normalized ciphertext, across both namespaces. Keeping
// that logic in one place stops the three call sites (ChatView,
// syncActiveConversation and the conversation-list preview) from drifting apart.

// Load every cached record across the given namespace keys and index them both
// by message id and by normalized ciphertext. Errors for an individual key are
// ignored so one corrupt namespace never aborts the whole conversation.
export async function loadCacheMap(cryptoEngine, keys) {
  const byId = new Map();
  const byCipher = new Map();
  const unique = [...new Set((keys || []).filter(Boolean))];
  for (const key of unique) {
    let records;
    try {
      records = await cryptoEngine.secureLoadMessages(key);
    } catch (_) {
      continue;
    }
    for (const record of records || []) {
      if (!record || record.plaintext === undefined) continue;
      if (record.id !== undefined) byId.set(String(record.id), record);
      if (record.cipher) byCipher.set(cryptoEngine.unwrapEnvelope(record.cipher), record);
    }
  }
  return { byId, byCipher };
}

// Resolve the plaintext for a message: match by id first, then by normalized
// ciphertext. The stored cipher is re-normalized and compared so an EDITED
// message (same id, new body) is never shown as stale text. Returns the
// plaintext string, or null when nothing matches.
export function resolveCachedPlaintext(cache, msgId, cipherNorm, normalize) {
  if (!cache) return null;
  const norm = normalize || ((cipher) => cipher);
  const record = (msgId !== undefined && msgId !== null ? cache.byId.get(String(msgId)) : undefined)
    || (cipherNorm ? cache.byCipher.get(cipherNorm) : undefined);
  if (record && record.plaintext !== undefined
      && (record.cipher === undefined || norm(record.cipher) === cipherNorm)) {
    return record.plaintext;
  }
  return null;
}
