// The basket API's routes. Framework-free: the web server hands each request to `handle()`.
import { authenticate, Unauthorised, type AuthPorts } from "../auth-middleware/index.js";
import {
  addItem,
  BasketError,
  clearBasket,
  getBasket,
  removeItem,
  setQuantity,
  type ServicePorts,
} from "../basket-service/index.js";
import { restoreSession, type RestorePorts } from "../session-restore/index.js";

export type Ports = AuthPorts & ServicePorts & RestorePorts;

export interface ApiRequest {
  method: string;
  path: string;
  headers: { authorization?: string };
  body?: unknown;
}

export interface ApiResponse {
  status: number;
  body?: unknown;
}

export async function handle(ports: Ports, request: ApiRequest): Promise<ApiResponse> {
  try {
    const { method, path, headers } = request;
    if (method === "POST" && path === "/session/restore") {
      return { status: 200, body: await restoreSession(ports, headers.authorization) };
    }
    const shopperId = await authenticate(ports, headers.authorization);
    const body = (request.body ?? {}) as { sku?: string; quantity?: number };
    if (path === "/basket" && method === "GET") return { status: 200, body: await getBasket(ports, shopperId) };
    if (path === "/basket" && method === "DELETE") {
      await clearBasket(ports, shopperId);
      return { status: 204 };
    }
    if (path === "/basket/items" && method === "POST") {
      await addItem(ports, shopperId, String(body.sku), body.quantity ?? 1);
      return { status: 204 };
    }
    const sku = /^\/basket\/items\/([^/]+)$/.exec(path)?.[1];
    if (sku !== undefined && method === "PATCH") {
      await setQuantity(ports, shopperId, decodeURIComponent(sku), Number(body.quantity));
      return { status: 204 };
    }
    if (sku !== undefined && method === "DELETE") {
      await removeItem(ports, shopperId, decodeURIComponent(sku));
      return { status: 204 };
    }
    return { status: 404, body: { error: `No route for ${method} ${path}` } };
  } catch (error) {
    if (error instanceof Unauthorised) return { status: 401, body: { error: error.message } };
    if (error instanceof BasketError) return { status: error.status, body: { error: error.message } };
    throw error;
  }
}
