// Single source of truth for the global route prefix — read by both
// main.ts (app.setGlobalPrefix) and the service-scope middleware
// (which has to strip the same prefix from req.path before matching).
// Previously only main.ts had this as a literal string; duplicating it
// there risked the two silently drifting apart.
export const GLOBAL_PREFIX = 'api/v1';
