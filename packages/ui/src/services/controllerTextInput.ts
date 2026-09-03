import { invoke } from '@tauri-apps/api/core';

/**
 * Controller / remote text input coordination.
 *
 * Search boxes across the app (VOD, Stremio, Nuvio, …) are wrapped in
 * KeyboardSearchInput, which turns "select" into a controller-friendly typing
 * surface instead of the native desktop input:
 *  - physical controller  → the on-screen keyboard,
 *  - phone remote select  → a query box shown on the phone remote page itself.
 */

/** Broadcast a JSON payload to all connected phone remotes. */
export function broadcastToRemote(data: Record<string, any>): void {
  invoke('remote_ws_broadcast', { payload: JSON.stringify(data) }).catch(() => {});
}

/**
 * Whether the most recent spatial-nav action came from the phone remote (as
 * opposed to a physical controller). Set by useGamepad before dispatching.
 */
export function isRemoteNavSource(): boolean {
  return (window as any).__ynotvLastNavSource === 'remote';
}

/** Set the source of the last spatial-nav action ('remote' | 'controller'). */
export function setNavSource(source: 'remote' | 'controller'): void {
  (window as any).__ynotvLastNavSource = source;
}

export interface TextField {
  id: string;
  /** Short label shown on the phone remote prompt (e.g. "Search Movies"). */
  label: string;
  getValue: () => string;
  setValue: (value: string) => void;
  /** Mimic pressing Enter on the host search box (commit the search). */
  commit: (value?: string) => void;
}

const textFields = new Map<string, TextField>();

/** Register a text field for phone-remote routing; returns an unregister fn. */
export function registerTextField(field: TextField): () => void {
  textFields.set(field.id, field);
  return () => {
    if (textFields.get(field.id) === field) textFields.delete(field.id);
  };
}

export function getTextField(id: string): TextField | undefined {
  return textFields.get(id);
}
