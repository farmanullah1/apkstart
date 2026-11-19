'use strict';
/**
 * Backend Registry
 *
 * Exclusively provides the builtin Google Android Emulator runtime.
 */

const { Backend, CAPS } = require('./base');
const { BuiltinBackend } = require('./builtin');

const REGISTRY = [
  BuiltinBackend,
];

/** Sole backend identifier. */
const ONLY = 'builtin';

function byId(id) {
  return REGISTRY.find((B) => B.id === id) || null;
}

/** Serialized description list for UI consumption */
function describe() {
  return REGISTRY.map((B) => ({
    id: B.id,
    label: B.label,
    summary: B.summary,
    embedCapable: B.embedCapable,
  }));
}

/**
 * Instantiates the backend based on settings (always returns builtin).
 * @param {object} o { appRoot, settings, runtime, store, log, id }
 * @returns {{ backend: Backend, Cls: Function, id: string }}
 */
function create({ appRoot, runtime, store, log, id: forced } = {}) {
  // Enforces builtin backend regardless of legacy config values
  const id = forced && byId(forced) ? forced : ONLY;
  const Cls = byId(id) || BuiltinBackend;
  const backend = new Cls(appRoot, { runtime, store, log });
  return { backend, Cls, id: Cls.id };
}

/**
 * Auto-selects active backend (always builtin).
 */
async function autoPick() {
  return { id: ONLY, reason: 'builtin-only' };
}

module.exports = {
  REGISTRY, ONLY, CAPS, byId, describe, create, autoPick, Backend,
};
