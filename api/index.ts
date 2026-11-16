import { handle } from '../server/router.js';

// Single Vercel Function for the whole API; vercel.json rewrites /api/* here.
export default {
  fetch: handle,
};
