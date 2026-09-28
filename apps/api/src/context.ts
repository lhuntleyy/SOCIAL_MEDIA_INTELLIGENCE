import type { AccessClaims } from "./auth/jwt";

export type AppEnv = {
  Variables: {
    requestId: string;
    auth: AccessClaims;
  };
};
