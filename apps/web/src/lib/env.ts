/** Client-safe environment configuration. */
export const env = {
  apiUrl: process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:8000',
  webUrl: process.env.NEXT_PUBLIC_WEB_URL ?? 'http://localhost:3000',
  appName: 'Signara',
};