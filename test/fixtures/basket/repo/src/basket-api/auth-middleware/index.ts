// Every entry point authenticates through here; nothing else talks to the identity provider.

export interface TokenInfo {
  active: boolean;
  subject?: string;
  expiresAt?: Date;
}

export interface IdentityProvider {
  introspect(token: string): Promise<TokenInfo>;
}

export interface AuthPorts {
  identityProvider: IdentityProvider;
  // Injected so tests can expire a session without waiting.
  now: () => Date;
}

export class Unauthorised extends Error {
  constructor(message: string) {
    super(message);
    this.name = "Unauthorised";
  }
}

// Returns the signed-in shopper's ID for a `Bearer <token>` header.
export async function authenticate(ports: AuthPorts, authorization: string | undefined): Promise<string> {
  const token = /^Bearer (\S+)$/.exec(authorization ?? "")?.[1];
  if (token === undefined) throw new Unauthorised("Sign in first");
  const { active, subject, expiresAt } = await ports.identityProvider.introspect(token);
  if (!active || subject === undefined) throw new Unauthorised("Unknown token");
  if (expiresAt !== undefined && expiresAt <= ports.now()) throw new Unauthorised("Session expired; sign in again");
  return subject;
}
