import deletion from '../../lib/ebay/account-deletion.js';
import deletionStore from '../../lib/ebay/account-deletion-store.js';
import stores from '../../lib/ebay/store.js';

// Public only for eBay's challenge and signed notifications. The staff-facing
// Trading API keeps its existing login and CSRF checks, unchanged.
export function createAccountDeletionHandler({store, env = process.env, fetchImpl = fetch, logger = console.info} = {}) {
  return deletion.createDeletionHandler({
    env,
    verifySignature: deletion.createEbaySignatureVerifier({env, fetchImpl}),
    processDeletion: identity => deletionStore.deleteAccountData(store || stores.productionStore(), identity),
    logger
  });
}
export default createAccountDeletionHandler();
export const config = {path: '/api/ebay-account-deletion'};
