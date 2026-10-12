interface EdgeEnvironment {
  APP_UPSTREAM: string;
  PRIVY_AUTH_ORIGIN?: string;
  CHATGPTEE_PROXY_SECRET?: string;
  BRAND_ASSETS: { fetch(request: Request): Promise<Response> };
}
declare const worker: {
  fetch(request: Request, env: EdgeEnvironment): Promise<Response>;
};
export default worker;
