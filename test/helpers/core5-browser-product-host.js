// Test-only launcher. Serves the actual product, never the former Review stub.
import { startIsolatedProductServer } from './core5-isolated-product-server.js';
const product = await startIsolatedProductServer({
  operatorKey: 'core5-synthetic-local-operator-' + 'x'.repeat(32),
  botKey: 'core5-synthetic-local-bot-' + 'y'.repeat(32),
});
let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  await product.close();
  process.exit(0);
}
process.once('SIGTERM', close);
process.once('SIGINT', close);
setTimeout(close, 180000).unref();
console.log(JSON.stringify({ scope: 'isolated actual Mail product; no real accounts or sends', url: product.base, autoStopSeconds: 180 }));
