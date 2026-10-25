// Hands a shopper back their saved basket when they sign in again after their session expired. The new sign-in
// goes through the auth middleware like every other request, never straight to the identity provider.
import { authenticate, type AuthPorts } from "../auth-middleware/index.js";
import { loadBasket, type RepositoryPorts, type SavedBasket } from "../basket-repository/index.js";

export type RestorePorts = AuthPorts & RepositoryPorts;

export async function restoreSession(ports: RestorePorts, authorization: string | undefined): Promise<SavedBasket> {
  const shopperId = await authenticate(ports, authorization);
  return loadBasket(ports, shopperId);
}
