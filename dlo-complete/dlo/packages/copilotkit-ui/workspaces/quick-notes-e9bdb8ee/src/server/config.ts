export interface AppConfig {
  databaseUrl: string | null;
}

export function getConfig(): AppConfig {
  return {
    databaseUrl: process.env.DATABASE_URL ?? null,
  };
}
