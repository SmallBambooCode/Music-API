'use strict';

const store = new Map();

function now() { return Date.now(); }

function get(key) {
  const item = store.get(key);
  if (!item) return undefined;
  if (item.expiresAt && item.expiresAt < now()) {
    store.delete(key);
    return undefined;
  }
  return item.value;
}

function set(key, value, ttlSeconds) {
  const ttl = Number(ttlSeconds || 0);
  if (!ttl) return value;
  store.set(key, { value, expiresAt: now() + ttl * 1000 });
  return value;
}

async function wrap(key, ttlSeconds, fn) {
  const cached = get(key);
  if (cached !== undefined) return cached;
  const value = await fn();
  return set(key, value, ttlSeconds);
}

module.exports = { get, set, wrap };
