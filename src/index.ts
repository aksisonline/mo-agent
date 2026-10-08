import { routeRequest } from "./routes/api";

export default { fetch: routeRequest } satisfies ExportedHandler<Env>;

export { MoQuota } from "./quota-worker";
