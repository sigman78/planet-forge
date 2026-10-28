// Minimal ambient declarations for the Node-only CLI (the project has no @types/node).
// Shorthand module declarations type every import from these modules as `any`.
declare module 'node:fs';
declare module 'node:zlib';
declare module 'node:path';
