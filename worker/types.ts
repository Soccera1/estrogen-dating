export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  APP_ORIGIN: string;
  HRTID_ISSUER: string;
  HRTID_CLIENT_ID: string;
  HRTID_CLIENT_SECRET?: string;
}
export interface Profile {
  id: string;
  account_id: string;
  kind: "human" | "ai";
  name: string;
  pronouns: string;
  bio: string;
  interests: string;
  prompt: string;
  discoverable: number;
  onboarded: number;
  preference: string;
  avatar_version: number;
}
export interface Principal {
  account: string;
  profile?: string;
  csrf?: string;
  sessionHash?: string;
}
export type App = {
  Bindings: Env;
  Variables: { principal: Principal; profile: Profile };
};
