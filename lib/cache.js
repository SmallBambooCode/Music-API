'use strict';

const store = new Map();

function now() {
  return Date.now();
}

function get(key) {
  const item = store.get(key);
  if (!item) return null;
  if (item.expiresAt <= now()) {
    store.delete(key);
    return null;
  }
  return item.value;
}

function set(key, value, ttlSeconds) {
  const ttl = Number(ttlSeconds || 0);
  if (!ttl || ttl <= 0) return value;
  store.set(key, { value, expiresAt: now() + ttl * 1000 });
  return value;
}

function wrap(key, ttlSeconds, fn) {
  const hit = get(key);
  if (hit) return Promise.resolve(hit);
  return Promise.resolve(fn()).then((value) => set(key, value, ttlSeconds));
}

module.exports = { get, set, wrap };
