import { api } from "runtime/api";

// The name that deploy gives the api Worker in Cloudflare. `wrangler tail`
// takes it.
export const apiScriptName = api.scriptName;
